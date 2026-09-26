import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HarnessActorContext } from "@varin/protocol";
import { createHarnessPathAuthority } from "./path-authority.js";
import {
  discoverProjects,
  getWorkContext,
  operationDirAbsolute,
  resetWorkContext,
  seedWorkContext,
  selectOperationDir,
  setQueryScope,
} from "./work-context.js";

const actor = (overrides: Partial<HarnessActorContext> = {}): HarnessActorContext => ({
  authorityInstanceId: "broker-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["context.session"],
  ...overrides,
});

const harness = (root: string) => {
  const authority = createHarnessPathAuthority({
    authorityId: "host-1",
    documents: { inspectWorkspace: async () => ({ root }) },
  });
  const a = actor();
  return {
    workspaceRoot: root,
    sessionRoot: root,
    authorize: (candidate: string, options: { allowMissing: boolean }) =>
      authority.resolve(a, candidate, options),
    authorizeScopeRoots: [root],
  };
};

describe("harness work context", () => {
  it("rejects a delayed selection that loses its revision during authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-cas-"));
    fs.mkdirSync(join(root, "first"));
    fs.mkdirSync(join(root, "second"));
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const delayed = {
      ...deps,
      authorize: async (candidate: string, options: { allowMissing: boolean }) => {
        if (candidate === join(root, "first")) await gate;
        return deps.authorize(candidate, options);
      },
    };
    try {
      const first = selectOperationDir(state, { path: "first", expectedRevision: 0 }, delayed);
      await selectOperationDir(state, { path: "second", expectedRevision: 0 }, deps);
      release();
      await expect(first).rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(state).toMatchObject({ operationDir: "second", revision: 1 });
    } finally { release(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not reset to a deleted launch directory or seed outside its authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-reset-missing-"));
    const launch = join(root, "launch");
    fs.mkdirSync(launch);
    const state = seedWorkContext(root, launch);
    const deps = { ...harness(root), sessionRoot: launch };
    try {
      await selectOperationDir(state, { path: "." }, deps);
      rmSync(launch, { recursive: true });
      await expect(Promise.resolve().then(() => resetWorkContext(state, {}, deps))).rejects.toThrow();
      expect(state).toMatchObject({ operationDir: "", revision: 1 });
      expect(() => seedWorkContext(root, resolve(root, "../outside"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("authorizes discovery roots before enumerating them", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-denied-"));
    writeFileSync(join(root, "package.json"), "{}");
    try {
      const found = await discoverProjects({}, { ...harness(root), authorize: async () => null });
      expect(found.candidates).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("seeds the operation dir from the session launch dir relative to the root", () => {
    const state = seedWorkContext("/ws", join("/ws", "packages", "web"));
    expect(state).toEqual({ operationDir: "packages/web", queryScope: null, revision: 0 });
    expect(operationDirAbsolute(state, "/ws")).toBe(resolve("/ws", "packages", "web"));
    expect(() => seedWorkContext("/ws", "/elsewhere")).toThrow();
  });

  it("selects a project dir, rejects non-directories, and enforces CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-"));
    fs.mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    try {
      const selected = await selectOperationDir(state, { path: "apps/web" }, deps);
      expect(selected.context.operationDir).toBe("apps/web");
      expect(selected.context.revision).toBe(1);

      // Stale expectedRevision is rejected and does not mutate.
      await expect(selectOperationDir(state, { path: ".", expectedRevision: 0 }, deps))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(state.operationDir).toBe("apps/web");

      // A file is not a valid operation dir.
      await expect(selectOperationDir(state, { path: "file.txt" }, deps))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });

      // Outside the workspace is forbidden, not silently rebased.
      await expect(selectOperationDir(state, { path: ".." }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps select inside a restricted workspace scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-scope-"));
    fs.mkdirSync(join(root, "packages", "web"), { recursive: true });
    fs.mkdirSync(join(root, "other"), { recursive: true });
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    const scoped = actor({ workspaceScope: ["packages/web"] });
    const deps = {
      workspaceRoot: root,
      sessionRoot: join(root, "packages", "web"),
      authorize: (candidate: string, options: { allowMissing: boolean }) =>
        authority.resolve(scoped, candidate, options),
      authorizeScopeRoots: [join(root, "packages", "web")],
    };
    const state = seedWorkContext(root, join(root, "packages", "web"));
    try {
      await expect(selectOperationDir(state, { path: "other" }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
      const ok = await selectOperationDir(state, { path: "packages/web" }, deps);
      expect(ok.context.operationDir).toBe("packages/web");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets and clears the query scope inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-qscope-"));
    fs.mkdirSync(join(root, "src"), { recursive: true });
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    try {
      const scoped = await setQueryScope(state, { paths: ["src", "missing-future-dir"] }, deps);
      expect(scoped.context.queryScope).toEqual(["src", "missing-future-dir"]);
      const cleared = await setQueryScope(state, { paths: [] }, deps);
      expect(cleared.context.queryScope).toBeNull();
      await expect(setQueryScope(state, { paths: ["../outside"] }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets to the session launch dir and bumps the revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-reset-"));
    fs.mkdirSync(join(root, "sub"), { recursive: true });
    const sessionRoot = join(root, "sub");
    const deps = { ...harness(root), sessionRoot };
    const state = seedWorkContext(root, sessionRoot);
    await selectOperationDir(state, { path: "." }, deps);
    expect(state.operationDir).toBe("");
    const reset = await resetWorkContext(state, {}, deps);
    expect(reset.context.operationDir).toBe("sub");
    expect(reset.context.revision).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers marker-bearing project dirs without leaving the scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-"));
    fs.mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "package.json"), "{}");
    fs.mkdirSync(join(root, "libs", "core", ".git"), { recursive: true });
    fs.mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(root, "node_modules", "junk", "package.json"), "{}");
    const deps = harness(root);
    try {
      const found = await discoverProjects({}, deps);
      const paths = found.candidates.map((candidate) => candidate.path).sort();
      expect(paths).toEqual(["apps/web", "libs/core"]);
      // The root marker file also makes "" a candidate; node_modules never is.
      expect(paths).not.toContain("node_modules/junk");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues paged discovery through projects deeper than the former default depth", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-pages-"));
    const projectPaths = [
      "packages/p0",
      "packages/p1",
      "packages/p2",
      "groups/one/nested/two/apps/deep",
    ];
    for (const relative of projectPaths) {
      mkdirSync(join(root, relative), { recursive: true });
      writeFileSync(join(root, relative, "package.json"), "{}");
    }
    const deps = harness(root);
    try {
      const first = await discoverProjects({ maxResults: 1 }, deps);
      expect(first.candidates.map((candidate) => candidate.path)).toEqual(["groups/one/nested/two/apps/deep"]);
      expect(first.truncated).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));

      const all = [...first.candidates];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await discoverProjects({ cursor, maxResults: 1 }, deps);
        all.push(...page.candidates);
        expect(page.truncated).toBe(page.nextCursor !== undefined);
        cursor = page.nextCursor;
      }
      expect(all.map((candidate) => candidate.path).sort()).toEqual(projectPaths.sort());
      expect(new Set(all.map((candidate) => candidate.path)).size).toBe(projectPaths.length);

      const deepStart = await discoverProjects({ path: "groups/one/nested/two" }, deps);
      expect(deepStart.candidates.map((candidate) => candidate.path)).toEqual(["groups/one/nested/two/apps/deep"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("limits discovery to the actor's authorized roots and rejects an unauthorized explicit start", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-scope-"));
    mkdirSync(join(root, "allowed", "nested"), { recursive: true });
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(join(root, "allowed", "nested", "package.json"), "{}");
    writeFileSync(join(root, "private", "package.json"), "{}");
    const restricted = actor({ workspaceScope: ["allowed"] });
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    let reads = 0;
    const deps = {
      workspaceRoot: root,
      sessionRoot: join(root, "allowed"),
      authorize: (candidate: string, options: { allowMissing: boolean }) =>
        authority.resolve(restricted, candidate, options),
      authorizeScopeRoots: [join(root, "allowed")],
      fs: {
        stat: fs.promises.stat.bind(fs.promises),
        readdir: async (...args: Parameters<typeof fs.promises.readdir>) => {
          reads++;
          return fs.promises.readdir(...args);
        },
      },
    };
    try {
      const found = await discoverProjects({}, deps as never);
      expect(found.candidates.map((candidate) => candidate.path)).toEqual(["allowed/nested"]);
      const beforeDeniedRequest = reads;
      await expect(discoverProjects({ path: "private" }, deps as never))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
      expect(reads).toBe(beforeDeniedRequest);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports unreadable authorized directories separately from complete traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-unreadable-"));
    const unreadable = join(root, "a-unreadable");
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, "package.json"), "{}");
    mkdirSync(join(root, "z-readable"));
    writeFileSync(join(root, "z-readable", "package.json"), "{}");
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    const sameDirectory = (left: string, right: string): boolean => {
      const a = fs.statSync(left, { bigint: true });
      const b = fs.statSync(right, { bigint: true });
      return a.isDirectory() && b.isDirectory() && a.ino !== 0n
        && a.dev === b.dev && a.ino === b.ino;
    };
    const scannedDirectories: string[] = [];
    let denyUnreadable = true;
    const deps = {
      ...harness(root),
      fs: {
        stat: fs.promises.stat.bind(fs.promises),
        readdir: async (...args: Parameters<typeof fs.promises.readdir>) => {
          scannedDirectories.push(String(args[0]));
          if (denyUnreadable && sameDirectory(String(args[0]), unreadable)) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return realReaddir(...args);
        },
      },
    };
    try {
      const found = await discoverProjects({}, deps as never);
      expect(found.candidates.map((candidate) => candidate.path)).toEqual(["z-readable"]);
      expect(found.truncated).toBe(false);
      expect(found.nextCursor).toBeUndefined();
      expect(scannedDirectories.some((directory) => sameDirectory(directory, unreadable))).toBe(true);
      expect(found.unreadablePaths).toEqual(["a-unreadable"]);

      denyUnreadable = false;
      const retried = await discoverProjects({ path: "a-unreadable" }, deps as never);
      expect(retried.candidates.map((candidate) => candidate.path)).toEqual(["a-unreadable"]);
      expect(retried.unreadablePaths).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("cancels discovery during directory reads and invalidates cursors across actor generations", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-cancel-"));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a", "package.json"), "{}");
    writeFileSync(join(root, "b", "package.json"), "{}");
    const deps = harness(root);
    const controller = new AbortController();
    const cancelDeps = {
      ...deps,
      signal: controller.signal,
      fs: {
        stat: fs.promises.stat.bind(fs.promises),
        readdir: async (...args: Parameters<typeof fs.promises.readdir>) => {
          const result = await fs.promises.readdir(...args);
          controller.abort();
          return result;
        },
      },
    };
    try {
      await expect(discoverProjects({}, cancelDeps as never)).rejects.toMatchObject({ name: "AbortError" });

      const first = await discoverProjects({ maxResults: 1 }, { ...deps, cursorBinding: "session-generation-1" });
      expect(first.nextCursor).toEqual(expect.any(String));
      const cursor = first.nextCursor!;
      await expect(discoverProjects({ cursor }, { ...deps, cursorBinding: "session-generation-2" }))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      await expect(discoverProjects({ cursor: `${cursor}tampered` }, deps))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      const changedScope = { ...deps, authorizeScopeRoots: [join(root, "a")] };
      await expect(discoverProjects({ cursor }, changedScope))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      const revoked = {
        ...deps,
        authorize: (candidate: string, options: { allowMissing: boolean }) =>
          resolve(candidate).toLowerCase() === resolve(join(root, "a")).toLowerCase()
            ? Promise.resolve(null)
            : deps.authorize(candidate, options),
      };
      await expect(discoverProjects({ cursor }, revoked))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the current state through context.get", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-get-"));
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    const view = getWorkContext(state, deps);
    expect(view.workspaceRoot).toBe(root);
    expect(view.context).toMatchObject({ operationDir: "", queryScope: null, revision: 0 });
    rmSync(root, { recursive: true, force: true });
  });
});
