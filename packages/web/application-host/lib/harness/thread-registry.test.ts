import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ThreadMessageRecord, ThreadPendingContinuation } from "@varin/protocol";
import {
  THREAD_REGISTRY_SCHEMA_VERSION,
  ThreadRegistryError,
  createThreadRegistry,
  threadCatalogPath,
  threadSessionBindingsPath,
  type CreateThreadInput,
  type ThreadParent,
  type ThreadReport,
} from "./thread-registry.js";

const WORKSPACE = "workspace-1";
const PARENT: ThreadParent = { kind: "session", id: "parent-1" };

const createInput = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  scopeId: WORKSPACE,
  parent: PARENT,
  brief: "write tests",
  preset: "worker",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  model: { providerId: "test-provider", modelId: "test-model" },
  tools: [],
  permissions: {},
  ...overrides,
});

const report = (conclusion = "done"): ThreadReport => ({
  conclusion,
  changedFiles: ["a.ts"],
  unresolved: [],
  deviations: [],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: "entry-1", toEntryId: "entry-2" },
  blocksSnapshot: {},
});

describe("thread registry", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-reg-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
  });

  afterEach(async () => {
    await registry.dispose();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("creates durable work separately from its first execution attempt", async () => {
    const thread = await registry.createThread(createInput());
    expect(thread.lifecycle).toBe("queued");
    expect(thread.activeRunId).toBeNull();
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(0);

    const starting = await registry.startRun(WORKSPACE, thread.id);
    expect(starting.attempt).toBe(1);
    expect(starting.workerState).toBe("starting");
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(1);

    const running = await registry.markRunRunning(WORKSPACE, thread.id, starting.id, "child-session-1");
    expect(running.sessionId).toBe("child-session-1");
    expect(running.workerState).toBe("running");
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.lifecycle).toBe("active");
    expect(await registry.getSessionBinding("child-session-1")).toEqual({
      sessionId: "child-session-1",
      owner: "spawned-child",
      owningScopeId: WORKSPACE,
      threadId: thread.id,
      runId: starting.id,
      parent: PARENT,
    });
  });

  it("reloads a catalog-matching session binding after restart", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect(await registry.getSessionBinding("child-session-1")).toEqual({
      sessionId: "child-session-1",
      owner: "spawned-child",
      owningScopeId: WORKSPACE,
      threadId: thread.id,
      runId: run.id,
      parent: PARENT,
    });
    expect(await registry.getThreadForSession("execution-ws", "child-session-1")).toBeNull();
  });

  it("rebuilds a missing binding from the catalog and rejects a stale owner after restart", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    const bindingsPath = threadSessionBindingsPath(dataDir, "test-host");
    await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, bindings: [] }, null, 2), "utf8");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    await registry.reconcileAfterHostRestart();
    expect(await registry.getSessionBinding("child-session-1")).toEqual({
      sessionId: "child-session-1",
      owner: "spawned-child",
      owningScopeId: WORKSPACE,
      threadId: thread.id,
      runId: run.id,
      parent: PARENT,
    });

    await writeFile(bindingsPath, JSON.stringify({
      schemaVersion: 2,
      bindings: [{
        sessionId: "ghost-session",
        owner: "spawned-child",
        owningWorkspaceId: "wrong-ws",
        threadId: "ghost-thread",
        runId: "ghost-run",
        parent: PARENT,
      }],
    }, null, 2), "utf8");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    await expect(registry.getSessionBinding("ghost-session")).rejects.toMatchObject({
      name: "ThreadRegistryError",
      code: "stale-binding",
    });
    expect(JSON.parse(readFileSync(bindingsPath, "utf8")).bindings).toEqual([expect.objectContaining({
      sessionId: "child-session-1",
      threadId: thread.id,
      runId: run.id,
    })]);
  });

  it("rebuilds only the active Run owner and rejects a superseded session after restart", async () => {
    const thread = await registry.createThread(createInput());
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "session-1");
    await registry.endRun(WORKSPACE, thread.id, first.id, "success", null, report());
    const second = await registry.startRun(WORKSPACE, thread.id, "pi", { allowSettled: true });
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "session-2");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    await expect(registry.getSessionBinding("session-1")).rejects.toMatchObject({ code: "stale-binding" });
    expect(await registry.getThreadForSession(WORKSPACE, "session-1")).toBeNull();
    expect(await registry.getSessionBinding("session-2")).toMatchObject({
      sessionId: "session-2",
      threadId: thread.id,
      runId: second.id,
    });
    expect(await registry.getThreadForSession(WORKSPACE, "session-2")).toMatchObject({ id: thread.id });
  });

  it("fences descendant creation and dispatch while a cascade is active", async () => {
    const parent = await registry.createThread(createInput({ brief: "parent", autoRun: false }));
    const existing = await registry.createThread(createInput({ parent: { kind: "thread", id: parent.id }, autoRun: true }));
    const release = await registry.beginCascade(WORKSPACE, parent.id);
    try {
      await expect(registry.createThread(createInput({ parent: { kind: "thread", id: parent.id } }))).rejects.toThrow(/cascaded/);
      await expect(registry.startRun(WORKSPACE, existing.id)).rejects.toThrow(/cascaded/);
    } finally {
      release();
    }
    await expect(registry.startRun(WORKSPACE, existing.id)).resolves.toMatchObject({ workerState: "starting" });
  });

  it("does not discard a prepared dispatch after its lifecycle cascade takes ownership", async () => {
    const parent = await registry.createThread(createInput({ brief: "parent", autoRun: false }));
    const childParent = { kind: "thread" as const, id: parent.id };
    const child = await registry.createThread(createInput({ parent: childParent }));
    const release = await registry.beginCascade(WORKSPACE, parent.id);
    try {
      expect(await registry.deleteThread(WORKSPACE, childParent, child.id)).toBe(false);
      expect(await registry.getThread(WORKSPACE, childParent, child.id)).toMatchObject({ id: child.id });
    } finally {
      release();
    }
  });

  it("persists the retained branch and result commit", async () => {
    const thread = await registry.createThread(createInput());
    await registry.setWorktree(WORKSPACE, thread.id, {
      path: "D:/worktrees/thread-1",
      base: "base-commit",
      branch: "varin/thread-1",
      resultCommit: "result-commit",
      preparationStage: "ready",
    });
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.worktree).toEqual({
      path: "D:/worktrees/thread-1",
      base: "base-commit",
      branch: "varin/thread-1",
      resultCommit: "result-commit",
      preparationStage: "ready",
    });
  });

  it("persists native result and merged revision identities independently", async () => {
    const thread = await registry.createThread(createInput());
    await registry.setWorkingState(WORKSPACE, thread.id, {
      branchId: "thread-native",
      resultRevision: 2,
      diffStats: { files: 1, insertions: 1, deletions: 0 },
    });
    await registry.setIntegration(WORKSPACE, thread.id, "merged", undefined, undefined, 1);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      workBranchId: "thread-native",
      resultRevision: 2,
      mergedResultRevision: 1,
      integration: "merged",
    });
  });

  it("retires the prior default result when a new Run starts", async () => {
    const thread = await registry.createThread(createInput());
    await registry.setWorkingState(WORKSPACE, thread.id, {
      branchId: "thread-native",
      resultRevision: 2,
      diffStats: { files: 1, insertions: 1, deletions: 0 },
    });
    const run = await registry.startRun(WORKSPACE, thread.id);
    expect(run.inputRevision).toBe(2);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      workBranchId: "thread-native",
      activeRunId: run.id,
    });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.resultRevision).toBeUndefined();
  });

  it("records a lost attempt and starts attempt two without erasing history or attention", async () => {
    const thread = await registry.createThread(createInput());
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "permission", { kind: "permission", text: "allow bash?" });
    await registry.endRun(WORKSPACE, thread.id, first.id, "lost", "worker exited");

    const second = await registry.startRun(WORKSPACE, thread.id);
    const current = await registry.getThread(WORKSPACE, PARENT, thread.id);
    const runs = await registry.listRuns(WORKSPACE, thread.id);
    expect(second.attempt).toBe(2);
    expect(current?.activeRunId).toBe(second.id);
    expect(current?.attention).toBe("permission");
    expect(runs.map((run) => [run.attempt, run.outcome, run.workerState])).toEqual([
      [1, "lost", "lost"],
      [2, null, "starting"],
    ]);
  });

  it("allows lifecycle, attention, and integration to change independently", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "stalled");
    await registry.setIntegration(WORKSPACE, thread.id, "conflict", { files: 2, insertions: 3, deletions: 1 });
    const current = await registry.getThread(WORKSPACE, PARENT, thread.id);
    expect(current).toMatchObject({ lifecycle: "active", attention: "stalled", integration: "conflict" });
  });

  it("updates integration bindings idempotently and invalidates only the expected active preview", async () => {
    const thread = await registry.createThread(createInput());
    await registry.setIntegration(WORKSPACE, thread.id, "merge-ready");
    const binding = {
      operationId: "preview-1", resultRevision: 1, bindingFingerprint: "a".repeat(64),
      valid: true, mergeReady: true, conflictPaths: [], surfaceTargetPaths: [], unavailablePaths: [],
    };
    const first = await registry.setIntegrationBinding(WORKSPACE, thread.id, binding);
    const firstSeq = first!.eventSeq;
    const repeated = await registry.setIntegrationBinding(WORKSPACE, thread.id, binding);
    expect(repeated?.eventSeq).toBe(firstSeq);
    const repeatedStatus = await registry.setIntegration(WORKSPACE, thread.id, "merge-ready");
    expect(repeatedStatus?.eventSeq).toBe(firstSeq);
    const wrong = await registry.invalidateIntegrationBinding(WORKSPACE, thread.id, "b".repeat(64));
    expect(wrong?.eventSeq).toBe(firstSeq);
    const invalid = await registry.invalidateIntegrationBinding(WORKSPACE, thread.id, binding.bindingFingerprint);
    expect(invalid).toMatchObject({ integration: "dirty", integrationBinding: { valid: false, mergeReady: false } });
    expect(invalid!.eventSeq).toBe(firstSeq + 1);
    await registry.setIntegration(WORKSPACE, thread.id, "merged");
    await registry.setIntegrationBinding(WORKSPACE, thread.id, binding);
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.integrationBinding).toBeUndefined();
  });

  it("completes a run idempotently and retains merge state as a Thread concern", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    const first = await registry.completeThread(WORKSPACE, thread.id, report());
    const second = await registry.completeThread(WORKSPACE, thread.id, report("ignored"));
    expect(first?.lifecycle).toBe("settled");
    expect(first?.integration).toBe("dirty");
    expect(second).toEqual(first);
    await registry.mergeThread(WORKSPACE, thread.id);
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.integration).toBe("merged");
    expect((await registry.getActiveRun(WORKSPACE, thread.id))?.outcome).toBe("success");
  });

  it("supports a thread parent edge without mixing nested and root children", async () => {
    const root = await registry.createThread(createInput());
    const nestedParent: ThreadParent = { kind: "thread", id: root.id };
    const nested = await registry.createThread(createInput({ parent: nestedParent, brief: "nested" }));
    expect(await registry.listThreads(WORKSPACE, PARENT)).toEqual([root]);
    expect(await registry.listThreads(WORKSPACE, nestedParent)).toEqual([nested]);
    expect(await registry.getThread(WORKSPACE, PARENT, nested.id)).toBeNull();
  });

  it("stores metrics on the active run and diff integration on the Thread", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.updateRunProgress(WORKSPACE, thread.id, {
      steps: 5,
      tokens: { input: 100, output: 20 },
      costUsd: 0.01,
      lastToolCall: { name: "bash", at: "2026-09-04T00:00:00.000Z" },
      diffStats: { files: 1, insertions: 2, deletions: 0 },
    });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({
      id: run.id,
      steps: 5,
      tokens: { input: 100, output: 20, cacheRead: 0 },
      costUsd: 0.01,
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      integration: "dirty",
      diffStats: { files: 1, insertions: 2, deletions: 0 },
    });
  });

  it("persists one versioned atomic catalog per workspace", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(document.schemaVersion).toBe(THREAD_REGISTRY_SCHEMA_VERSION);
    expect(document.scopeId).toBe(WORKSPACE);
    expect(document.threads).toHaveLength(1);
    expect(document.runs).toHaveLength(1);

    const restarted = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await restarted.getActiveRun(WORKSPACE, thread.id))?.id).toBe(run.id);
    expect((await restarted.getThread(WORKSPACE, PARENT, thread.id))?.model).toEqual({
      providerId: "test-provider",
      modelId: "test-model",
    });
    expect((await restarted.getThread(WORKSPACE, PARENT, thread.id))?.manifest).toMatchObject({
      carryBlocks: true,
      concurrency: 12,
      draftBaselineId: null,
      tools: [],
      worktree: "isolated",
    });
    await restarted.dispose();
  });

  it("treats only ENOENT as an empty catalog", async () => {
    expect(await registry.listThreads(WORKSPACE, PARENT)).toEqual([]);
    expect(fs.existsSync(threadCatalogPath(dataDir, "test-host", WORKSPACE))).toBe(false);
  });

  it("does not cache or overwrite malformed JSON", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken", "utf8");
    await expect(registry.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "corrupt" });
    await expect(registry.createThread(createInput())).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("rejects a future schema without changing it", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    const future = JSON.stringify({ schemaVersion: 999, workspaceId: WORKSPACE, threads: [], runs: [] });
    await writeFile(path, future, "utf8");
    await expect(registry.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "future-schema" });
    expect(await readFile(path, "utf8")).toBe(future);
  });

  it("keeps permission errors distinct from an absent file", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, threads: [], runs: [] }), "utf8");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const failing = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      fsPromises: {
        mkdir: fs.promises.mkdir,
        readFile: vi.fn(async () => { throw denied; }) as typeof fs.promises.readFile,
        readdir: fs.promises.readdir,
        rename: fs.promises.rename,
        rm: fs.promises.rm,
        writeFile: fs.promises.writeFile,
      },
    });
    await expect(failing.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "read-failed" });
    expect(await readFile(path, "utf8")).toContain(`"workspaceId":"${WORKSPACE}"`);
    await failing.dispose();
  });

  it("does not import an obsolete parent catalog or alter its bytes", async () => {
    const oldPath = join(dataDir, "threads", "test-host", `${PARENT.id}.json`);
    await mkdir(dirname(oldPath), { recursive: true });
    const original = JSON.stringify([{ id: "old-thread", role: "check", status: "running" }]);
    await writeFile(oldPath, original, "utf8");
    expect(await registry.listThreads(WORKSPACE, PARENT)).toEqual([]);
    expect(await readFile(oldPath, "utf8")).toBe(original);
  });

  it("rejects obsolete internal versions without reconstructing missing permissions or rewriting data", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    for (const schemaVersion of [1, 4, 7, 8]) {
      const original = JSON.stringify({ schemaVersion, workspaceId: WORKSPACE, threads: [], runs: [] });
      await writeFile(path, original, "utf8");
      await expect(registry.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "corrupt" });
      expect(await readFile(path, "utf8")).toBe(original);
    }
  });

  it("converts a live discussion by ending its old Run and starting a same-session implementation Run atomically", async () => {
    const thread = await registry.createThread(createInput({
      autoRun: true,
      carryBlocks: false,
      createdBy: "user",
      kind: "discussion",
      tools: ["read", "grep"],
      worktree: "none",
    }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "child-discussion");
    await registry.setAttention(WORKSPACE, thread.id, "user", { kind: "user", text: "Continue" });

    const converted = await registry.convertThread(WORKSPACE, thread.id, {
      scope: [],
      tools: ["read", "edit", "bash"],
      worktree: { path: "D:/worktrees/thread", base: "base" },
    });
    expect(converted?.thread).toMatchObject({
      kind: "implementation",
      attention: "none",
      activeRunId: converted?.run.id,
      manifest: { carryBlocks: false, tools: ["read", "edit", "bash"], worktree: "isolated" },
      worktree: { path: "D:/worktrees/thread", base: "base" },
    });
    expect(await registry.listRuns(WORKSPACE, thread.id)).toMatchObject([
      { id: first.id, outcome: "success", workerState: "exited", exitReason: "converted to implementation" },
      { id: converted?.run.id, attempt: 2, outcome: null, workerState: "starting", sessionId: "child-discussion" },
    ]);
  });

  it("reconciles interrupted runs as lost while preserving pending attention", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "user", { kind: "user", text: "Which file?" });
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const result = await registry.reconcileAfterHostRestart();
    expect(result).toMatchObject({ reconciledRuns: 1, workspaces: 1, failures: [] });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({
      workerState: "lost",
      outcome: "lost",
      exitReason: "host restarted",
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      lifecycle: "active",
      attention: "user",
      waitingFor: { text: "Which file?" },
    });
  });

  it("reports one corrupt workspace without hiding successful reconciliation of another", async () => {
    const thread = await registry.createThread(createInput());
    await registry.startRun(WORKSPACE, thread.id);
    const badPath = threadCatalogPath(dataDir, "test-host", "workspace-bad");
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, "not json", "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const result = await registry.reconcileAfterHostRestart();
    expect(result.reconciledRuns).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ code: "corrupt", path: badPath });
  });

  it("does not publish a failed mutation into cache or disk", async () => {
    const thread = await registry.createThread(createInput());
    await registry.dispose();
    const failing = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      fsPromises: {
        mkdir: fs.promises.mkdir,
        readFile: fs.promises.readFile,
        readdir: fs.promises.readdir,
        rename: vi.fn(async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); }) as typeof fs.promises.rename,
        rm: fs.promises.rm,
        writeFile: fs.promises.writeFile,
      },
    });
    expect((await failing.getThreadSnapshot(WORKSPACE, thread.id))?.activeRun).toBeNull();
    await expect(failing.setAttention(WORKSPACE, thread.id, "stalled")).rejects.toBeInstanceOf(ThreadRegistryError);
    await expect(failing.startRun(WORKSPACE, thread.id)).rejects.toBeInstanceOf(ThreadRegistryError);
    expect(await failing.getActiveRun(WORKSPACE, thread.id)).toBeNull();
    expect(await failing.listRuns(WORKSPACE, thread.id)).toEqual([]);
    expect((await failing.getThread(WORKSPACE, PARENT, thread.id))?.attention).toBe("none");
    await failing.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.attention).toBe("none");
  });

  it("dequeues only after an active run frees a concurrency slot", async () => {
    const dequeued: string[] = [];
    const draftBaselines: Array<string | null> = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      maxConcurrency: 1,
      onThreadDequeued: async (_workspaceId, _parent, thread) => {
        dequeued.push(thread.id);
        draftBaselines.push(thread.manifest.draftBaselineId);
      },
    });
    const first = await registry.createThread(createInput({ brief: "first" }));
    const firstRun = await registry.startRun(WORKSPACE, first.id);
    await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "child-1");
    const second = await registry.createThread(createInput({ brief: "second", draftBaselineId: "draft-queued" }));
    await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, report());
    expect(dequeued).toEqual([second.id]);
    expect(draftBaselines).toEqual(["draft-queued"]);
  });

  it("uses the queued Thread's persisted concurrency after a restart or settings change", async () => {
    const dequeued: string[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadDequeued: async (_workspaceId, _parent, thread) => { dequeued.push(thread.id); },
    });
    const first = await registry.createThread(createInput({ brief: "first", concurrency: 2 }));
    const firstRun = await registry.startRun(WORKSPACE, first.id);
    await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "child-1");
    const second = await registry.createThread(createInput({ brief: "second", concurrency: 2 }));
    const secondRun = await registry.startRun(WORKSPACE, second.id);
    await registry.markRunRunning(WORKSPACE, second.id, secondRun.id, "child-2");
    const queued = await registry.createThread(createInput({ brief: "queued", concurrency: 1 }));

    await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, report());
    expect(dequeued).toEqual([]);
    await registry.endRun(WORKSPACE, second.id, secondRun.id, "success", null, report());
    expect(dequeued).toEqual([queued.id]);
  });

  it("wakes scoped waiters and keeps observer cursors isolated", async () => {
    const thread = await registry.createThread(createInput());
    const wake = vi.fn();
    const unsubscribe = registry.subscribeToChanges(WORKSPACE, PARENT, wake);
    registry.setCursor("observer-1", thread.id, {
      eventSeq: thread.eventSeq,
      lifecycle: thread.lifecycle,
      attention: thread.attention,
      integration: thread.integration,
      activeRunId: null,
      workerState: null,
      outcome: null,
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: "2026-09-04T00:00:00.000Z",
    });
    await registry.startRun(WORKSPACE, thread.id);
    expect(wake).toHaveBeenCalledOnce();
    expect(registry.getCursor("observer-1", thread.id)?.eventSeq).toBe(thread.eventSeq);
    registry.clearCursorsForSession("observer-1");
    expect(registry.getCursor("observer-1", thread.id)).toBeNull();
    unsubscribe();
  });

  it("rejects a deferred cursor commit from before a compaction reset", async () => {
    const thread = await registry.createThread(createInput());
    const cursor = {
      eventSeq: thread.eventSeq,
      lifecycle: thread.lifecycle,
      attention: thread.attention,
      integration: thread.integration,
      activeRunId: null,
      workerState: null,
      outcome: null,
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: "2026-09-05T00:00:00.000Z",
    };
    const epoch = registry.getCursorEpoch("observer-1");
    registry.clearCursorsForSession("observer-1");
    expect(registry.setCursor("observer-1", thread.id, cursor, epoch)).toBe(false);
    expect(registry.getCursor("observer-1", thread.id)).toBeNull();
  });

  it("archives active children when their parent session is deleted", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    await registry.cancelAllForParent(WORKSPACE, PARENT);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ lifecycle: "archived" });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ outcome: "cancelled" });
  });

  it("stops active children before parent deletion and archives settled siblings", async () => {
    const stopped: string[] = [];
    const active = await registry.createThread(createInput({ brief: "active" }));
    const activeRun = await registry.startRun(WORKSPACE, active.id);
    await registry.markRunRunning(WORKSPACE, active.id, activeRun.id, "child-active");
    const settled = await registry.createThread(createInput({ brief: "settled" }));
    const settledRun = await registry.startRun(WORKSPACE, settled.id);
    await registry.endRun(WORKSPACE, settled.id, settledRun.id, "success", null, report());

    await registry.cancelAllForParent(WORKSPACE, PARENT, async (thread) => { stopped.push(thread.id); });
    expect(stopped).toEqual([active.id]);
    expect(await registry.getThread(WORKSPACE, PARENT, active.id)).toMatchObject({ lifecycle: "archived" });
    expect(await registry.getThread(WORKSPACE, PARENT, settled.id)).toMatchObject({ lifecycle: "archived" });
    await expect(registry.createThread(createInput({ brief: "too late" }))).rejects.toThrow(/parent/);
  });

  it("archives a directly deleted child session without retaining a broken transcript reference", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-delete");
    await registry.completeThread(WORKSPACE, thread.id, report());

    const [archived] = await registry.archiveThreadsForDeletedSession(WORKSPACE, "child-delete");
    expect(archived).toMatchObject({ id: thread.id, lifecycle: "archived", report: null });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ outcome: "success" });
  });

  it("finds a deleted child session even when its runtime workspace differs from the parent catalog", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-worktree-session");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const archived = await registry.archiveThreadsForDeletedSessionAcrossWorkspaces("child-worktree-session");
    expect(archived.map((entry) => entry.id)).toEqual([thread.id]);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ lifecycle: "archived" });
  });

  it("archives a user thread without dropping its report and restores the original lifecycle", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-keep");
    await registry.completeThread(WORKSPACE, thread.id, report("keep this"));
    const archived = await registry.archiveThread(WORKSPACE, thread.id, true);
    expect(archived).toMatchObject({
      lifecycle: "archived",
      keepWorktree: true,
      report: { conclusion: "keep this", transcriptRef: { sessionId: "child-1" } },
    });
    const restored = await registry.restoreThread(WORKSPACE, thread.id);
    expect(restored).toMatchObject({ lifecycle: "settled", report: { conclusion: "keep this" } });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ sessionId: "child-keep", outcome: "success" });
  });

  it("does not reopen an archived thread through cancelThread", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.endRun(WORKSPACE, thread.id, run.id, "success", null);
    await registry.archiveThread(WORKSPACE, thread.id);
    expect(await registry.cancelThread(WORKSPACE, thread.id, "killed by parent")).toMatchObject({
      lifecycle: "archived",
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ lifecycle: "archived" });
  });

  // --- Directed messaging, shared-root admission, and waiting slots (3.18C) ---

  const parked = (overrides: Partial<ThreadPendingContinuation> = {}): ThreadPendingContinuation => ({
    mode: "continue",
    task: "resume this",
    requestId: "queued-request",
    from: { kind: "session", id: "parent-1" },
    at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  });

  const message = (overrides: Partial<ThreadMessageRecord> = {}): ThreadMessageRecord => ({
    id: `msg-${randomUUID()}`,
    direction: "in",
    from: { kind: "session", id: "parent-1" },
    to: { kind: "thread", id: "unused" },
    kind: "inform",
    text: "hello",
    status: "held",
    at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  });

  it("promotes a parked continuation through the shared root budget", async () => {
    const dequeued: string[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadDequeued: async (_workspaceId, _parent, thread) => { dequeued.push(thread.id); },
    });
    const settled = await registry.createThread(createInput({ brief: "settled", concurrency: 1 }));
    const settledRun = await registry.startRun(WORKSPACE, settled.id);
    await registry.endRun(WORKSPACE, settled.id, settledRun.id, "success", null, report());
    // Finish the earlier work before the blocker claims the only slot.
    // A fixture must not bypass the production admission invariant.
    const blocker = await registry.createThread(createInput({ brief: "blocker", concurrency: 1 }));
    const blockerRun = await registry.startRun(WORKSPACE, blocker.id);
    await registry.markRunRunning(WORKSPACE, blocker.id, blockerRun.id, "child-blocker");
    // The request arrived while the budget was full — it parks on the Thread.
    await registry.enqueueContinuation(WORKSPACE, settled.id, parked());
    expect(await registry.tryDequeue(WORKSPACE, PARENT)).toBeNull();
    expect(dequeued).toEqual([]);
    // Freeing the slot promotes the parked continuation like a queued Thread.
    await registry.endRun(WORKSPACE, blocker.id, blockerRun.id, "success", null, report());
    expect(dequeued).toEqual([settled.id]);
  });

  it("binds a parked requestId to its frozen execution identity", async () => {
    const thread = await registry.createThread(createInput({ brief: "identity" }));
    const frozen = {
      model: { providerId: "provider-a", modelId: "model-a" },
      tools: ["read"],
      scope: [],
      worktree: "isolated" as const,
      systemPromptFragment: null,
      inputOrigin: "fresh" as const,
      workFocus: "code" as const,
    };
    await registry.enqueueContinuation(WORKSPACE, thread.id, parked({ requestId: "req-identity", frozen }));
    await registry.enqueueContinuation(WORKSPACE, thread.id, parked({ requestId: "req-identity", frozen: {
      workFocus: frozen.workFocus,
      inputOrigin: frozen.inputOrigin,
      systemPromptFragment: frozen.systemPromptFragment,
      worktree: frozen.worktree,
      scope: frozen.scope,
      tools: frozen.tools,
      model: frozen.model,
    } }));
    await expect(registry.enqueueContinuation(WORKSPACE, thread.id, parked({
      requestId: "req-identity",
      frozen: { ...frozen, model: { providerId: "provider-b", modelId: "model-b" } },
    }))).rejects.toThrow("different input");
  });

  it("counts nested threads against the same root admission domain", async () => {
    const parent = await registry.createThread(createInput({ brief: "parent thread" }));
    const parentRun = await registry.startRun(WORKSPACE, parent.id);
    await registry.markRunRunning(WORKSPACE, parent.id, parentRun.id, "child-parent");
    const nested = await registry.createThread(createInput({
      brief: "nested",
      parent: { kind: "thread", id: parent.id },
    }));
    const nestedRun = await registry.startRun(WORKSPACE, nested.id);
    await registry.markRunRunning(WORKSPACE, nested.id, nestedRun.id, "child-nested");
    const foreign = await registry.createThread(createInput({
      brief: "foreign root",
      parent: { kind: "session", id: "other-root" },
    }));
    const foreignRun = await registry.startRun(WORKSPACE, foreign.id);
    await registry.markRunRunning(WORKSPACE, foreign.id, foreignRun.id, "child-foreign");
    // Both the parent thread and its nested child consume the root's budget;
    // the other root's work does not.
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(2);
    expect(await registry.countActiveInRoot(WORKSPACE, { kind: "thread", id: nested.id })).toBe(2);
    expect(await registry.countActiveInRoot(WORKSPACE, { kind: "session", id: "other-root" })).toBe(1);
  });

  it("releases the shared slot while a thread waits on a dependency", async () => {
    const dequeued: string[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadDequeued: async (_workspaceId, _parent, thread) => { dequeued.push(thread.id); },
    });
    const waiter = await registry.createThread(createInput({ brief: "waiter", concurrency: 1 }));
    const waiterRun = await registry.startRun(WORKSPACE, waiter.id);
    await registry.markRunRunning(WORKSPACE, waiter.id, waiterRun.id, "child-waiter");
    const queued = await registry.createThread(createInput({ brief: "queued", concurrency: 1 }));
    // The full budget keeps the sibling queued.
    expect(await registry.tryDequeue(WORKSPACE, PARENT)).toBeNull();
    // A display-only mark is not execution admission. The actually blocking
    // wait yields with the current Run identity and then promotes the sibling.
    await registry.setAttention(WORKSPACE, waiter.id, "thread", { kind: "thread", text: "Waiting on a child" });
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(1);
    await registry.yieldExecutionSlot(WORKSPACE, waiter.id, waiterRun.id, { kind: "thread", text: "Waiting on a child" });
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(0);
    expect(dequeued).toEqual([queued.id]);
    // Clearing attention alone cannot reclaim the slot.
    await registry.setAttention(WORKSPACE, waiter.id, "none");
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(0);
    await registry.awaitExecutionSlot(WORKSPACE, waiter.id, waiterRun.id, new AbortController().signal);
    expect(await registry.countActiveInRoot(WORKSPACE, PARENT)).toBe(1);
  });

  it("persists message records and a parked continuation across a reload", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.endRun(WORKSPACE, thread.id, run.id, "success", null, report());
    await registry.recordThreadMessage(WORKSPACE, thread.id, message({ id: "held-1", to: { kind: "thread", id: thread.id } }));
    await registry.enqueueContinuation(WORKSPACE, thread.id, parked({ requestId: "req-7" }));
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const reloaded = await registry.getThread(WORKSPACE, PARENT, thread.id);
    expect(reloaded?.messages).toEqual([
      expect.objectContaining({ id: "held-1", direction: "in", status: "held" }),
    ]);
    expect(reloaded?.pendingContinuations?.[0]).toMatchObject({ mode: "continue", task: "resume this", requestId: "req-7" });
  });

  it("rejects a catalog containing malformed message records", async () => {
    const thread = await registry.createThread(createInput());
    await registry.recordThreadMessage(WORKSPACE, thread.id, message({ id: "ok-1", to: { kind: "thread", id: thread.id } }));
    await registry.dispose();

    const catalogPath = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { threads: Array<{ messages?: unknown[] }> };
    catalog.threads[0]!.messages = [{ id: "bad", direction: "sideways", status: "held" }];
    writeFileSync(catalogPath, JSON.stringify(catalog));

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    await expect(registry.getThread(WORKSPACE, PARENT, thread.id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("notifies admission-freed when a slot opens with nothing queued", async () => {
    const freed: ThreadParent[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onAdmissionFreed: async (_workspaceId, parent) => { freed.push(parent); },
    });
    const thread = await registry.createThread(createInput({ concurrency: 1 }));
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    await registry.endRun(WORKSPACE, thread.id, run.id, "success", null, report());
    await vi.waitFor(() => { expect(freed).toEqual([PARENT]); });
  });

  it("keeps pending reads non-destructive and advances only explicit consumer receipts", async () => {
    const thread = await registry.createThread(createInput());
    const held = message({ id: "m-1", to: { kind: "thread", id: thread.id } });
    await registry.recordThreadMessage(WORKSPACE, thread.id, held);
    // A retry carrying the same id observes the recorded entry, not a duplicate.
    const again = await registry.recordThreadMessage(WORKSPACE, thread.id, held);
    expect(again.id).toBe("m-1");
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.messages).toHaveLength(1);
    await registry.recordThreadMessage(WORKSPACE, thread.id, message({ id: "m-2", to: { kind: "thread", id: thread.id }, status: "pending" }));
    // The current request's own record is excluded from the boundary flush.
    const taken = await registry.listPendingThreadMessages(WORKSPACE, thread.id, "m-2");
    expect(taken.map((entry) => entry.id)).toEqual(["m-1"]);
    // Reading and even reopening do not claim the consumer accepted anything.
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.listPendingThreadMessages(WORKSPACE, thread.id)).map((entry) => entry.id)).toEqual(["m-1", "m-2"]);
    await registry.acknowledgeThreadMessages(WORKSPACE, thread.id, ["m-1"]);
    expect(await registry.listPendingThreadMessages(WORKSPACE, thread.id)).toEqual([expect.objectContaining({ id: "m-2" })]);
    await registry.acknowledgeThreadMessages(WORKSPACE, thread.id, ["m-2"]);
    expect(await registry.listPendingThreadMessages(WORKSPACE, thread.id)).toEqual([]);
  });

  it("RR4/E07: resolveSessionOwner answers for a settled run and after restart", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-9");
    await registry.endRun(WORKSPACE, thread.id, run.id, "success", null, report());
    // The run settled — the active-owner binding rejects by design…
    await expect(registry.getSessionBinding("child-session-9")).rejects.toMatchObject({ code: "stale-binding" });
    // …but durable ownership still resolves from the catalog record.
    expect(await registry.resolveSessionOwner("child-session-9")).toEqual({
      owningScopeId: WORKSPACE,
      threadId: thread.id,
      runId: run.id,
      owner: "spawned-child",
    });
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect(await registry.resolveSessionOwner("child-session-9")).toEqual({
      owningScopeId: WORKSPACE,
      threadId: thread.id,
      runId: run.id,
      owner: "spawned-child",
    });
    expect(await registry.resolveSessionOwner("never-seen")).toBeNull();
  });

  it("reuses committed catalog reads while discovering new scopes and retaining explicit corruption checks", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "historical-owner");
    await registry.endRun(WORKSPACE, thread.id, run.id, "success");
    await registry.dispose();

    const observedRead = vi.fn(fs.promises.readFile);
    const observedDirectory = vi.fn(fs.promises.readdir);
    registry = createThreadRegistry({
      dataDir, hostId: "test-host",
      fsPromises: {
        ...fs.promises,
        readFile: observedRead as typeof fs.promises.readFile,
        // vi.fn retains the implementation but exposes only its last overload.
        readdir: observedDirectory as unknown as typeof fs.promises.readdir,
      },
    });
    expect(await registry.resolveSessionOwner("historical-owner")).toMatchObject({ threadId: thread.id });
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    observedRead.mockClear();
    observedDirectory.mockClear();
    const owners = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      registry.resolveSessionOwner(index % 2 ? "historical-owner" : "ordinary-root")));
    expect(owners[0]).toBeNull();
    expect(owners[1]).toMatchObject({ threadId: thread.id, runId: run.id });
    expect(observedRead.mock.calls.filter(([file]) => String(file) === path)).toHaveLength(0);
    expect(observedDirectory).toHaveBeenCalledTimes(1);

    const lateScope = "workspace-late";
    const latePath = threadCatalogPath(dataDir, "test-host", lateScope);
    await writeFile(latePath, "{broken", "utf8");
    expect(await registry.listWorkspaceIds()).not.toContain(lateScope);
    await expect(registry.listWorkspaceThreads(lateScope)).rejects.toMatchObject({ code: "corrupt" });
    await writeFile(latePath, JSON.stringify({
      schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION, scopeId: lateScope, threads: [], runs: [],
    }), "utf8");
    expect(await registry.listWorkspaceIds()).toContain(lateScope);

    // Discovery preserves the live writer's committed generation, as before;
    // restart reconciliation remains a fresh disk check even for cached scopes.
    await writeFile(path, "{broken", "utf8");
    expect(await registry.resolveSessionOwner("historical-owner")).toMatchObject({ threadId: thread.id });
    const reconciled = await registry.reconcileAfterHostRestart();
    expect(reconciled.failures).toEqual([expect.objectContaining({ code: "corrupt", path })]);
  });

  it("keeps indexed snapshots detached and replaces run and owner lookups after commits and deletion", async () => {
    const thread = await registry.createThread(createInput({ tools: ["read"] }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "first-owner");
    await registry.endRun(WORKSPACE, thread.id, first.id, "success");
    const snapshot = await registry.getThreadSnapshot(WORKSPACE, thread.id);
    snapshot!.thread.manifest.tools.push("caller-only");
    snapshot!.activeRun!.tokens.input = 999;
    expect((await registry.getThreadSnapshot(WORKSPACE, thread.id))?.thread.manifest.tools).toEqual(["read"]);
    expect((await registry.getActiveRun(WORKSPACE, thread.id))?.tokens.input).toBe(0);
    expect(await registry.resolveSessionOwner("first-owner")).toMatchObject({ runId: first.id });

    const second = await registry.startRun(WORKSPACE, thread.id, "pi", { allowSettled: true });
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "second-owner");
    expect((await registry.listThreadSnapshots(WORKSPACE, PARENT))[0]?.activeRun?.id).toBe(second.id);
    expect(await registry.getThreadForSession(WORKSPACE, "second-owner")).toMatchObject({ id: thread.id });
    const runs = await registry.listRuns(WORKSPACE, thread.id);
    expect(runs.map((run) => run.id)).toEqual([first.id, second.id]);
    runs[0]!.attempt = 99;
    expect((await registry.listRuns(WORKSPACE, thread.id))[0]?.attempt).toBe(1);
    expect(await registry.resolveSessionOwner("second-owner")).toMatchObject({ runId: second.id });

    await registry.endRun(WORKSPACE, thread.id, second.id, "success");
    await registry.removeThread(WORKSPACE, PARENT, thread.id);
    expect(await registry.getThreadSnapshot(WORKSPACE, thread.id)).toBeNull();
    expect(await registry.listRuns(WORKSPACE, thread.id)).toEqual([]);
    expect(await registry.listWorkspaceThreadSnapshots(WORKSPACE)).toEqual([]);
    expect(await registry.resolveSessionOwner("first-owner")).toBeNull();
    expect(await registry.resolveSessionOwner("second-owner")).toBeNull();
  });

  it("HR0: a session-owned catalog persists and reloads under a filename-safe scope key", async () => {
    const scope = "session:chat-no-project";
    const parent: ThreadParent = { kind: "session", id: "chat-no-project" };
    const thread = await registry.createThread(createInput({ scopeId: scope, parent }));
    const run = await registry.startRun(scope, thread.id);
    await registry.markRunRunning(scope, thread.id, run.id, "chat-no-project");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect(await registry.getThread(scope, parent, thread.id)).toMatchObject({ id: thread.id });
    expect(await registry.resolveSessionOwner("chat-no-project")).toMatchObject({
      owningScopeId: scope,
      threadId: thread.id,
    });
    // The persisted file name never embeds the raw `session:` scope id.
    const catalogDir = join(dataDir, "threads", "test-host");
    for (const name of fs.readdirSync(catalogDir)) expect(name).not.toContain(":");
  });
});
