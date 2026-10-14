import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { waitForManagedExit, type ManagedSpawn } from '../process/types.js';
import { isNotGitRepositoryError, isUnbornHeadError, parseGitNullList, parseGitStageList, workdirContentIdentities, type BaselineInventory } from '../harness/working-state/workspace-baseline.js';
/** Read-only Git inventory for native source capture; all processes remain Kernel-owned. */
export function createSourceGitInventory(options: { spawn: ManagedSpawn; gitBinary: string; env: NodeJS.ProcessEnv }) {
  const fsPromises = fs.promises, pathModule = path;
  const abortError = () => new DOMException('Source inventory cancelled', 'AbortError');
  const runGit = async (cwd: string, args: string[], input?: Buffer | string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const child = await options.spawn(options.gitBinary, args, { cwd, env: options.env, shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: Error | undefined;
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => { failure ??= error; });
    child.stdin?.on('error', error => { failure ??= error; });
    if (input !== undefined) child.stdin?.end(input);
    await waitForManagedExit(child);
    signal?.throwIfAborted();
    if (failure) throw failure;
    const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (child.exitCode !== 0) throw new Error(result.stderr.trim() || 'Git inventory process did not succeed');
    return result;
  };
  const inspect = async (
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
      collect(["diff", "--relative", "--name-only", "-z", "--", "."]),
      collect(["diff", "--relative", "--cached", "--name-only", "-z", "--", "."]),
      collect(["ls-files", "-s", "-z"]),
    ]);
    const versusHead = unborn ? [] : parseGitNullList(await collect(["diff", "--relative", "--name-only", "-z", "HEAD", "--", "."]));
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
    // Git resolves --stdin-paths from its repository root, whereas ls-files and our
    // inventory are relative to the selected directory, which may be a subtree.
    const rawHashes = rawPaths.length ? (await runGit(directory, ["hash-object", "--no-filters", "--stdin-paths"], rawPaths.map(file => quoted(pathModule.resolve(directory, file))).join("\n") + "\n", signal)).stdout.trim().split(/\r?\n/u) : [];
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
      indexFingerprint: createHash("sha256").update(stagedMeta).digest("hex"),
      indexModes,
      contentIdentities,
      rawFileHashes,
    };
  };

  return inspect;
}
