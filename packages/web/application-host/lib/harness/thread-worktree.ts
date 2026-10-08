import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { terminateManagedProcess, type ManagedSpawn } from "../process/types.js";
import type { HarnessWorktreeSettings, ThreadDiffStats, ThreadSpaceMeasurement, ThreadWorktree } from "@varin/protocol";
import type { WorktreeBootstrapState } from "../git/types.js";
import { assertAbsolutePathInWorkspace } from "../workspace/path-safety.js";
import { mergeText3Way } from "./working-state/three-way-merge.js";
import type { ShellInterpreter } from "./shell-supervisor.js";
import { gitIndexModes } from "./working-state/git-index-mode.js";
import { copyFilePreferReflink } from "../workspace/reflink.js";
import { assertManagedWorktreeOwnership } from "./worktree-ownership.js";
import {
  isNotGitRepositoryError,
  isUnbornHeadError,
  parseGitNullList,
  parseGitStageList,
  workdirContentIdentities,
  type BaselineInventory,
} from "./working-state/workspace-baseline.js";

const executionGitRef = (worktree: ThreadWorktree): string => (
  worktree.base === "zero-commit"
    ? worktree.base
    : (worktree.executionBaseline ?? worktree.base)
);

export interface ThreadWorktreeCreateResult {
  path: string;
  managedRoot?: string;
}

export interface ThreadWorktreeRuntimeOptions {
  createWorktree(
    directory: string,
    input: Record<string, unknown>,
  ): Promise<ThreadWorktreeCreateResult>;
  createScratch?(sourceRoot: string, threadId: string): Promise<ThreadWorktreeCreateResult>;
  getWorktreeBootstrapStatus(directory: string): Promise<WorktreeBootstrapState>;
  gitBinary?: string;
  env?: NodeJS.ProcessEnv;
  /** Production injects the kernel process service; standalone tests may inject a local child. */
  spawnProcess?: ManagedSpawn;
  fsPromises?: Pick<typeof fs.promises, "chmod" | "copyFile" | "lstat" | "mkdir" | "readdir" | "readFile" | "readlink" | "realpath" | "rename" | "rm" | "stat" | "symlink" | "unlink" | "writeFile">;
  pathModule?: typeof path;
  runGit?: (cwd: string, args: string[], input?: Buffer | string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; stdoutBuffer?: Buffer }>;
  interpreter?: ShellInterpreter | undefined;
  /** Host/backend authority used to revalidate persisted roots after restart. */
  authorizeManagedRoot?: (managedRoot: string) => boolean | Promise<boolean>;
  /** Production R3 resource backend for destructive managed-directory removal. */
  removeManagedPath?: (input: {
    workspaceId: string;
    managedRoot: string;
    path: string;
    operationId: string;
  }) => Promise<void>;
}

export interface PrepareThreadWorktreeInput {
  mode: "none" | "shared" | "isolated";
  /** Isolated scratch cwd without copying parent bytes (D-212). */
  viewMode?: "virtual" | "materialized";
  sourceRoot: string;
  threadId: string;
  signal?: AbortSignal;
  /** Persist ownership as soon as the backend reveals a path, then persist readiness after bootstrap/copy finishes. */
  onWorktreeState?(worktree: ThreadWorktree): Promise<void>;
}

export interface PreparedThreadWorktree {
  cwd: string;
  worktree: ThreadWorktree | null;
}

/** Selects the retained published snapshot or the current materialized worktree for inspection. */
export type ThreadWorktreeInspectMode = "fixed" | "live";

export interface MergeThreadWorktreeResult {
  merged: number;
  conflicts: string[];
  conflictState: "none" | "markers" | "parent-unchanged";
  changedFiles: string[];
  diffStats: ThreadDiffStats;
  appliedPaths?: string[];
  status?: "applied" | "conflict" | "compensated" | "needs-attention";
  resultRevision?: number;
  operationId?: string;
}

interface SetupFailure extends Error {
  exitReason: "setup-failed";
  output?: string;
}

const asSetupFailure = (error: Error, output?: string): SetupFailure => Object.assign(error, {
  exitReason: "setup-failed" as const,
  ...(output === undefined ? {} : { output }),
});

const abortError = (): DOMException => new DOMException("Thread worktree preparation aborted", "AbortError");

const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(abortError());
  }, { once: true });
});

const parseNullList = (value: string): string[] => value.split("\0").filter(Boolean);

