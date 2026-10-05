import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadRuntime } from "./thread-runtime.js";
import { IntegrationCoordinator } from "./working-state/integration-coordinator.js";
import type { RecoveryState } from "./working-state/types.js";
import { createTestWorkingStateRootAccess, createWorkingStateObjectCollector, createWorkingStateStoreContextAccess } from "./working-state/working-state-root-adapter.test-helper.js";

const PARENT = { kind: "session" as const, id: "root-session" };
const roots: string[] = [];

const regularFile = (object: { hash: string; byteLength: number }, mode?: number): RecoveryState => ({
  kind: "regular-file",
  objectHash: object.hash,
  byteLength: object.byteLength,
  ...(mode === undefined ? {} : { mode }),
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("nested thread production chain", () => {
  it("fixes a grandchild from the parent branch view and merges back without copying the grandchild transcript", async () => {
    const root = await fs.promises.mkdtemp(join(os.tmpdir(), "varin-nested-threads-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(join(workspace, "kept.txt"), "root-at-dispatch\n");
    const recoveryRoot = join(root, "recovery");
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error("catalog missing");
    const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
      resourceOperationGate: { run: async <Result>(_resources: readonly unknown[], next: () => Promise<Result>) => next() },
      root: recoveryRoot,
      collectUnreachableObjects: createWorkingStateObjectCollector(recoveryRoot, database),
    }));
    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "host-1" });
    const runtime = createThreadRuntime({
      registry,
      workingStates,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => "ws",
      sessions: {
        create: async () => { throw new Error("session create is not used"); },
        open: async () => { throw new Error("session open is not used"); },
        prompt: async () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
        snapshot: async () => { throw new Error("unused"); },
        summary: async () => { throw new Error("unused"); },
        stats: async () => { throw new Error("unused"); },
        entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
      },
      worktrees: {
        prepare: async (input) => {
          const path = join(root, `scratch-${input.threadId}`);
          await fs.promises.mkdir(path, { recursive: true });
          return {
            cwd: path,
            worktree: { path, base: "zero-commit", viewMode: "virtual", materialized: false },
          };
        },
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    const coordinator = new IntegrationCoordinator({ workingStates });
    const input = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
      scopeId: "ws",
      parent: PARENT,
      brief: "parent",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 4,
      autoRun: true,
      worktree: "isolated",
      tools: ["read", "write", "dispatch"],
      permissions: {},
      ...overrides,
    });
    try {
      const parent = await registry.createThread(input());
      await runtime.prepareIsolatedBranch({
        scopeId: "ws",
        parent: PARENT,
        threadId: parent.id,
      });
      await workingStates.withStore("ws", "parent-write", async (store) => {
        const branch = store.getBranch(`thread-${parent.id}`)!;
        const current = store.effectiveState(`thread-${parent.id}`)!["kept.txt"];
        const object = await store.putObject(Buffer.from("parent-before-child\n"));
        await store.commitVirtualWrites(`thread-${parent.id}`, branch.writeRevision ?? 0, {
          "kept.txt": regularFile(object, current?.kind === "regular-file" ? current.mode : undefined),
        });
      });
      const child = await registry.createThread(input({
        parent: { kind: "thread", id: parent.id },
        brief: "grandchild",
        preset: "worker",
      }));
      await runtime.prepareIsolatedBranch({
        scopeId: "ws",
        parent: { kind: "thread", id: parent.id },
        threadId: child.id,
      });
      await workingStates.withStore("ws", "parent-drift-after-nested-dispatch", async (store) => {
        const branch = store.getBranch(`thread-${parent.id}`)!;
        const current = store.effectiveState(`thread-${parent.id}`)!["kept.txt"];
        const object = await store.putObject(Buffer.from("parent-after-child-dispatch\n"));
        await store.commitVirtualWrites(`thread-${parent.id}`, branch.writeRevision ?? 0, {
          "kept.txt": regularFile(object, current?.kind === "regular-file" ? current.mode : undefined),
        });
        const childView = store.effectiveState(`thread-${child.id}`)!;
        const kept = childView["kept.txt"];
        if (kept?.kind !== "regular-file") throw new Error("expected nested baseline file");
        expect(await store.getObject(kept.objectHash)).toEqual(Buffer.from("parent-before-child\n"));
        expect(store.getBranch(`thread-${child.id}`)?.baseRef).toMatch(new RegExp(`^thread-${parent.id}@`));
      });
      const childResult = await workingStates.withStore("ws", "child-result", async (store) => {
        const branch = store.getBranch(`thread-${child.id}`)!;
        const object = await store.putObject(Buffer.from("grandchild-edit\n"));
        await store.commitVirtualWrites(`thread-${child.id}`, branch.writeRevision ?? 0, {
          "child.txt": regularFile(object),
        });
        return store.publishHeadResult(`thread-${child.id}`);
      });
      await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: child.id,
        branchId: `thread-${child.id}`,
        resultRevision: childResult.resultRevision,
        parentAuthority: { kind: "branch", branchId: `thread-${parent.id}` },
      });
      expect(await fs.promises.readFile(join(workspace, "kept.txt"), "utf8")).toBe("root-at-dispatch\n");
      expect(await fs.promises.stat(join(workspace, "child.txt")).then(() => true, () => false)).toBe(false);
      const parentResult = await workingStates.withStore("ws", "parent-after-nested-merge", async (store) => {
        const live = store.effectiveState(`thread-${parent.id}`)!;
        const childFile = live["child.txt"];
        if (childFile?.kind !== "regular-file") throw new Error("expected grandchild file on parent branch");
        expect(await store.getObject(childFile.objectHash)).toEqual(Buffer.from("grandchild-edit\n"));
        const kept = live["kept.txt"];
        if (kept?.kind !== "regular-file") throw new Error("expected parent file");
        expect(await store.getObject(kept.objectHash)).toEqual(Buffer.from("parent-after-child-dispatch\n"));
        return store.publishHeadResult(`thread-${parent.id}`);
      });
      const parentMerge = await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: parent.id,
        branchId: `thread-${parent.id}`,
        resultRevision: parentResult.resultRevision,
      });
      expect(parentMerge).toMatchObject({ status: "applied" });
      expect(parentMerge.appliedPaths).toEqual(expect.arrayContaining(["kept.txt", "child.txt"]));
      expect(await fs.promises.readFile(join(workspace, "kept.txt"), "utf8")).toBe("parent-after-child-dispatch\n");
      expect(await fs.promises.readFile(join(workspace, "child.txt"), "utf8")).toBe("grandchild-edit\n");
      expect(childResult.changedPaths).not.toContain("transcript");
    } finally {
      await runtime.dispose();
      await registry.dispose();
      database.close();
    }
  });

  it("inherits the parent branch captureScopes and ignores later live copyIgnored settings", async () => {
    const root = await fs.promises.mkdtemp(join(os.tmpdir(), "varin-nested-scopes-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(join(workspace, "kept.txt"), "root\n");
    await fs.promises.writeFile(join(workspace, "secret.env"), "parent-secret\n");
    const recoveryRoot = join(root, "recovery");
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error("catalog missing");
    const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
      resourceOperationGate: { run: async <Result>(_resources: readonly unknown[], next: () => Promise<Result>) => next() },
      root: recoveryRoot,
      collectUnreachableObjects: createWorkingStateObjectCollector(recoveryRoot, database),
    }));
    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "host-1" });
    let copyIgnored = ["secret.env"];
    let materializedParentRoot = "";
    const barrierWorkspaces: string[] = [];
    const captureWorkspaces: string[] = [];
    const writerWorkspaces: string[] = [];
    const runtime = createThreadRuntime({
      registry,
      workingStates,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async (directory) => directory === materializedParentRoot ? "execution-ws" : "ws",
      beginDirtyStateBarrier: async (workspaceId) => {
        barrierWorkspaces.push(workspaceId);
        return { release: async () => undefined, settle: async () => undefined };
      },
      beginBaselineCapture: async (workspaceId) => {
        captureWorkspaces.push(workspaceId);
        return { workspaceId };
      },
      completeBaselineCapture: async () => ({ stable: true, reasons: [] }),
      inspectBaselineWriters: async (workspaceId) => {
        writerWorkspaces.push(workspaceId);
        return [];
      },
      resolveWorktreeSettings: async () => ({ copyIgnored }),
      sessions: {
        create: async () => { throw new Error("session create is not used"); },
        open: async () => { throw new Error("session open is not used"); },
        prompt: async () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
        snapshot: async () => { throw new Error("unused"); },
        summary: async () => { throw new Error("unused"); },
        stats: async () => { throw new Error("unused"); },
        entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
      },
      worktrees: {
        prepare: async (input) => {
          const path = join(root, `scratch-${input.threadId}`);
          await fs.promises.mkdir(path, { recursive: true });
          return {
            cwd: path,
            worktree: { path, base: "zero-commit", viewMode: "virtual", materialized: false },
          };
        },
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    try {
      const parent = await registry.createThread({
        scopeId: "ws",
        parent: PARENT,
        brief: "parent",
        preset: "worker",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 4,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch"],
        permissions: {},
      });
      await runtime.prepareIsolatedBranch({ scopeId: "ws", parent: PARENT, threadId: parent.id });
      const preparedParent = await registry.getThread("ws", PARENT, parent.id);
      materializedParentRoot = preparedParent!.worktree!.path;
      await workingStates.withStore("ws", "materialize-parent-for-nested-capture", async (store) => {
        const states = store.effectiveState(`thread-${parent.id}`)!;
        await store.materializeStates(states, materializedParentRoot);
      });
      await registry.setWorktree("ws", parent.id, {
        ...preparedParent!.worktree!,
        viewMode: "materialized",
        materialized: true,
      });
      copyIgnored = ["later.env"];
      const child = await registry.createThread({
        scopeId: "ws",
        parent: { kind: "thread", id: parent.id },
        brief: "child",
        preset: "worker",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 4,
        autoRun: true,
        worktree: "isolated",
        tools: ["read"],
        permissions: {},
      });
      await runtime.prepareIsolatedBranch({
        scopeId: "ws",
        parent: { kind: "thread", id: parent.id },
        threadId: child.id,
      });
      await workingStates.withStore("ws", "assert-inherited-scopes", async (store) => {
        expect(store.getBranch(`thread-${parent.id}`)?.captureScopes).toEqual(["secret.env"]);
        expect(store.getBranch(`thread-${child.id}`)?.captureScopes).toEqual(["secret.env"]);
        expect(store.getBranch(`thread-${child.id}`)?.baseRef).toBe("zero-commit");
      }, "shared");
      expect(barrierWorkspaces.at(-1)).toBe("execution-ws");
      expect(captureWorkspaces.at(-1)).toBe("execution-ws");
      expect(writerWorkspaces.at(-1)).toBe("execution-ws");
    } finally {
      await runtime.dispose();
      await registry.dispose();
      database.close();
    }
  });
});
