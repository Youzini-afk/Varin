import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";
import { createDocumentAuthority } from "../../documents/authority.js";
import { createThreadRegistry } from "../thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../thread-runtime.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { acquireVirtualWriteTicket, VirtualWriteGate } from "./virtual-write-gate.js";
import { createTestWorkingStateRootAccess, createWorkingStateObjectCollector, createWorkingStateStoreContextAccess } from "./working-state-root-adapter.test-helper.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("branch integration lock order", () => {
  it("returns a determinate nested merge while materialize holds beginSwitch and waits for the store", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "varin-branch-lock-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const scratch = path.join(root, "scratch");
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(scratch, { recursive: true });
    await fs.promises.writeFile(path.join(workspace, "kept.txt"), "parent\n");
    const documentsAuthority = createDocumentAuthority({
      hostId: "test-host",
      dataDir: path.join(root, "docs"),
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const { workspaceId } = await documentsAuthority.resolveWorkspace({ path: workspace });
    const recoveryRoot = path.join(root, "recovery");
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error("Working-state test catalog is missing");
    const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test-host", canonicalRoot: workspace, filesystemProfile: "test", workspaceId },
      resourceOperationGate: { run: async <Result>(_resources: readonly unknown[], next: () => Promise<Result>) => next() },
      root: recoveryRoot,
      collectUnreachableObjects: createWorkingStateObjectCollector(recoveryRoot, database),
    }));
    const views = new ThreadExecutionViewRegistry();
    const writeGate = new VirtualWriteGate();
    const coordinator = new IntegrationCoordinator({
      workingStates,
      holdParentVirtualWrite: async (sessionId, signal) => {
        const ticket = await acquireVirtualWriteTicket(
          writeGate,
          sessionId,
          () => views.get(sessionId)?.mode === "virtual",
          signal,
        );
        return ticket === "disk"
          ? { status: "disk" }
          : { status: "virtual", release: () => ticket.finish() };
      },
      resolveParentSessionId: (id, branchId) => views.findByBranch(id, branchId)?.sessionId,
      commitParentVirtualWrites: async (input) => {
        const result = await input.store.commitVirtualWrites(
          input.branchId,
          input.expectedWriteRevision,
          input.files,
        );
        const sessionId = input.sessionId ?? views.findByBranch(input.workspaceId, input.branchId)?.sessionId;
        if (result.status === "committed" && sessionId) {
          const live = views.get(sessionId);
          if (live?.mode === "virtual") views.bind({ ...live, writeRevision: result.writeRevision });
        }
        return result;
      },
    });
    const registry = createThreadRegistry({ dataDir: path.join(root, "threads"), hostId: "test-host" });
    const runtime = createThreadRuntime({
      registry,
      workingStates,
      executionViews: views,
      virtualWriteGate: writeGate,
      resolveIntegrationCoordinator: () => coordinator,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => workspaceId,
      sessions: {
        create: async () => ({ sessionId: "unused", cwd: scratch } as never),
        open: async (input) => ({ sessionId: input.sessionId, cwd: input.cwd } as never),
        prompt: async () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
        snapshot: async (sessionId) => ({ sessionId, cwd: scratch } as never),
        summary: async (sessionId) => ({ id: sessionId, sessionFile: sessionId, cwd: scratch } as never),
        stats: async () => ({ tokens: 0 } as never),
        entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
      } as ThreadSessionAdapter,
      worktrees: {
        prepare: async () => ({ cwd: scratch, worktree: { path: scratch, base: "base", viewMode: "virtual" } }),
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        attachIsolatedGitContext: async () => ({ kind: "none" as const }),
      },
    });
    try {
      const published = await workingStates.withStore(workspaceId, "lock-setup", async (store) => {
        const captured = await store.captureDirectory(workspace);
        await store.createBranch(workspaceId, "thread-parent", captured, "base");
        await store.createBranch(workspaceId, "thread-child", captured, "base");
        const object = await store.putObject(Buffer.from("from-child\n"));
        await store.commitVirtualWrites("thread-child", 0, {
          "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child");
      });
      const parent = await registry.createThread({
        scopeId: workspaceId,
        parent: { kind: "session", id: "root" },
        brief: "parent",
        preset: "worker",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        autoRun: true,
        worktree: "isolated",
        model: { providerId: "test", modelId: "test" },
        tools: ["read", "write", "bash"],
        permissions: {},
      });
      const worktree = { path: scratch, base: "base", viewMode: "virtual" as const, materialized: false, preparationStage: "ready" as const };
      await registry.setWorktree(workspaceId, parent.id, worktree);
      await registry.setWorkingState(workspaceId, parent.id, { branchId: "thread-parent", worktree });
      const parentRun = await registry.startRun(workspaceId, parent.id);
      await registry.markRunRunning(workspaceId, parent.id, parentRun.id, "session-parent");
      views.bind({
        sessionId: "session-parent",
        workspaceId,
        threadId: parent.id,
        runId: parentRun.id,
        branchId: "thread-parent",
        revision: 0,
        writeRevision: 0,
        mode: "virtual",
        draftBasePaths: [],
      });
      const child = await registry.createThread({
        scopeId: workspaceId,
        parent: { kind: "thread", id: parent.id },
        brief: "child",
        preset: "worker",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        autoRun: true,
        worktree: "isolated",
        model: { providerId: "test", modelId: "test" },
        tools: ["read", "write"],
        permissions: {},
      });
      await registry.setWorkingState(workspaceId, child.id, {
        branchId: "thread-child",
        resultRevision: published.resultRevision,
      });
      let releaseHold!: () => void;
      let holdStarted!: () => void;
      const held = new Promise<void>((resolve) => { holdStarted = resolve; });
      const holding = workingStates.withStore(workspaceId, "hold-exclusive-for-switch", async () => {
        holdStarted();
        await new Promise<void>((resolve) => { releaseHold = resolve; });
      });
      await held;
      const materialize = runtime.materializeExecutionView("session-parent");
      await expect.poll(() => writeGate.switching("session-parent")).toBe(true);
      const merge = runtime.merge(workspaceId, { kind: "thread", id: parent.id }, child.id);
      releaseHold();
      await holding;
      const [materialized, merged] = await Promise.all([materialize, merge]);
      expect(materialized.status === "materialized" || materialized.status === "failed").toBe(true);
      expect(typeof merged.status).toBe("string");
      expect(merged.status).toMatch(/applied|conflict|needs-attention|compensated/);
      expect(writeGate.switching("session-parent")).toBe(false);
    } finally {
      await runtime.dispose();
      await registry.dispose();
      database.close();
      await documentsAuthority.dispose();
    }
  });
});