const normalizeRelative = (value: string, pathModule: typeof path): string => {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Git path: ${value}`);
  }
  const resolved = pathModule.normalize(normalized);
  if (pathModule.isAbsolute(resolved)) throw new Error(`Unsafe Git path: ${value}`);
  return resolved;
};

const parseNumstat = (value: string): ThreadDiffStats => {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    files += 1;
    if (added !== "-") insertions += Number.parseInt(added ?? "0", 10) || 0;
    if (removed !== "-") deletions += Number.parseInt(removed ?? "0", 10) || 0;
  }
  return { files, insertions, deletions };
};

const defaultRunGit = (
  gitBinary: string,
  env: NodeJS.ProcessEnv,
) => (cwd: string, args: string[], input?: Buffer | string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; stdoutBuffer: Buffer }> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = spawn(gitBinary, args, {
    cwd,
    env,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    signal,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  let failure: Error | undefined;
  child.once("error", (error) => { failure = error; });
  child.stdin?.on("error", (error) => { failure ??= error; });
  child.once("close", (code) => {
    // Cleanup may reclaim the prepared directory once this promise settles.
    // Wait for process exit even when abort emits an earlier error event.
    if (signal?.aborted) { reject(signal.reason); return; }
    if (failure) { reject(failure); return; }
    const stdoutBuffer = Buffer.concat(stdout);
    const result = {
      stdout: stdoutBuffer.toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdoutBuffer,
    };
    if (code === 0) resolve(result);
    else reject(new Error(result.stderr.trim() || `git ${args[0] ?? "command"} exited ${String(code)}`));
  });
  if (input !== undefined) child.stdin?.end(input);
});

interface GitTreeEntry {
  mode: string;
  type: string;
  objectHash: string;
  path: string;
}

const parseLsTree = (output: string): GitTreeEntry[] => {
  const entries: GitTreeEntry[] = [];
  const tokens = output.split("\0").filter(Boolean);
  for (const token of tokens) {
    const tabIndex = token.indexOf("\t");
    if (tabIndex === -1) continue;
    const meta = token.slice(0, tabIndex).trim().split(/\s+/);
    const entryPath = token.slice(tabIndex + 1);
    const [mode, type, objectHash] = meta;
    if (mode && type && objectHash) {
      entries.push({
        mode,
        type,
        objectHash,
        path: entryPath,
      });
    }
  }
  return entries;
};

export function createThreadWorktreeRuntime(options: ThreadWorktreeRuntimeOptions) {
  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;
  const runGit = options.runGit ?? defaultRunGit(options.gitBinary ?? "git", options.env ?? process.env);
  const preparedManagedRoots = new Set<string>();
  const managedRootKey = (value: string): string => normalizeComparePath(value);
  const authorizeManagedRoot = async (managedRoot: string): Promise<boolean> => (
    preparedManagedRoots.has(managedRootKey(managedRoot))
    || Boolean(await options.authorizeManagedRoot?.(managedRoot))
  );
  const registerManagedRoot = (managedRoot: string): void => {
    preparedManagedRoots.add(managedRootKey(managedRoot));
  };
  const assertOwnership = (
    worktree: ThreadWorktree,
    operation: string,
    candidates: readonly string[] = [],
  ): Promise<void> => assertManagedWorktreeOwnership(worktree, operation, candidates, {
    fsPromises,
    pathModule,
    authorizeManagedRoot,
  });
  const fixedCopyResultPath = (worktree: ThreadWorktree): string | undefined => (
    worktree.resultPath ?? (worktree.resultCommit ? `${worktree.path}.snapshot` : undefined)
  );
  const pathExists = async (value: string): Promise<boolean> => {
    try {
      await fsPromises.lstat(value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };

  const waitUntilReady = async (directory: string, signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const state = await options.getWorktreeBootstrapStatus(directory);
      if (state.status === "ready") return;
      if (state.status === "failed") throw new Error(state.error || "Thread worktree setup failed");
      await wait(100, signal);
    }
  };

  const copyUntracked = async (
    sourceRoot: string,
    destinationRoot: string,
    relativePaths: string[],
  ): Promise<void> => {
    for (const relativeValue of relativePaths) {
      const relative = normalizeRelative(relativeValue, pathModule);
      const source = pathModule.resolve(sourceRoot, relative);
      const destination = pathModule.resolve(destinationRoot, relative);
      await assertAbsolutePathInWorkspace(source, { root: sourceRoot, fsPromises, pathModule });
      await assertAbsolutePathInWorkspace(destination, { root: destinationRoot, fsPromises, pathModule, allowMissing: true });
      const info = await fsPromises.lstat(source);
      await fsPromises.mkdir(pathModule.dirname(destination), { recursive: true });
      if (info.isSymbolicLink()) {
        await fsPromises.symlink(await fsPromises.readlink(source), destination);
      } else if (info.isFile()) {
        await copyFilePreferReflink(source, destination, fsPromises);
        await fsPromises.chmod(destination, info.mode & 0o7777);
      }
    }
  };

  const copyDirRecursive = async (src: string, dst: string): Promise<void> => {
    const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
    const entries = await readdirFn(src, { withFileTypes: true });
    await fsPromises.mkdir(dst, { recursive: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".varin") continue;
      const s = pathModule.join(src, entry.name);
      const d = pathModule.join(dst, entry.name);
      if (entry.isSymbolicLink()) {
        await fsPromises.rm(d, { recursive: true, force: true }).catch(() => undefined);
        await fsPromises.symlink(await fsPromises.readlink(s), d);
      } else if (entry.isDirectory()) {
        await copyDirRecursive(s, d);
      } else if (entry.isFile()) {
        await copyFilePreferReflink(s, d, fsPromises);
        const mode = (await fsPromises.lstat(s)).mode & 0o7777;
        await fsPromises.chmod(d, mode);
      }
    }
  };

  const listAllFilesRelative = async (dir: string, prefix = ""): Promise<string[]> => {
    const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
    const entries = await readdirFn(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".varin") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = pathModule.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await listAllFilesRelative(full, rel);
        result.push(...nested);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(rel);
      }
    }
    return result;
  };

  const diffDirectories = async (
    baseDir: string,
    targetDir: string,
  ): Promise<{ added: string[]; changed: string[]; removed: string[]; diffStats: ThreadDiffStats }> => {
    const [baseFiles, targetFiles] = await Promise.all([
      listAllFilesRelative(baseDir),
      listAllFilesRelative(targetDir),
    ]);
    const baseSet = new Set(baseFiles);
    const targetSet = new Set(targetFiles);
    const added = targetFiles.filter((f) => !baseSet.has(f));
    const removed = baseFiles.filter((f) => !targetSet.has(f));
    const changed: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const f of targetFiles) {
      if (!baseSet.has(f)) {
        try {
          const text = await fsPromises.readFile(pathModule.join(targetDir, f), "utf8");
          insertions += text.split(/\r?\n/).length;
        } catch {
          insertions += 1;
        }
      } else {
        try {
          const basePath = pathModule.join(baseDir, f);
          const targetPath = pathModule.join(targetDir, f);
          const [baseInfo, targetInfo] = await Promise.all([fsPromises.lstat(basePath), fsPromises.lstat(targetPath)]);
          const sameType = baseInfo.isFile() === targetInfo.isFile()
            && baseInfo.isSymbolicLink() === targetInfo.isSymbolicLink();
          const sameMode = (baseInfo.mode & 0o7777) === (targetInfo.mode & 0o7777);
          let sameContent = false;
          let baseBytes = Buffer.alloc(0);
          let targetBytes = Buffer.alloc(0);
          if (sameType && baseInfo.isSymbolicLink()) {
            const [baseTarget, targetTarget] = await Promise.all([
              fsPromises.readlink(basePath),
              fsPromises.readlink(targetPath),
            ]);
            sameContent = baseTarget === targetTarget;
          } else if (sameType && baseInfo.isFile()) {
            [baseBytes, targetBytes] = await Promise.all([
              fsPromises.readFile(basePath),
              fsPromises.readFile(targetPath),
            ]);
            sameContent = baseBytes.equals(targetBytes);
          }
          if (!sameType || !sameMode || !sameContent) {
            changed.push(f);
            const baseText = baseBytes.toString("utf8");
            const targetText = targetBytes.toString("utf8");
            const baseLines = baseText.split(/\r?\n/);
            const targetLines = targetText.split(/\r?\n/);
            insertions += Math.max(0, targetLines.length - baseLines.length);
            deletions += Math.max(0, baseLines.length - targetLines.length);
            if (insertions === 0 && deletions === 0) {
              insertions += 1;
              deletions += 1;
            }
          }
        } catch {
          changed.push(f);
        }
      }
    }
    for (const f of removed) {
      try {
        const text = await fsPromises.readFile(pathModule.join(baseDir, f), "utf8");
        deletions += text.split(/\r?\n/).length;
      } catch {
        deletions += 1;
      }
    }
    const totalFiles = added.length + changed.length + removed.length;
    return {
      added,
      changed,
      removed,
      diffStats: { files: totalFiles, insertions, deletions },
    };
  };

  const estimatePrepare = async (sourceRoot: string): Promise<ThreadSpaceMeasurement> => {
    const logicalFromPaths = async (paths: string[]): Promise<ThreadSpaceMeasurement> => {
      let logical = 0;
      let unknown = false;
      for (const value of paths) {
        try {
          const absolute = pathModule.resolve(sourceRoot, normalizeRelative(value, pathModule));
          const stat = await fsPromises.lstat(absolute);
          logical += stat.size;
        } catch {
          unknown = true;
        }
      }
      return { logicalBytes: unknown ? null : logical, allocatedBytes: null, unknown };
    };
    try {
      await Promise.all([
        runGit(sourceRoot, ["rev-parse", "HEAD"]),
        runGit(sourceRoot, ["diff", "--binary", "HEAD"]),
        runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      const { stdout } = await runGit(sourceRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      return logicalFromPaths(parseNullList(stdout));
    } catch {
      let logical = 0;
      let unknown = false;
      const scan = async (directory: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
          const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
          entries = await readdirFn(directory, { withFileTypes: true });
        } catch {
          unknown = true;
          return;
        }
        for (const entry of entries) {
          if (entry.name === ".git" || entry.name === ".varin") continue;
          const full = pathModule.join(directory, entry.name);
          if (entry.isDirectory()) await scan(full);
          else {
            try { logical += (await fsPromises.lstat(full)).size; } catch { unknown = true; }
          }
        }
      };
      await scan(sourceRoot);
      return { logicalBytes: unknown ? null : logical, allocatedBytes: null, unknown };
    }
  };

  const prepareVirtual = async (
    sourceRoot: string,
    threadId: string,
    signal: AbortSignal | undefined,
    onWorktreeState: PrepareThreadWorktreeInput["onWorktreeState"],
  ): Promise<PreparedThreadWorktree> => {
    signal?.throwIfAborted();
    const allocated = options.createScratch
      ? await options.createScratch(sourceRoot, threadId)
      : {
          managedRoot: pathModule.resolve(sourceRoot, ".varin", "worktrees"),
          path: pathModule.resolve(sourceRoot, ".varin", "worktrees", threadId),
        };
    if (!allocated.managedRoot) throw new Error("Scratch backend did not return its managed ownership root");
    const managedRoot = allocated.managedRoot;
    const targetDir = allocated.path;
    await fsPromises.mkdir(managedRoot, { recursive: true });
    await fsPromises.mkdir(targetDir, { recursive: true });
    registerManagedRoot(managedRoot);
    let base = "zero-commit";
    try {
      const head = (await runGit(sourceRoot, ["rev-parse", "HEAD"], undefined, signal)).stdout.trim();
      if (head) base = head;
    } catch {
      base = "zero-commit";
    }
    const worktree: ThreadWorktree = {
      path: targetDir,
      managedRoot,
      base,
      branch: `varin/${threadId}`,
      materialized: false,
      preparationStage: "ready",
      viewMode: "virtual",
    };
    await onWorktreeState?.(worktree);
    if (signal?.aborted) throw abortError();
    return { cwd: targetDir, worktree };
  };

  const prepare = async ({ mode, sourceRoot, threadId, signal, onWorktreeState, viewMode }: PrepareThreadWorktreeInput): Promise<PreparedThreadWorktree> => {
    if (mode === "none" || mode === "shared") return { cwd: sourceRoot, worktree: null };
    if (viewMode === "virtual") return prepareVirtual(sourceRoot, threadId, signal, onWorktreeState);

    let isGit = true;
    let parentHead = "";
    let patch = "";
    let untrackedOutput = "";

    try {
      const [baseRes, patchRes, untrackedRes] = await Promise.all([
        runGit(sourceRoot, ["rev-parse", "HEAD"]),
        runGit(sourceRoot, ["diff", "--binary", "HEAD"]),
        runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      parentHead = baseRes.stdout.trim();
      patch = patchRes.stdout;
      untrackedOutput = untrackedRes.stdout;
    } catch {
      isGit = false;
    }

    if (!isGit || !parentHead) {
      // Non-git or zero-commit workspace: fallback to directory copy backend
      let targetDir: string;
      let managedRoot: string;
      try {
        const res = await options.createWorktree(sourceRoot, {
          mode: "new",
          worktreeName: threadId,
          branchName: `varin/${threadId}`,
        });
        targetDir = res.path;
        if (!res.managedRoot) throw new Error("Worktree backend did not return its managed ownership root");
        managedRoot = res.managedRoot;
        registerManagedRoot(managedRoot);
      } catch {
        managedRoot = pathModule.resolve(sourceRoot, ".varin", "worktrees");
        targetDir = pathModule.resolve(managedRoot, threadId);
        await fsPromises.mkdir(managedRoot, { recursive: true });
        await fsPromises.mkdir(targetDir, { recursive: true });
        registerManagedRoot(managedRoot);
      }

      const worktree: ThreadWorktree = {
        path: targetDir,
        managedRoot,
        base: "zero-commit",
        branch: `varin/${threadId}`,
        materialized: await pathExists(targetDir),
        preparationStage: "materializing",
        viewMode: "materialized",
      };
      await onWorktreeState?.(worktree);
      await copyDirRecursive(sourceRoot, targetDir);
      await copyDirRecursive(targetDir, `${targetDir}.baseline`);
      worktree.materialized = true;
      worktree.preparationStage = "ready";
      await onWorktreeState?.(worktree);
      if (signal?.aborted) throw abortError();
      return {
        cwd: targetDir,
        worktree,
      };
    }

    const created = await options.createWorktree(sourceRoot, {
      mode: "new",
      worktreeName: threadId,
      branchName: `varin/${threadId}`,
      startRef: parentHead,
    });
    if (!created.managedRoot) throw new Error("Worktree backend did not return its managed ownership root");
    registerManagedRoot(created.managedRoot);
    const worktree: ThreadWorktree = {
      path: created.path,
      managedRoot: created.managedRoot,
      base: parentHead,
      branch: `varin/${threadId}`,
      materialized: await pathExists(created.path),
      preparationStage: "materializing",
      viewMode: "materialized",
    };
    await onWorktreeState?.(worktree);
    await assertOwnership(worktree, "prepare worktree");
    try {
      await waitUntilReady(created.path, signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      // Worktree bootstrap is owned by the Git service and cannot be cancelled
      // by stopping this polling loop. Wait for its real terminal state so the
      // recorded directory does not outlive an abandoned prepare promise.
      await waitUntilReady(created.path);
    }
    if (patch.length > 0) await runGit(created.path, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
    const untracked = parseNullList(untrackedOutput);
    await copyUntracked(sourceRoot, created.path, untracked);
    let executionBaseline = parentHead;
    if (patch.length > 0 || untracked.length > 0) {
      await runGit(created.path, ["add", "-A"]);
      await runGit(created.path, [
        "-c", "user.name=Varin Thread Baseline",
        "-c", "user.email=thread-baseline@varin.local",
        "commit", "--no-verify", "--no-gpg-sign", "-m", "Varin thread baseline",
      ]);
      executionBaseline = (await runGit(created.path, ["rev-parse", "HEAD"])).stdout.trim();
    }
    worktree.base = parentHead;
    worktree.executionBaseline = executionBaseline;
    worktree.preparationStage = "ready";
    await onWorktreeState?.(worktree);
    if (signal?.aborted) throw abortError();
    return {
      cwd: created.path,
      worktree,
    };
  };

  const inspect = async (
    worktree: ThreadWorktree,
    mode: ThreadWorktreeInspectMode = "fixed",
  ): Promise<Pick<MergeThreadWorktreeResult, "changedFiles" | "diffStats"> & { patch: string; untracked: string[] }> => {
    await assertOwnership(worktree, `inspect ${mode} worktree`, [
      `${worktree.path}.baseline`,
      ...(fixedCopyResultPath(worktree) ? [fixedCopyResultPath(worktree)!] : []),
    ]);
    const fixed = mode === "fixed";
    if (worktree.base === "zero-commit") {
      const baselineDir = `${worktree.path}.baseline`;
      const currentDir = fixed && worktree.resultCommit
        ? fixedCopyResultPath(worktree)!
        : worktree.path;
      const diff = await diffDirectories(baselineDir, currentDir);
      return {
        patch: "",
        untracked: diff.added,
        changedFiles: [...diff.added, ...diff.changed, ...diff.removed],
        diffStats: diff.diffStats,
      };
    }

    const targetRef = fixed ? worktree.resultCommit : undefined;
    const gitBase = executionGitRef(worktree);
    let newPaths: string[];
    let trackedPatchArgs: string[];
    let changedResult: string;
    let numstatResult: string;
    let patchResult: string;

    if (targetRef) {
      // Result is fixed in resultCommit. Read diffs strictly against resultCommit.
      const [{ stdout: added }, { stdout: changed }, { stdout: numstat }] = await Promise.all([
        runGit(worktree.path, ["diff", "--name-only", "--diff-filter=A", "-z", gitBase, targetRef]),
        runGit(worktree.path, ["diff", "--name-only", "-z", gitBase, targetRef]),
        runGit(worktree.path, ["diff", "--numstat", gitBase, targetRef]),
      ]);
      newPaths = parseNullList(added);
      trackedPatchArgs = [
        "diff", "--binary", gitBase, targetRef, "--", ".",
        ...newPaths.map((relative) => `:(exclude,literal)${normalizeRelative(relative, pathModule).replace(/\\/g, "/")}`),
      ];
      patchResult = (await runGit(worktree.path, trackedPatchArgs)).stdout;
      changedResult = changed;
      numstatResult = numstat;
    } else {
      const [{ stdout: added }, { stdout: untracked }] = await Promise.all([
        runGit(worktree.path, ["diff", "--name-only", "--diff-filter=A", "-z", gitBase]),
        runGit(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      // A result snapshot commits formerly-untracked files onto the internal
      // branch. They must retain new-file preflight semantics during merge, not
      // silently become part of the tracked patch.
      newPaths = [...new Set([...parseNullList(added), ...parseNullList(untracked)])];
      trackedPatchArgs = [
        "diff", "--binary", gitBase, "--", ".",
        ...newPaths.map((relative) => `:(exclude,literal)${normalizeRelative(relative, pathModule).replace(/\\/g, "/")}`),
      ];
      const [{ stdout: patch }, { stdout: changed }, { stdout: numstat }] = await Promise.all([
        runGit(worktree.path, trackedPatchArgs),
        runGit(worktree.path, ["diff", "--name-only", "-z", gitBase]),
        runGit(worktree.path, ["diff", "--numstat", gitBase]),
      ]);
      patchResult = patch;
      changedResult = changed;
      numstatResult = numstat;
    }
    const changedFiles = [...new Set([...parseNullList(changedResult), ...newPaths])];
    const diffStats = parseNumstat(numstatResult);
    diffStats.files = changedFiles.length;
    return { patch: patchResult, untracked: newPaths, changedFiles, diffStats };
  };

  const inspectGitBaselineInventory = async (
    directory: string,
    signal?: AbortSignal,
  ): Promise<BaselineInventory> => {
    if (signal?.aborted) throw abortError();
    let inside: string;
    try {
      inside = (await runGit(directory, ["rev-parse", "--is-inside-work-tree"], undefined, signal)).stdout.trim();
    } catch (error) {
      if (isNotGitRepositoryError(error)) return { kind: "directory" };
      throw error;
    }
    if (inside !== "true") return { kind: "directory" };
    let baseRef = "zero-commit";
    let unborn = false;
    try {
      if (signal?.aborted) throw abortError();
      const head = (await runGit(directory, ["rev-parse", "HEAD"], undefined, signal)).stdout.trim();
      if (head && head !== "HEAD") baseRef = head;
    } catch (error) {
      if (!isUnbornHeadError(error)) throw error;
      unborn = true;
      baseRef = "zero-commit";
    }
    const collect = async (args: string[]): Promise<string> => {
      if (signal?.aborted) throw abortError();
      return (await runGit(directory, args, undefined, signal)).stdout;
    };
    const [tracked, deleted, untracked, unstaged, staged, stagedMeta] = await Promise.all([
      collect(["ls-files", "-z"]),
      collect(["ls-files", "-d", "-z"]),
      collect(["ls-files", "--others", "--exclude-standard", "-z"]),
      collect(["diff", "--name-only", "-z"]),
      collect(["diff", "--cached", "--name-only", "-z"]),
      collect(["ls-files", "-s", "-z"]),
    ]);
    const versusHead = unborn ? [] : parseGitNullList(await collect(["diff", "--name-only", "-z", "HEAD"]));
    const gitlinks = [...new Set(
      parseGitStageList(stagedMeta)
        .filter((entry) => entry.mode === "160000")
        .map((entry) => entry.path),
    )].sort();
    const indexModes: Record<string, string> = {};
    for (const entry of parseGitStageList(stagedMeta)) {
      if (entry.mode === "100644" || entry.mode === "100755") indexModes[entry.path] = entry.mode;
    }
    const dirtyPaths = [...new Set([
      ...parseGitNullList(deleted),
      ...parseGitNullList(untracked),
      ...parseGitNullList(unstaged),
      ...parseGitNullList(staged),
      ...versusHead,
    ])].filter((relative) => !gitlinks.includes(relative));
    const contentIdentities = await workdirContentIdentities(directory, dirtyPaths, {
      readFile: fsPromises.readFile,
      lstat: fsPromises.lstat,
      readlink: fsPromises.readlink,
      join: pathModule.join,
    }, signal);
    const rawPaths = [...new Set([...parseGitNullList(tracked), ...parseGitNullList(untracked)])].filter(file => {
      const identity = contentIdentities[file];
      return identity ? identity.startsWith("file:") : indexModes[file] === "100644" || indexModes[file] === "100755";
    }).sort();
    // One native Git process hashes raw bytes for the reusable baseline identity.
    // C-quoted UTF-8 input handles spaces, quotes and control characters without a shell.
    const quoted = (file: string) => '"' + [...Buffer.from(file)].map(byte => byte >= 32 && byte < 127 && byte !== 34 && byte !== 92
      ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`).join("") + '"';
    const rawHashes = rawPaths.length ? (await runGit(directory, ["hash-object", "--no-filters", "--stdin-paths"], rawPaths.map(quoted).join("\n") + "\n", signal)).stdout.trim().split(/\r?\n/u) : [];
    if (rawHashes.length !== rawPaths.length || rawHashes.some(hash => !/^[0-9a-f]+$/u.test(hash))) throw new Error("Git returned an incomplete raw baseline identity");
    const rawFileHashes = Object.fromEntries(rawPaths.map((file, index) => [file, rawHashes[index]!]));
    return {
      kind: "git",
      baseRef,
      unborn,
      paths: [...new Set([
        ...parseGitNullList(tracked),
        ...parseGitNullList(deleted),
        ...parseGitNullList(untracked),
        ...parseGitNullList(unstaged),
        ...parseGitNullList(staged),
        ...versusHead,
      ])].sort(),
      gitlinks,
      indexModes,
      contentIdentities,
      rawFileHashes,
    };
  };

  /** Index modes for tracked paths; empty map outside a Git work tree (D-243). */
  const inspectIndexModes = async (directory: string): Promise<Map<string, string>> => {
    try {
      const inside = (await runGit(directory, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
      if (inside !== "true") return new Map();
      return await gitIndexModes(
        (args, cwd) => runGit(cwd ?? directory, args).then((result) => ({ ...result, exitCode: 0 })),
        directory,
      );
    } catch (error) {
      if (isNotGitRepositoryError(error)) return new Map();
      throw error;
    }
  };

  const inspectWorkspaceIdentity = async (directory: string): Promise<
    | { status: "ready"; baseRef: string; changedFiles: string[] }
    | { status: "unavailable"; reason: string }
  > => {
    try {
      const [{ stdout: head }, { stdout: tracked }, { stdout: untracked }] = await Promise.all([
        runGit(directory, ["rev-parse", "HEAD"]),
        runGit(directory, ["diff", "--name-only", "-z", "HEAD", "--", "."]),
        runGit(directory, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      const baseRef = head.trim();
      if (!baseRef) return { status: "unavailable", reason: "Git HEAD is unavailable" };
      return {
        status: "ready",
        baseRef,
        changedFiles: [...new Set([...parseNullList(tracked), ...parseNullList(untracked)])].sort(),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `Git workspace identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const copySnapshotIdentity = async (directory: string): Promise<string> => {
    const files = await listAllFilesRelative(directory);
    const hash = createHash("sha256");
    for (const file of files.sort()) {
      hash.update(file);
      const target = pathModule.join(directory, file);
      const stat = await fsPromises.lstat(target);
      hash.update(String(stat.mode & 0o7777));
      if (stat.isSymbolicLink()) hash.update(await fsPromises.readlink(target));
      else hash.update(await fsPromises.readFile(target));
    }
    return hash.digest("hex").slice(0, 40);
  };

  const snapshot = async (worktree: ThreadWorktree): Promise<ThreadWorktree> => {
    const ownedPaths = [
      `${worktree.path}.results`,
      ...(fixedCopyResultPath(worktree) ? [fixedCopyResultPath(worktree)!] : []),
    ];
    await assertOwnership(worktree, "snapshot worktree", ownedPaths);
    if (worktree.base === "zero-commit") {
      const resultsRoot = `${worktree.path}.results`;
      const staging = pathModule.join(resultsRoot, `.staging-${randomUUID()}`);
      try {
        await fsPromises.mkdir(resultsRoot, { recursive: true });
        await copyDirRecursive(worktree.path, staging);
        const resultCommit = await copySnapshotIdentity(staging);
        const resultPath = pathModule.join(resultsRoot, resultCommit);
        try {
          await fsPromises.stat(resultPath);
          const existing = await diffDirectories(staging, resultPath);
          if (existing.diffStats.files > 0) {
            throw new Error(`Thread worktree snapshot is corrupt: ${resultCommit}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fsPromises.rename(staging, resultPath);
        }
        return { ...worktree, resultCommit, resultPath };
      } finally {
        await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const status = (await runGit(worktree.path, ["status", "--porcelain", "-z"])).stdout;
    if (status.length > 0) {
      await runGit(worktree.path, ["add", "-A"]);
      await runGit(worktree.path, [
        "-c", "user.name=Varin Thread Result",
        "-c", "user.email=thread-result@varin.local",
        "commit", "--no-verify", "--no-gpg-sign", "-m", "Varin thread result",
      ]);
    }
    const [commitResult, branchResult, cleanResult] = await Promise.all([
      runGit(worktree.path, ["rev-parse", "HEAD"]),
      runGit(worktree.path, ["branch", "--show-current"]),
      runGit(worktree.path, ["status", "--porcelain", "-z"]),
    ]);
    const resultCommit = commitResult.stdout.trim();
    const branch = branchResult.stdout.trim() || worktree.branch;
    if (!resultCommit) throw new Error("Unable to resolve the thread result commit");
    if (!branch) throw new Error("Thread worktree is not attached to a retained branch");
    if (cleanResult.stdout.length > 0) throw new Error("Thread worktree changed while its result was being snapshotted");
    return { ...worktree, branch, resultCommit };
  };

  const verifyFixedResult = async (worktree: ThreadWorktree): Promise<boolean> => {
    if (!worktree.resultCommit) return false;
    if (worktree.base === "zero-commit") {
      const resultPath = fixedCopyResultPath(worktree);
      return Boolean(resultPath) && await copySnapshotIdentity(resultPath!) === worktree.resultCommit;
    }
    const [head, status] = await Promise.all([
      runGit(worktree.path, ["rev-parse", "HEAD"]),
      runGit(worktree.path, ["status", "--porcelain", "-z"]),
    ]);
    return head.stdout.trim() === worktree.resultCommit && status.stdout.length === 0;
  };

  const merge = async (parentRoot: string, worktree: ThreadWorktree): Promise<MergeThreadWorktreeResult> => {
    const state = await inspect(worktree);
    const untrackedToCopy: Array<
      | { kind: "file"; source?: string; bytes?: Buffer; mode?: string; destination: string }
      | { kind: "symlink"; target: string; destination: string }
      | { kind: "delete"; destination: string }
    > = [];
    const untrackedConflicts: string[] = [];

    const resultCommit = worktree.resultCommit;
    let lsTreeMap: Map<string, GitTreeEntry> | null = null;
    if (worktree.base !== "zero-commit" && resultCommit && state.untracked.length > 0) {
      const { stdout: lsTreeOut } = await runGit(worktree.path, ["ls-tree", "-z", "-r", resultCommit]);
      const entries = parseLsTree(lsTreeOut);
      lsTreeMap = new Map(entries.map((e) => [e.path.replace(/\\/g, "/"), e]));
    }

    const filesToProcess = worktree.base === "zero-commit" ? state.changedFiles : state.untracked;
    for (const relativeValue of filesToProcess) {
      const relative = normalizeRelative(relativeValue, pathModule);
      const destination = pathModule.resolve(parentRoot, relative);
      const normalizedKey = relative.replace(/\\/g, "/");

      if (worktree.base !== "zero-commit" && resultCommit && lsTreeMap) {
        const treeEntry = lsTreeMap.get(normalizedKey);
        if (!treeEntry) {
          untrackedConflicts.push(relativeValue);
          continue;
        }
        try {
          await assertAbsolutePathInWorkspace(destination, { root: parentRoot, fsPromises, pathModule, allowMissing: true });
          const isSymlink = treeEntry.mode === "120000";
          const catRes = await runGit(worktree.path, ["cat-file", "-p", treeEntry.objectHash]);
          const sourceBytes = catRes.stdoutBuffer ?? Buffer.from(catRes.stdout, "utf8");

          try {
            const destinationInfo = await fsPromises.lstat(destination);
            if (isSymlink && destinationInfo.isSymbolicLink()) {
              const destinationTarget = await fsPromises.readlink(destination);
              const sourceTarget = sourceBytes.toString("utf8");
              if (sourceTarget !== destinationTarget) untrackedConflicts.push(relativeValue);
            } else if (!isSymlink && destinationInfo.isFile()) {
              const destinationBytes = await fsPromises.readFile(destination);
              if (!sourceBytes.equals(destinationBytes)) untrackedConflicts.push(relativeValue);
            } else {
              untrackedConflicts.push(relativeValue);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (isSymlink) {
              const target = sourceBytes.toString("utf8");
              if (pathModule.isAbsolute(target) || path.win32.isAbsolute(target)) untrackedConflicts.push(relativeValue);
              else untrackedToCopy.push({ kind: "symlink", target, destination });
            } else {
              untrackedToCopy.push({ kind: "file", bytes: sourceBytes, mode: treeEntry.mode, destination });
            }
          }
        } catch {
          untrackedConflicts.push(relativeValue);
        }
      } else {
        const sourceDir = worktree.base === "zero-commit" && resultCommit
          ? fixedCopyResultPath(worktree)!
          : worktree.path;
        const source = pathModule.resolve(sourceDir, relative);
        try {
          await assertAbsolutePathInWorkspace(source, { root: sourceDir, fsPromises, pathModule, allowMissing: true });
          await assertAbsolutePathInWorkspace(destination, { root: parentRoot, fsPromises, pathModule, allowMissing: true });
          let sourceInfo: fs.Stats | null = null;
          try {
            sourceInfo = await fsPromises.lstat(source);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }

          if (!sourceInfo) {
            // File was deleted in child
            try {
              const destinationInfo = await fsPromises.lstat(destination);
              if (destinationInfo.isFile()) {
                const [destBytes, baselineBytes] = await Promise.all([
                  fsPromises.readFile(destination),
                  fsPromises.readFile(pathModule.resolve(`${worktree.path}.baseline`, relative)).catch(() => null),
                ]);
                if (baselineBytes && destBytes.equals(baselineBytes)) {
                  untrackedToCopy.push({ kind: "delete", destination });
                } else {
                  untrackedConflicts.push(relativeValue);
                }
              } else {
                untrackedConflicts.push(relativeValue);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            continue;
          }

          try {
            const destinationInfo = await fsPromises.lstat(destination);
            if (sourceInfo.isSymbolicLink() && destinationInfo.isSymbolicLink()) {
              const [sourceTarget, destinationTarget] = await Promise.all([
                fsPromises.readlink(source),
                fsPromises.readlink(destination),
              ]);
              if (sourceTarget !== destinationTarget) untrackedConflicts.push(relativeValue);
            } else if (sourceInfo.isFile() && destinationInfo.isFile()) {
              const [sourceBytes, destinationBytes] = await Promise.all([
                fsPromises.readFile(source),
                fsPromises.readFile(destination),
              ]);
              if (!sourceBytes.equals(destinationBytes)) {
                const baselineFile = pathModule.resolve(`${worktree.path}.baseline`, relative);
                let baseText = "";
                try {
                  baseText = await fsPromises.readFile(baselineFile, "utf8");
                } catch { /* new file */ }
                const isChildText = !sourceBytes.includes(0);
                const isParentText = !destinationBytes.includes(0);
                if (isChildText && isParentText) {
                  const mergeRes = mergeText3Way(baseText, destinationBytes.toString("utf8"), sourceBytes.toString("utf8"));
                  if (mergeRes.clean) {
                    untrackedToCopy.push({ kind: "file", bytes: Buffer.from(mergeRes.text, "utf8"), destination });
                  } else {
                    untrackedToCopy.push({ kind: "file", bytes: Buffer.from(mergeRes.text, "utf8"), destination });
                    untrackedConflicts.push(relativeValue);
                  }
                } else {
                  untrackedConflicts.push(relativeValue);
                }
              }
            } else {
              untrackedConflicts.push(relativeValue);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (sourceInfo.isSymbolicLink()) {
              const target = await fsPromises.readlink(source);
              if (pathModule.isAbsolute(target) || path.win32.isAbsolute(target)) untrackedConflicts.push(relativeValue);
              else untrackedToCopy.push({ kind: "symlink", target, destination });
            } else if (sourceInfo.isFile()) {
              untrackedToCopy.push({ kind: "file", source, destination });
            } else {
              untrackedConflicts.push(relativeValue);
            }
          }
        } catch {
          // Missing/changed source, unsafe aliases, and unreadable destinations
          // all preserve the parent and surface the exact path as a conflict.
          untrackedConflicts.push(relativeValue);
        }
      }
    }
    if (untrackedConflicts.length > 0) {
      return {
        merged: 0,
        conflicts: untrackedConflicts,
        conflictState: "parent-unchanged",
        changedFiles: state.changedFiles,
        diffStats: state.diffStats,
        status: "conflict",
        appliedPaths: [],
      };
    }
    if (state.patch.length > 0) {
      try {
        // The parent working tree already contains the captured baseline while
        // its index may still point at the user's original HEAD. A plain apply
        // therefore has the correct first chance and does not stage files.
        await runGit(parentRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], state.patch);
      } catch {
        try {
          await runGit(parentRoot, ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"], state.patch);
        } catch {
          const conflicts = await runGit(parentRoot, ["diff", "--name-only", "--diff-filter=U", "-z"])
            .then(({ stdout }) => parseNullList(stdout))
            .catch(() => []);
          if (conflicts.length > 0) {
            return {
              merged: 0,
              conflicts,
              conflictState: "markers",
              changedFiles: state.changedFiles,
              diffStats: state.diffStats,
              status: "conflict",
              appliedPaths: [],
            };
          }
          return {
            merged: 0,
            conflicts: state.changedFiles,
            conflictState: "parent-unchanged",
            changedFiles: state.changedFiles,
            diffStats: state.diffStats,
            status: "conflict",
            appliedPaths: [],
          };
        }
      }
    }
    for (const entry of untrackedToCopy) {
      if (entry.kind === "delete") {
        try {
          await fsPromises.unlink(entry.destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      await fsPromises.mkdir(pathModule.dirname(entry.destination), { recursive: true });
      if (entry.kind === "symlink") {
        await fsPromises.symlink(entry.target, entry.destination);
      } else if (entry.bytes) {
        if (fsPromises.writeFile) {
          await fsPromises.writeFile(entry.destination, entry.bytes);
        } else {
          await fs.promises.writeFile(entry.destination, entry.bytes);
        }
        if (entry.mode === "100755") {
          try {
            await (fsPromises.chmod ? fsPromises.chmod(entry.destination, 0o755) : fs.promises.chmod(entry.destination, 0o755));
          } catch { /* platform ignore */ }
        }
      } else if (entry.source) {
        await copyFilePreferReflink(entry.source, entry.destination, fsPromises);
      }
    }
    return {
      merged: state.changedFiles.length,
      conflicts: [],
      conflictState: "none",
      changedFiles: state.changedFiles,
      diffStats: state.diffStats,
      status: "applied",
      appliedPaths: state.changedFiles,
    };
  };

  const gitCommonDirFor = async (worktree: ThreadWorktree): Promise<string | null> => {
    if (worktree.base === "zero-commit" || worktree.materialized === false) return null;
    try {
      const common = (await runGit(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
      return common ? pathModule.resolve(worktree.path, common) : null;
    } catch {
      return null;
    }
  };

  const pruneGitWorktreeMetadata = async (worktree: ThreadWorktree, commonGitDir: string | null): Promise<void> => {
    if (!commonGitDir) return;
    const cwd = worktree.managedRoot ?? pathModule.dirname(worktree.path);
    await runGit(cwd, ["--git-dir", commonGitDir, "worktree", "prune"]).catch(() => undefined);
  };

  const reclaim = async (
    worktree: ThreadWorktree,
    extras?: { nativeVerified?: boolean; workspaceId?: string },
  ): Promise<{ reclaimed: boolean; reason?: string }> => {
    if (worktree.materialized === false) {
      worktree.preparationStage = "materialize";
      delete worktree.materializationFingerprint;
      delete worktree.executionBaseline;
      return { reclaimed: true };
    }
    if (!worktree.resultCommit && !extras?.nativeVerified) {
      return { reclaimed: false, reason: "Thread worktree result has not been snapshotted" };
    }
    if (!extras?.nativeVerified) {
      if (worktree.base === "zero-commit") {
        const snapshotDir = fixedCopyResultPath(worktree);
        if (!snapshotDir) return { reclaimed: false, reason: "Thread worktree result path missing" };
        try {
          await fsPromises.stat(snapshotDir);
          const diff = await diffDirectories(snapshotDir, worktree.path);
          if (diff.diffStats.files > 0) {
            return { reclaimed: false, reason: "Thread worktree has uncommitted modifications" };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            reclaimed: false,
            reason: (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "Thread worktree snapshot missing"
              : `Unable to verify thread worktree snapshot: ${message}`,
          };
        }
      } else {
        try {
          const status = await runGit(worktree.path, ["status", "--porcelain", "-z"]);
          if (status.stdout.length > 0) {
            return { reclaimed: false, reason: "Thread worktree has uncommitted modifications" };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            worktree.materialized = false;
            worktree.preparationStage = "materialize";
            delete worktree.materializationFingerprint;
            delete worktree.executionBaseline;
            return { reclaimed: true };
          }
          return {
            reclaimed: false,
            reason: `Unable to verify thread worktree before reclamation: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    }
    await assertOwnership(worktree, "reclaim worktree");
    try {
      const commonGitDir = await gitCommonDirFor(worktree);
      if (options.removeManagedPath && extras?.workspaceId && worktree.managedRoot) {
        await options.removeManagedPath({
          workspaceId: extras.workspaceId,
          managedRoot: worktree.managedRoot,
          path: worktree.path,
          operationId: `thread-reclaim:${randomUUID()}`,
        });
      } else {
        const rmFn = (fsPromises as typeof fs.promises).rm ?? fs.promises.rm;
        await rmFn(worktree.path, { recursive: true, force: true });
      }
      await pruneGitWorktreeMetadata(worktree, commonGitDir);
      worktree.materialized = false;
      worktree.preparationStage = "materialize";
      delete worktree.materializationFingerprint;
      delete worktree.executionBaseline;
      return { reclaimed: true };
    } catch (error) {
      return { reclaimed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const normalizeComparePath = (value: string): string => {
    const resolved = pathModule.resolve(value);
    return process.platform === "win32" ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
  };

  const sameResolvedPath = async (left: string, right: string): Promise<boolean> => {
    try {
      const [a, b] = await Promise.all([fsPromises.realpath(left), fsPromises.realpath(right)]);
      return normalizeComparePath(a) === normalizeComparePath(b);
    } catch {
      return normalizeComparePath(left) === normalizeComparePath(right);
    }
  };

  const isInsideDirectory = async (root: string, candidate: string): Promise<boolean> => {
    let rootPath = root;
    let candidatePath = candidate;
    try { rootPath = await fsPromises.realpath(root); } catch { /* compare the unresolved path */ }
    try { candidatePath = await fsPromises.realpath(candidate); } catch { /* compare the unresolved path */ }
    const rootNorm = normalizeComparePath(rootPath);
    const candidateNorm = normalizeComparePath(candidatePath);
    if (candidateNorm === rootNorm) return false;
    const relative = pathModule.relative(rootNorm, candidateNorm);
    return relative !== "" && !relative.startsWith("..") && !pathModule.isAbsolute(relative);
  };

  const inspectSourceGit = async (sourceRoot: string): Promise<{
    isGit: boolean;
    head: string | null;
    toplevel: string | null;
  }> => {
    try {
      const inside = (await runGit(sourceRoot, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
      if (inside !== "true") return { isGit: false, head: null, toplevel: null };
      const toplevel = (await runGit(sourceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
      try {
        const head = (await runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
        return { isGit: true, head, toplevel };
      } catch {
        return { isGit: true, head: null, toplevel };
      }
    } catch {
      return { isGit: false, head: null, toplevel: null };
    }
  };

  const inheritsOtherGit = async (directory: string): Promise<boolean> => {
    try {
      const discovered = (await runGit(directory, ["rev-parse", "--show-toplevel"])).stdout.trim();
      return Boolean(discovered && !await sameResolvedPath(discovered, directory));
    } catch {
      return false;
    }
  };

  const exportGitTree = async (sourceRoot: string, ref: string, destination: string): Promise<void> => {
    await fsPromises.mkdir(destination, { recursive: true });
    const listed = await runGit(sourceRoot, ["ls-tree", "-r", "-z", ref]);
    for (const entry of parseLsTree(listed.stdout)) {
      const relative = normalizeRelative(entry.path, pathModule);
      const dest = pathModule.join(destination, ...relative.split("/"));
      await assertAbsolutePathInWorkspace(dest, { root: destination, fsPromises, pathModule, allowMissing: true });
      if (entry.type === "commit") {
        await fsPromises.mkdir(dest, { recursive: true });
        continue;
      }
      if (entry.type !== "blob") continue;
      const blob = await runGit(sourceRoot, ["cat-file", "blob", entry.objectHash]);
      const bytes = blob.stdoutBuffer;
      if (!bytes) throw new Error(`git cat-file did not return raw bytes for ${entry.objectHash}`);
      await fsPromises.mkdir(pathModule.dirname(dest), { recursive: true });
      if (entry.mode === "120000") {
        await fsPromises.symlink(bytes.toString("utf8").replace(/\n$/, ""), dest);
        continue;
      }
      await fsPromises.writeFile(dest, bytes);
      if (entry.mode === "100755") {
        await fsPromises.chmod(dest, 0o755).catch(() => undefined);
      }
    }
  };

  const initIsolatedGit = async (livePath: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) throw abortError();
    await runGit(livePath, ["init"]);
    await runGit(livePath, ["add", "-A"]);
    await runGit(livePath, [
      "-c", "user.name=Varin Thread",
      "-c", "user.email=thread@varin.local",
      "commit", "--no-verify", "--no-gpg-sign", "--allow-empty",
      "-m", "Varin isolated execution baseline",
    ]);
    const head = (await runGit(livePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (!head) throw new Error("Isolated execution Git baseline is not resolvable after git init");
    return head;
  };

  const resolveLiveHead = async (livePath: string): Promise<string> => {
    const head = (await runGit(livePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (!head || head === "HEAD") throw new Error(`Execution Git HEAD is not resolvable in ${livePath}`);
    return head;
  };

  const resolveSourceCommit = async (sourceRoot: string, ref: string | undefined): Promise<string | null> => {
    if (!ref || ref === "zero-commit") return null;
    try {
      const verified = (await runGit(sourceRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
      return verified || null;
    } catch {
      return null;
    }
  };

  const materialize = async (
    sourceRoot: string,
    worktree: ThreadWorktree,
    signal?: AbortSignal,
  ): Promise<ThreadWorktree> => {
    await assertOwnership(worktree, "materialize worktree", [
      `${worktree.path}.baseline`,
      ...(fixedCopyResultPath(worktree) ? [fixedCopyResultPath(worktree)!] : []),
    ]);
    if (worktree.materialized !== false && worktree.preparationStage !== "materializing") {
      try {
        await fsPromises.stat(worktree.path);
        return worktree;
      } catch {
        // Missing on disk, continue to materialize
      }
    } else {
      try {
        const existing = await fsPromises.stat(worktree.path);
        if (existing.isDirectory() || existing.isFile()) {
          const error = new Error(`Original thread path is occupied by other content: ${worktree.path}`);
          (error as NodeJS.ErrnoException).code = "EEXIST";
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    worktree.preparationStage = "materializing";
    if (worktree.base !== "zero-commit") {
      const source = await inspectSourceGit(sourceRoot);
      const ref = (await resolveSourceCommit(sourceRoot, worktree.resultCommit))
        ?? (await resolveSourceCommit(sourceRoot, worktree.base))
        ?? source.head;
      if (!ref) {
        throw new Error("Parent Git baseline is not resolvable for rematerialize");
      }
      const liveInsideSource = source.toplevel ? await isInsideDirectory(source.toplevel, worktree.path) : false;
      if (source.isGit && source.head && !liveInsideSource) {
        await runGit(sourceRoot, ["worktree", "prune"]).catch(() => {});
        if (signal?.aborted) throw abortError();
        await runGit(sourceRoot, ["worktree", "add", "--detach", "--force", worktree.path, ref]);
        worktree.executionBaseline = await resolveLiveHead(worktree.path);
      } else {
        if (signal?.aborted) throw abortError();
        await exportGitTree(sourceRoot, ref, worktree.path);
        worktree.executionBaseline = await initIsolatedGit(worktree.path, signal);
      }
    } else {
      const snapshotDir = fixedCopyResultPath(worktree);
      const baselineDir = `${worktree.path}.baseline`;
      let src: string;
      if (snapshotDir) {
        await fsPromises.stat(snapshotDir);
        src = snapshotDir;
      } else {
        try {
          await fsPromises.stat(baselineDir);
          src = baselineDir;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          src = sourceRoot;
        }
      }
      await copyDirRecursive(src, worktree.path);
      if (await inheritsOtherGit(worktree.path)) {
        worktree.executionBaseline = await initIsolatedGit(worktree.path, signal);
      }
    }
    worktree.materialized = true;
    worktree.preparationStage = "ready";
    delete worktree.materializationFingerprint;
    return worktree;
  };

  const prepareInputs = async (
    sourceRoot: string,
    worktree: ThreadWorktree,
    settings?: HarnessWorktreeSettings,
    signal?: AbortSignal,
  ): Promise<void> => {
    await assertOwnership(worktree, "prepare worktree inputs");
    for (const rel of settings?.copyIgnored ?? []) {
      if (signal?.aborted) throw abortError();
      const src = pathModule.resolve(sourceRoot, rel);
      const dst = pathModule.resolve(worktree.path, rel);
      await assertAbsolutePathInWorkspace(src, { root: sourceRoot, fsPromises, pathModule });
      await assertAbsolutePathInWorkspace(dst, { root: worktree.path, fsPromises, pathModule, allowMissing: true });
      const stat = await fsPromises.lstat(src);
      await fsPromises.mkdir(pathModule.dirname(dst), { recursive: true });
      if (stat.isSymbolicLink()) {
        await fsPromises.rm(dst, { recursive: true, force: true }).catch(() => undefined);
        await fsPromises.symlink(await fsPromises.readlink(src), dst);
      } else if (stat.isDirectory()) {
        await copyDirRecursive(src, dst);
      } else if (stat.isFile()) {
        await copyFilePreferReflink(src, dst, fsPromises);
        await fsPromises.chmod(dst, stat.mode & 0o7777);
      }
    }
  };

  const runSetup = async (
    _sourceRoot: string,
    worktree: ThreadWorktree,
    settings?: HarnessWorktreeSettings,
    setupSignal?: AbortSignal,
  ): Promise<{ output: string }> => {
    if (!settings?.setup) return { output: "" };
    await assertOwnership(worktree, "run worktree setup");
    if (setupSignal?.aborted) throw asSetupFailure(abortError());
    const timeoutMs = settings.setupTimeoutMs;
    const command = settings.setup;
    let shell: string;
    let args: string[];
    if (options.interpreter && "command" in options.interpreter) {
      shell = options.interpreter.command;
      args = [...options.interpreter.args.filter((a) => a !== "-"), command];
    } else {
      const isWindows = process.platform === "win32";
      shell = isWindows ? (process.env.ComSpec || "powershell.exe") : "/bin/sh";
      args = isWindows
        ? (shell.toLowerCase().endsWith("cmd.exe") ? ["/d", "/s", "/c", command] : ["-Command", command])
        : ["-c", command];
    }
    const launchProcess: ManagedSpawn = options.spawnProcess ?? spawn;
    const child = await Promise.resolve().then(() => launchProcess(shell, args, {
      cwd: worktree.path,
      env: { ...(options.env ?? process.env), ...(options.interpreter && "env" in options.interpreter ? options.interpreter.env : {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(setupSignal ? { signal: setupSignal } : {}),
    })).catch((error: unknown) => { throw asSetupFailure(error instanceof Error ? error : new Error(String(error))); });
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
      let requestedFailure: SetupFailure | null = null;
      let spawnFailure: SetupFailure | null = null;
      let settled = false;
      const settle = (failure: SetupFailure | null, code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        setupSignal?.removeEventListener("abort", onAbort);
        const output = Buffer.concat(chunks).toString("utf8");
        if (failure) { failure.output ??= output; reject(failure); }
        else if (code === 0) resolve({ output });
        else reject(asSetupFailure(new Error("Setup command failed with exit code " + code + ":\n" + output), output));
      };
      const requestTermination = (failure: SetupFailure): void => {
        requestedFailure ??= failure;
        if (timer) clearTimeout(timer);
        // Timeout requests termination. Only the native tree/close receipt
        // permits normal completion; an authority loss is a retained failure.
        void terminateManagedProcess(child, true).catch((error: unknown) => settle(asSetupFailure(new Error(
          'Setup process stop is unconfirmed; its writer remains retained: ' + (error instanceof Error ? error.message : String(error)),
        )), null));
      };
      const onAbort = (): void => requestTermination(asSetupFailure(abortError()));
      const timer = typeof timeoutMs === "number" && timeoutMs > 0 ? setTimeout(() => {
        requestTermination(asSetupFailure(new Error("Setup command timed out after " + timeoutMs + "ms")));
      }, timeoutMs) : null;
      setupSignal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (err) => {
        spawnFailure = asSetupFailure(err);
        if (child.pid === undefined) settle(spawnFailure, null);
      });
      child.once("close", (code) => settle(requestedFailure ?? spawnFailure, code));
      void child.completion?.catch((error: unknown) => settle(asSetupFailure(new Error(
        "Setup process exit is unconfirmed; native directory writer is retained: " + (error instanceof Error ? error.message : String(error)),
      )), null));
      if (setupSignal?.aborted) onAbort();
    });
  };

  const measureDiskUsage = async (worktree: ThreadWorktree): Promise<number> => {
    let totalBytes = 0;
    const scan = async (dir: string): Promise<void> => {
      const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
      const entries = await readdirFn(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const full = pathModule.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else {
          const stat = await fsPromises.lstat(full);
          totalBytes += stat.size;
        }
      }
    };
    await scan(worktree.path);
    worktree.diskBytes = totalBytes;
    return totalBytes;
  };

  const attachIsolatedGitContext = async (
    sourceRoot: string,
    worktree: ThreadWorktree,
    signal?: AbortSignal,
  ): Promise<{ kind: "worktree" | "init" | "none"; executionBaseline?: string }> => {
    if (signal?.aborted) throw abortError();
    const livePath = worktree.path;
    const baseRef = worktree.base;
    const metadataPath = `${livePath}.git-metadata-${randomUUID()}`;
    await assertOwnership(worktree, "attach isolated Git context", [metadataPath]);
    const source = await inspectSourceGit(sourceRoot);
    const liveInsideSource = source.toplevel ? await isInsideDirectory(source.toplevel, livePath) : false;
    const liveInheritsOther = await inheritsOtherGit(livePath);
    const resolvedBase = await resolveSourceCommit(sourceRoot, baseRef);
    const liveGitPath = pathModule.join(livePath, ".git");
    const existingGit = await fsPromises.lstat(liveGitPath).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (existingGit) {
      const head = await resolveLiveHead(livePath);
      const status = (await runGit(livePath, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
      if (status) throw new Error(`Existing execution Git context is dirty and cannot be adopted: ${livePath}`);
      const subject = (await runGit(livePath, ["log", "-1", "--format=%s"])).stdout.trim();
      const parents = (await runGit(livePath, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(/\s+/).slice(1);
      if (subject === "Varin execution baseline" && resolvedBase && parents.length === 1 && parents[0] === resolvedBase) {
        return { kind: "worktree", executionBaseline: head };
      }
      if (subject === "Varin isolated execution baseline" && parents.length === 0) {
        return { kind: "init", executionBaseline: head };
      }
      throw new Error(`Existing Git metadata is not a provable Varin execution baseline: ${livePath}`);
    }
    const canDetach = Boolean(!worktree.readOnlyInput && source.isGit && resolvedBase && !liveInsideSource && !liveInheritsOther);
    if (canDetach) {
      const ref = resolvedBase!;
      let adminGitDir: string | null = null;
      try {
        if (signal?.aborted) throw abortError();
        await runGit(sourceRoot, ["worktree", "prune"]).catch(() => undefined);
        // Create only Git worktree metadata in a disposable empty directory.
        // The immutable workspace body already came from the Rust materializer
        // and must never be copied back through a second TS file writer.
        await runGit(sourceRoot, ["worktree", "add", "--no-checkout", "--detach", metadataPath, ref]);
        const metadataGitFile = pathModule.join(metadataPath, ".git");
        const gitFile = (await fsPromises.readFile(metadataGitFile, "utf8")).toString();
        const match = /^gitdir:\s*(.+?)\s*$/u.exec(gitFile.trim());
        if (!match?.[1]) throw new Error("Git worktree metadata did not expose its gitdir");
        adminGitDir = pathModule.isAbsolute(match[1])
          ? match[1]
          : pathModule.resolve(metadataPath, match[1]);
        const liveGitFile = pathModule.join(livePath, ".git");
        await fsPromises.writeFile(liveGitFile, gitFile.endsWith("\n") ? gitFile : `${gitFile}\n`, "utf8");
        await fsPromises.writeFile(
          pathModule.join(adminGitDir, "gitdir"),
          `${liveGitFile.replace(/\\/g, "/")}\n`,
          "utf8",
        );
        // The no-checkout worktree starts with an empty index. Seed it from
        // the selected parent tree, then commit the already-materialized bytes
        // as this execution generation's baseline. `git add` is intentional:
        // it applies the repository's real clean/LFS/EOL filters and fails if
        // required filter configuration is unavailable, while leaving the
        // Rust-materialized working-tree bytes untouched.
        await runGit(livePath, ["read-tree", ref]);
        await runGit(livePath, ["add", "-A"]);
        await runGit(livePath, [
          "-c", "user.name=Varin Thread Baseline",
          "-c", "user.email=thread-baseline@varin.local",
          "commit", "--no-verify", "--no-gpg-sign", "--allow-empty",
          "-m", "Varin execution baseline",
        ]);
        await fsPromises.rm(metadataPath, { recursive: true, force: true });
        return { kind: "worktree", executionBaseline: await resolveLiveHead(livePath) };
      } catch (error) {
        await fsPromises.unlink(pathModule.join(livePath, ".git")).catch(() => undefined);
        if (adminGitDir) {
          await fsPromises.writeFile(
            pathModule.join(adminGitDir, "gitdir"),
            `${pathModule.join(metadataPath, ".git").replace(/\\/g, "/")}\n`,
            "utf8",
          ).catch(() => undefined);
        }
        await runGit(sourceRoot, ["worktree", "remove", "--force", metadataPath]).catch(() => undefined);
        await fsPromises.rm(metadataPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    if (source.isGit || liveInsideSource || liveInheritsOther) {
      return { kind: "init", executionBaseline: await initIsolatedGit(livePath, signal) };
    }
    return { kind: "none" };
  };

  const discardInput = async (worktree: ThreadWorktree, workspaceId?: string): Promise<void> => {
    const extras = [
      ...(worktree.materializationSwitch
        ? [worktree.materializationSwitch.stagingPath, worktree.materializationSwitch.backupPath]
        : []),
    ];
    await assertOwnership(worktree, "discard retrieval input", extras);
    if (options.removeManagedPath && workspaceId && worktree.managedRoot) {
      await options.removeManagedPath({
        workspaceId,
        managedRoot: worktree.managedRoot,
        path: worktree.path,
        operationId: `thread-discard:${randomUUID()}`,
      });
    } else {
      const rmFn = (fsPromises as typeof fs.promises).rm ?? fs.promises.rm;
      await rmFn(worktree.path, { recursive: true, force: true });
      for (const extra of extras) await rmFn(extra, { recursive: true, force: true });
    }
    worktree.materialized = false;
    worktree.viewMode = "virtual";
    worktree.preparationStage = "ready";
    delete worktree.materializationSwitch;
    delete worktree.materializationFingerprint;
    delete worktree.executionBaseline;
    delete worktree.resultCommit;
    delete worktree.resultPath;
  };

  return {
    prepare,
    estimatePrepare,
    inspect,
    inspectGitBaselineInventory,
    inspectIndexModes,
    inspectWorkspaceIdentity,
    snapshot,
    verifyFixedResult,
    merge,
    reclaim,
    materialize,
    prepareInputs,
    runSetup,
    measureDiskUsage,
    attachIsolatedGitContext,
    discardInput,
    assertOwnership,
  };
}

export type ThreadWorktreeRuntime = ReturnType<typeof createThreadWorktreeRuntime>;
