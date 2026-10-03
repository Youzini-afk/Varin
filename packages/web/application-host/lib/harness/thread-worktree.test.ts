import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { createGitTemplate } from '../git/repository.test-helper.js';
import { createThreadWorktreeRuntime } from "./thread-worktree.js";
import { canonicalizePathIdentity, normalizePathIdentity } from "../workspace/path-safety.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repositoryTemplate = createGitTemplate(repo => {
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
});
afterAll(() => repositoryTemplate.dispose());

const createRepo = (): { root: string; repo: string; worktrees: string } => {
  const root = mkdtempSync(join(tmpdir(), "thread-worktree-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  fs.mkdirSync(repo);
  fs.mkdirSync(worktrees);
  repositoryTemplate.copyTo(repo);
  return { root, repo, worktrees };
};

const runtimeFor = (worktrees: string) => createThreadWorktreeRuntime({
  authorizeManagedRoot: (candidate) => candidate.endsWith("worktrees"),
  createWorktree: async (directory, input) => {
    const target = join(worktrees, String(input.worktreeName));
    if (input.mode === "existing") {
      git(directory, ["worktree", "add", "--force", target, String(input.branchName ?? input.startRef)]);
    } else {
      git(directory, ["worktree", "add", "-b", String(input.branchName), target, String(input.startRef)]);
    }
    return { path: target, managedRoot: worktrees };
  },
  getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
});

describe("thread worktree runtime", () => {
  it("prepares a virtual isolated scratch without copying parent bytes", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    try {
      writeFileSync(join(fixture.repo, "tracked.txt"), "parent live\n");
      const prepared = await runtime.prepare({
        mode: "isolated",
        viewMode: "virtual",
        sourceRoot: fixture.repo,
        threadId: "virtual-one",
      });
      expect(prepared.worktree).toMatchObject({
        viewMode: "virtual",
        materialized: false,
        preparationStage: "ready",
      });
      expect(existsSync(join(prepared.cwd, "tracked.txt"))).toBe(false);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("parent live\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("captures the parent working state as an internal baseline and merges only child deltas", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      writeFileSync(join(fixture.repo, "tracked.txt"), "parent dirty\n");
      writeFileSync(join(fixture.repo, "parent-note.txt"), "untracked baseline\n");
      const parentIdentity = await runtime.inspectWorkspaceIdentity(fixture.repo);
      expect(parentIdentity).toMatchObject({
        status: "ready",
        baseRef: git(fixture.repo, ["rev-parse", "HEAD"]),
        changedFiles: ["parent-note.txt", "tracked.txt"],
      });
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-one" });
      childPath = prepared.cwd;
      expect(prepared.worktree).not.toBeNull();
      expect(readFileSync(join(childPath, "tracked.txt"), "utf8")).toBe("parent dirty\n");
      expect(readFileSync(join(childPath, "parent-note.txt"), "utf8")).toBe("untracked baseline\n");
      expect(git(childPath, ["status", "--porcelain"])).toBe("");

      writeFileSync(join(childPath, "tracked.txt"), "child result\n");
      writeFileSync(join(childPath, "child-note.txt"), "new child file\n");
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.branch).toBe("varin/thread-one");
      expect(snapshotted.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(git(childPath, ["status", "--porcelain"])).toBe("");
      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles.toSorted()).toEqual(["child-note.txt", "tracked.txt"]);

      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(merged.conflictState).toBe("none");
      expect(merged.merged).toBe(2);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("child result\n");
      expect(readFileSync(join(fixture.repo, "child-note.txt"), "utf8")).toBe("new child file\n");
      expect(readFileSync(join(fixture.repo, "parent-note.txt"), "utf8")).toBe("untracked baseline\n");
      expect(git(fixture.repo, ["rev-parse", `${snapshotted.branch}^{commit}`])).toBe(snapshotted.resultCommit);
      expect(existsSync(childPath)).toBe(true);
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 25_000);

  it("returns the source workspace unchanged for shared and no-worktree roles", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    try {
      await expect(runtime.prepare({ mode: "shared", sourceRoot: fixture.repo, threadId: "shared" })).resolves.toEqual({
        cwd: fixture.repo,
        worktree: null,
      });
      await expect(runtime.prepare({ mode: "none", sourceRoot: fixture.repo, threadId: "none" })).resolves.toEqual({
        cwd: fixture.repo,
        worktree: null,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports the created Git directory and drains bootstrap before cancellation completes", async () => {
    const fixture = createRepo();
    let bootstrapReady = false;
    let childPath = "";
    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (directory, input) => {
        childPath = join(fixture.worktrees, String(input.worktreeName));
        git(directory, ["worktree", "add", "-b", String(input.branchName), childPath, String(input.startRef)]);
        return { path: childPath, managedRoot: fixture.worktrees };
      },
      getWorktreeBootstrapStatus: async () => bootstrapReady
        ? { status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }
        : { status: "pending", phase: "directory-created", error: null, updatedAt: Date.now() },
    });
    const states: Array<{ path: string; preparationStage: string | undefined }> = [];
    const controller = new AbortController();
    let settled = false;
    try {
      const preparing = runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "bootstrap-cancel",
        signal: controller.signal,
        onWorktreeState: async (worktree) => {
          states.push({ path: worktree.path, preparationStage: worktree.preparationStage });
        },
      }).finally(() => { settled = true; });
      while (states.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(states[0]).toEqual({ path: childPath, preparationStage: "materializing" });

      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      bootstrapReady = true;
      await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
      expect(states.at(-1)).toEqual({ path: childPath, preparationStage: "ready" });
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("estimates only the paths the Git prepare backend will materialize", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    try {
      writeFileSync(join(fixture.repo, ".gitignore"), "node_modules/\n");
      git(fixture.repo, ["add", ".gitignore"]);
      git(fixture.repo, ["commit", "-m", "ignore dependencies"]);
      writeFileSync(join(fixture.repo, "untracked.txt"), "extra\n");
      mkdirSync(join(fixture.repo, "node_modules"));
      writeFileSync(join(fixture.repo, "node_modules", "ignored.js"), "ignored\n");

      const estimate = await runtime.estimatePrepare(fixture.repo);
      expect(estimate).toMatchObject({ unknown: false, allocatedBytes: null });
      expect(estimate.logicalBytes).toBe(
        Buffer.byteLength("base\n")
        + Buffer.byteLength("node_modules/\n")
        + Buffer.byteLength("extra\n"),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("preserves a relative child symlink without dereferencing it into the parent", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-symlink" });
      childPath = prepared.cwd;
      fs.symlinkSync("tracked.txt", join(childPath, "linked.txt"));
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged).toMatchObject({ conflicts: [], merged: 1 });
      expect(fs.lstatSync(join(fixture.repo, "linked.txt")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(join(fixture.repo, "linked.txt"))).toBe("tracked.txt");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a different parent untracked file during merge", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-conflict" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "new.txt"), "child\n");
      writeFileSync(join(fixture.repo, "new.txt"), "parent\n");
      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged.conflicts).toEqual(["new.txt"]);
      expect(merged.conflictState).toBe("parent-unchanged");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("parent\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preflights untracked conflicts before applying any tracked child changes", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-preflight" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "child tracked\n");
      writeFileSync(join(childPath, "new.txt"), "child untracked\n");
      writeFileSync(join(fixture.repo, "new.txt"), "parent untracked\n");

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged).toMatchObject({ conflicts: ["new.txt"], conflictState: "parent-unchanged", merged: 0 });
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("parent untracked\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a tracked divergence without claiming conflict markers were written", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-tracked-conflict" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "child\n");
      writeFileSync(join(fixture.repo, "tracked.txt"), "parent\n");

      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged).toMatchObject({ conflicts: ["tracked.txt"], conflictState: "parent-unchanged", merged: 0 });
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("parent\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("consumes fixed result commit and ignores post-snapshot live modifications", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-fixed-rev" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "clean child tracked\n");
      writeFileSync(join(childPath, "new.txt"), "clean child new\n");
      const binaryPayload = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
      fs.writeFileSync(join(childPath, "binary.bin"), binaryPayload);

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();
      expect(await runtime.verifyFixedResult(snapshotted)).toBe(true);

      // Post-snapshot live modifications: dirty changes, new files, binary alterations
      writeFileSync(join(childPath, "tracked.txt"), "DIRTY LIVE TRACKED\n");
      writeFileSync(join(childPath, "new.txt"), "DIRTY LIVE NEW\n");
      writeFileSync(join(childPath, "leak.txt"), "SHOULD NEVER LEAK\n");
      fs.writeFileSync(join(childPath, "binary.bin"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      expect(await runtime.verifyFixedResult(snapshotted)).toBe(false);

      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles.toSorted()).toEqual(["binary.bin", "new.txt", "tracked.txt"]);

      const liveInspected = await runtime.inspect(snapshotted, "live");
      expect(liveInspected.changedFiles.toSorted()).toEqual(["binary.bin", "leak.txt", "new.txt", "tracked.txt"]);

      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(merged.conflictState).toBe("none");
      expect(merged.merged).toBe(3);

      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("clean child tracked\n");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("clean child new\n");
      expect(fs.readFileSync(join(fixture.repo, "binary.bin"))).toEqual(binaryPayload);
      expect(existsSync(join(fixture.repo, "leak.txt"))).toBe(false);
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reclaims directory after snapshot and rematerializes at the same path", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-lifecycle",
      });
      childPath = prepared.worktree!.path;
      writeFileSync(join(childPath, "work.txt"), "some work done\n");
      git(childPath, ["add", "-A"]);
      git(childPath, ["commit", "-m", "child work"]);

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();
      expect(await runtime.verifyFixedResult(snapshotted)).toBe(true);

      // Measure disk usage
      const bytes = await runtime.measureDiskUsage(snapshotted);
      expect(bytes).toBeGreaterThan(0);
      expect(snapshotted.diskBytes).toBe(bytes);

      // Reclaim directory
      const reclaimResult = await runtime.reclaim(snapshotted);
      expect(reclaimResult.reclaimed).toBe(true);
      expect(snapshotted.materialized).toBe(false);
      expect(existsSync(childPath)).toBe(false);

      // Materialize at same path
      const materialized = await runtime.materialize(fixture.repo, snapshotted);
      expect(materialized.materialized).toBe(true);
      expect(existsSync(childPath)).toBe(true);
      expect(existsSync(join(childPath, ".git"))).toBe(true);
      expect(readFileSync(join(childPath, "work.txt"), "utf8")).toBe("some work done\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains a Git worktree when its clean state cannot be verified", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-reclaim-unverified-"));
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "result.txt"), "retained\n");
    const runtime = createThreadWorktreeRuntime({
      authorizeManagedRoot: (candidate) => candidate === root,
      createWorktree: async () => ({ path: child }),
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
      runGit: async () => { throw new Error("git status unavailable"); },
    });
    try {
      const worktree = { path: child, base: "base", resultCommit: "fixed", materialized: true };
      const reclaimed = await runtime.reclaim(worktree);
      expect(reclaimed).toMatchObject({
        reclaimed: false,
        reason: expect.stringContaining("git status unavailable"),
      });
      expect(existsSync(child)).toBe(true);
      expect(worktree.materialized).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rebuild a published copy result from a different fallback when its snapshot is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-copy-result-missing-"));
    const sourceRoot = join(root, "source");
    const child = join(root, "child");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(`${child}.baseline`, { recursive: true });
    writeFileSync(join(sourceRoot, "file.txt"), "live parent\n");
    writeFileSync(join(`${child}.baseline`, "file.txt"), "old baseline\n");
    const runtime = createThreadWorktreeRuntime({
      authorizeManagedRoot: (candidate) => candidate === root,
      createWorktree: async () => ({ path: child }),
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    try {
      await expect(runtime.materialize(sourceRoot, {
        path: child,
        managedRoot: root,
        base: "zero-commit",
        resultCommit: "missing-fixed-result",
        materialized: false,
      })).rejects.toMatchObject({ code: "ENOENT" });
      expect(existsSync(child)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to rematerialize when the original path is occupied by other content", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-path-occupied-"));
    const sourceRoot = join(root, "source");
    const child = join(root, "child");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "stranger.txt"), "someone else\n");
    const runtime = createThreadWorktreeRuntime({
      authorizeManagedRoot: (candidate) => candidate === root,
      createWorktree: async () => ({ path: child }),
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    try {
      await expect(runtime.materialize(sourceRoot, {
        path: child,
        managedRoot: root,
        base: "zero-commit",
        resultCommit: "fixed",
        materialized: false,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(join(child, "stranger.txt"), "utf8")).toBe("someone else\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs setup command and copies ignored whitelist files", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      // Create an ignored file in source repo
      writeFileSync(join(fixture.repo, ".env.local"), "SECRET_KEY=12345\n");

      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-setup",
      });
      childPath = prepared.worktree!.path;

      // Run setup with echo and copyIgnored
      const settings = {
        setup: "echo setup completed",
        copyIgnored: [".env.local"],
      };
      await runtime.prepareInputs(fixture.repo, prepared.worktree!, settings);
      const setupResult = await runtime.runSetup(fixture.repo, prepared.worktree!, settings);
      expect(setupResult.output).toMatch(/setup[\s\r\n]+completed/);
      expect(existsSync(join(childPath, ".env.local"))).toBe(true);
      expect(readFileSync(join(childPath, ".env.local"), "utf8")).toBe("SECRET_KEY=12345\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not report setup timeout until the spawned process has actually closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "setup-close-receipt-"));
    const worktreePath = join(root, "thread");
    mkdirSync(worktreePath);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.pid = 42;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killed = false;
    child.kill = () => { killed = true; return true; };
    const runtime = createThreadWorktreeRuntime({
      authorizeManagedRoot: (candidate) => candidate === root,
      createWorktree: async () => ({ path: worktreePath, managedRoot: root }),
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
      spawnProcess: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    try {
      let settled = false;
      const setup = runtime.runSetup(root, { path: worktreePath, managedRoot: root, base: "zero-commit" }, {
        setup: "long-running",
        setupTimeoutMs: 5,
      });
      void setup.finally(() => { settled = true; }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(killed).toBe(true);
      expect(settled).toBe(false);
      child.emit("close", null);
      await expect(setup).rejects.toMatchObject({ exitReason: "setup-failed", message: expect.stringContaining("timed out") });
      expect(settled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails setup cleanly when command fails with exitReason setup-failed", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-setup-fail",
      });
      childPath = prepared.worktree!.path;

      let caughtError: unknown = null;
      try {
        await runtime.runSetup(fixture.repo, prepared.worktree!, {
          setup: "exit 1",
        });
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError).toMatchObject({ exitReason: "setup-failed" });
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves non-git / zero-commit thread results across reclaim, rematerialize, and merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-root-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "original.txt"), "hello world\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "zero-commit-thread",
      });
      expect(prepared.worktree).not.toBeNull();
      expect(prepared.worktree!.base).toBe("zero-commit");

      // Child edits a file and creates a new one
      writeFileSync(join(prepared.cwd, "original.txt"), "hello from child\n");
      writeFileSync(join(prepared.cwd, "result.txt"), "new result file\n");

      // Cannot reclaim before snapshot!
      const unSnapshottedReclaim = await runtime.reclaim(prepared.worktree!);
      expect(unSnapshottedReclaim.reclaimed).toBe(false);

      // Snapshot
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();
      expect(snapshotted.resultCommit!.length).toBe(40);

      // Reclaim
      const reclaimed = await runtime.reclaim(snapshotted);
      expect(reclaimed.reclaimed).toBe(true);
      expect(existsSync(prepared.cwd)).toBe(false);

      // Rematerialize
      const rematerialized = await runtime.materialize(sourceRoot, snapshotted);
      expect(rematerialized.materialized).toBe(true);
      expect(existsSync(prepared.cwd)).toBe(true);
      expect(readFileSync(join(prepared.cwd, "result.txt"), "utf8")).toBe("new result file\n");
      expect(readFileSync(join(prepared.cwd, "original.txt"), "utf8")).toBe("hello from child\n");

      // Merge into parent
      const merged = await runtime.merge(sourceRoot, rematerialized);
      expect(merged.conflicts).toEqual([]);
      expect(merged.merged).toBe(2);
      expect(readFileSync(join(sourceRoot, "result.txt"), "utf8")).toBe("new result file\n");
      expect(readFileSync(join(sourceRoot, "original.txt"), "utf8")).toBe("hello from child\n");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("zero-commit snapshot ignores post-snapshot live modifications during inspect and merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-fixed-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "file.txt"), "initial\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "fixed-rev-thread",
      });

      // Child edits file
      writeFileSync(join(prepared.cwd, "file.txt"), "published\n");

      // Snapshot to freeze result
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();
      expect(await runtime.verifyFixedResult(snapshotted)).toBe(true);

      // Child makes a later live modification (not snapshotted)
      writeFileSync(join(prepared.cwd, "file.txt"), "later-live\n");
      writeFileSync(join(prepared.cwd, "later-file.txt"), "later live file\n");
      expect(await runtime.verifyFixedResult(snapshotted)).toBe(true);

      // Inspect should see "published", not "later-live"
      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles).toEqual(["file.txt"]);

      const liveInspected = await runtime.inspect(snapshotted, "live");
      expect(liveInspected.changedFiles.toSorted()).toEqual(["file.txt", "later-file.txt"]);

      const legacySnapshot = { ...snapshotted };
      fs.cpSync(snapshotted.resultPath!, `${prepared.cwd}.snapshot`, { recursive: true });
      delete legacySnapshot.resultPath;
      expect((await runtime.inspect(legacySnapshot)).changedFiles).toEqual(["file.txt"]);

      // Merge should apply "published", NOT "later-live"
      const merged = await runtime.merge(sourceRoot, legacySnapshot);
      expect(merged.conflicts).toEqual([]);
      expect(readFileSync(join(sourceRoot, "file.txt"), "utf8")).toBe("published\n");

      rmSync(prepared.cwd, { recursive: true, force: true });
      legacySnapshot.materialized = false;
      await runtime.materialize(sourceRoot, legacySnapshot);
      expect(readFileSync(join(prepared.cwd, "file.txt"), "utf8")).toBe("published\n");
      expect(existsSync(join(prepared.cwd, "later-file.txt"))).toBe(false);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("zero-commit snapshot cleanly deletes removed files in parent without residue", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-delete-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "keep.txt"), "keep me\n");
    writeFileSync(join(sourceRoot, "delete-me.txt"), "delete me\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "delete-thread",
      });

      // First snapshot with all files
      let snapshotted = await runtime.snapshot(prepared.worktree!);
      const firstResultPath = snapshotted.resultPath!;

      // Now child deletes delete-me.txt
      unlinkSync(join(prepared.cwd, "delete-me.txt"));

      // Second snapshot captures the deletion
      snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultPath).not.toBe(firstResultPath);
      expect(readFileSync(join(firstResultPath, "delete-me.txt"), "utf8")).toBe("delete me\n");

      // Reclaim should succeed (snapshot matches live cwd, no uncommitted modifications)
      const reclaimed = await runtime.reclaim(snapshotted);
      expect(reclaimed.reclaimed).toBe(true);

      // Merge into parent
      const merged = await runtime.merge(sourceRoot, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(existsSync(join(sourceRoot, "keep.txt"))).toBe(true);
      expect(existsSync(join(sourceRoot, "delete-me.txt"))).toBe(false);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("keeps the previous immutable copy result when a later snapshot fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-snapshot-failure-"));
    const sourceRoot = join(root, "project");
    const worktreeRoot = join(root, "worktrees");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "file.txt"), "base\n");
    const createWorktree = async (_dir: string, input: Record<string, unknown>) => {
      const target = join(worktreeRoot, String(input.worktreeName));
      mkdirSync(target, { recursive: true });
      return { path: target, managedRoot: worktreeRoot };
    };
    const bootstrap = async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() } as const);
    try {
      const runtime = createThreadWorktreeRuntime({ createWorktree, getWorktreeBootstrapStatus: bootstrap });
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot, threadId: "failure" });
      writeFileSync(join(prepared.cwd, "file.txt"), "first\n");
      const first = await runtime.snapshot(prepared.worktree!);
      const failedRuntime = createThreadWorktreeRuntime({
        authorizeManagedRoot: (candidate) => candidate === worktreeRoot,
        createWorktree,
        getWorktreeBootstrapStatus: bootstrap,
        fsPromises: new Proxy(fs.promises, {
          get(target, property, receiver) {
            if (property === "copyFile") return async () => { throw new Error("injected snapshot failure"); };
            return Reflect.get(target, property, receiver);
          },
        }),
      });
      writeFileSync(join(prepared.cwd, "file.txt"), "second\n");
      await expect(failedRuntime.snapshot(first)).rejects.toThrow("injected snapshot failure");
      expect(readFileSync(join(first.resultPath!, "file.txt"), "utf8")).toBe("first\n");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may retain the injected-failure staging path briefly. */ }
    }
  });

  it("inits an independent Git repo when the live path sits inside the parent worktree", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    const live = join(fixture.repo, ".varin", "worktrees", "isolated-child");
    const parentHead = git(fixture.repo, ["rev-parse", "HEAD"]);
    const parentBranches = git(fixture.repo, ["branch"]);
    try {
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "child-only.txt"), "from working state\n");
      const attached = await runtime.attachIsolatedGitContext(fixture.repo, {
        path: live,
        managedRoot: join(fixture.repo, ".varin", "worktrees"),
        base: parentHead,
      });
      expect(attached.kind).toBe("init");
      expect(attached.executionBaseline).toMatch(/^[0-9a-f]{40}$/);
      expect(attached.executionBaseline).not.toBe(parentHead);
      const retried = await runtime.attachIsolatedGitContext(fixture.repo, {
        path: live, managedRoot: join(fixture.repo, ".varin", "worktrees"), base: parentHead,
      });
      expect(retried).toEqual(attached);
      const inspected = await runtime.inspect({
        path: live,
        managedRoot: join(fixture.repo, ".varin", "worktrees"),
        base: parentHead,
        executionBaseline: attached.executionBaseline!,
        viewMode: "materialized",
        materialized: true,
      }, "live");
      expect(inspected.changedFiles).not.toContain(undefined);
      git(live, ["rev-parse", "--verify", attached.executionBaseline!]);
      const childTop = normalizePathIdentity(await canonicalizePathIdentity(git(live, ["rev-parse", "--show-toplevel"])));
      expect(childTop).toBe(normalizePathIdentity(await canonicalizePathIdentity(live)));
      expect(childTop).not.toBe(normalizePathIdentity(await canonicalizePathIdentity(fixture.repo)));
      const parentStatus = git(fixture.repo, ["status", "--porcelain"]);
      git(live, ["status", "--porcelain"]);
      git(live, ["reset", "--hard"]);
      writeFileSync(join(live, "child-only.txt"), "child commit\n");
      git(live, ["add", "child-only.txt"]);
      git(live, ["-c", "user.name=Child", "-c", "user.email=child@example.com", "commit", "--no-verify", "--no-gpg-sign", "-m", "child only"]);
      expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(parentHead);
      expect(git(fixture.repo, ["status", "--porcelain"])).toBe(parentStatus);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(git(fixture.repo, ["branch"])).toBe(parentBranches);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses destructive worktree operations when the persisted path escapes its managed root", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    try {
      const beforeHead = git(fixture.repo, ["rev-parse", "HEAD"]);
      const beforeStatus = git(fixture.repo, ["status", "--porcelain"]);
      await expect(runtime.reclaim({
        path: fixture.repo,
        managedRoot: fixture.root,
        base: beforeHead,
        materialized: true,
      }, { nativeVerified: true })).rejects.toThrow("managed ownership root is not registered");
      const corrupt = {
        path: fixture.repo,
        managedRoot: fixture.root,
        base: beforeHead,
        materialized: true,
      };
      await expect(runtime.inspect(corrupt, "live")).rejects.toThrow("managed ownership root is not registered");
      await expect(runtime.merge(fixture.repo, corrupt)).rejects.toThrow("managed ownership root is not registered");
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(git(fixture.repo, ["status", "--porcelain"])).toBe(beforeStatus);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses a detached Git worktree when the live path is outside the parent worktree", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    const live = join(fixture.worktrees, "external-live");
    const parentHead = git(fixture.repo, ["rev-parse", "HEAD"]);
    const parentStatus = git(fixture.repo, ["status", "--porcelain"]);
    const parentBranches = git(fixture.repo, ["branch"]);
    try {
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "child-only.txt"), "from working state\n");
      const worktree = {
        path: live,
        managedRoot: fixture.worktrees,
        base: parentHead,
        materialized: true,
      };
      const attached = await runtime.attachIsolatedGitContext(fixture.repo, worktree);
      expect(attached.kind).toBe("worktree");
      expect(attached.executionBaseline).toMatch(/^[0-9a-f]{40}$/);
      const childTop = normalizePathIdentity(await canonicalizePathIdentity(git(live, ["rev-parse", "--show-toplevel"])));
      expect(childTop).toBe(normalizePathIdentity(await canonicalizePathIdentity(live)));
      expect(childTop).not.toBe(normalizePathIdentity(await canonicalizePathIdentity(fixture.repo)));
      git(live, ["status", "--porcelain"]);
      git(live, ["reset", "--hard"]);
      writeFileSync(join(live, "child-only.txt"), "child commit\n");
      git(live, ["add", "child-only.txt"]);
      git(live, ["-c", "user.name=Child", "-c", "user.email=child@example.com", "commit", "--no-verify", "--no-gpg-sign", "-m", "child only"]);
      expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(parentHead);
      expect(git(fixture.repo, ["status", "--porcelain"])).toBe(parentStatus);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(git(fixture.repo, ["branch"])).toBe(parentBranches);
      expect(existsSync(join(fixture.repo, ".git", "worktrees"))).toBe(true);
      const liveIdentity = normalizePathIdentity(await canonicalizePathIdentity(live));
      const reclaimed = await runtime.reclaim(worktree, { nativeVerified: true });
      expect(reclaimed.reclaimed).toBe(true);
      const remainingWorktrees = await Promise.all(git(fixture.repo, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalizePathIdentity(line.slice("worktree ".length))));
      expect(remainingWorktrees.map((entry) => normalizePathIdentity(entry))).not.toContain(liveIdentity);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails materialized Git baseline attachment when a required clean filter cannot run", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    const live = join(fixture.worktrees, "required-filter-live");
    try {
      writeFileSync(join(fixture.repo, ".gitattributes"), "filtered.txt filter=varin-required\n");
      writeFileSync(join(fixture.repo, "filtered.txt"), "base bytes\n");
      git(fixture.repo, ["add", ".gitattributes", "filtered.txt"]);
      git(fixture.repo, ["commit", "-m", "filter fixture"]);
      git(fixture.repo, ["config", "filter.varin-required.clean", "false"]);
      git(fixture.repo, ["config", "filter.varin-required.smudge", "cat"]);
      git(fixture.repo, ["config", "filter.varin-required.required", "true"]);
      const parentHead = git(fixture.repo, ["rev-parse", "HEAD"]);
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, ".gitattributes"), "filtered.txt filter=varin-required\n");
      writeFileSync(join(live, "filtered.txt"), "materialized bytes\n");
      await expect(runtime.attachIsolatedGitContext(fixture.repo, {
        path: live,
        managedRoot: fixture.worktrees,
        base: parentHead,
        materialized: true,
      })).rejects.toThrow(/filter|clean|failed|exit/i);
      expect(readFileSync(join(live, "filtered.txt"), "utf8")).toBe("materialized bytes\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
