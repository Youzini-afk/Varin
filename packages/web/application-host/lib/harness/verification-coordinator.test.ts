import { describe, expect, it, vi } from "vitest";
import type { HarnessActorIdentity } from "@varin/protocol";
import { createVerificationCoordinator, type CapturedVerificationIdentity } from "./verification-coordinator.js";
import type { ParentVerificationBundle, ResultReviewRecord, ResultVerificationBundle } from "./working-state/types.js";
import type { WorkingStateStore } from "./working-state/working-state-store.js";
import { asTestWorkingStateRootAccess, asTestWorkingStateRootStore, type TestWorkspaceWorkingStateAccess } from "./working-state/working-state-root-adapter.test-helper.js";

const ACTOR: HarnessActorIdentity = {
  authorityInstanceId: "host-1", sessionId: "child-1", workerId: "worker-1", workerGeneration: 1, runId: "run-1",
};

const memoryStore = (resultTrees: Record<number, string> = {}, publicationTimes: Record<number, number> = {}) => {
  const child = new Map<string, ResultVerificationBundle[]>();
  const parent = new Map<string, ParentVerificationBundle[]>();
  const reviews = new Map<string, ResultReviewRecord[]>();
  const store = {
    getResult: (branchId: string, revision: number) => resultTrees[revision]
      ? { branchId, resultRevision: revision, root: resultTrees[revision], createdAt: new Date(publicationTimes[revision] ?? Date.now() + 10_000).toISOString() }
      : null,
    resultTreeIdentity: (_branchId: string, revision: number) => resultTrees[revision] ?? null,
    getChildVerification: (threadId: string, revision: number) => child.get(threadId)?.find((item) => item.resultRevision === revision) ?? null,
    listChildVerifications: (threadId: string) => child.get(threadId) ?? [],
    getParentVerification: (threadId: string, revision?: number) => {
      const list = parent.get(threadId) ?? [];
      return revision === undefined
        ? list.reduce<ParentVerificationBundle | null>((latest, item) => !latest
          || (item.windowOpenedAt ?? item.recordedAt) >= (latest.windowOpenedAt ?? latest.recordedAt) ? item : latest, null)
        : list.find((item) => item.mergedResultRevision === revision) ?? null;
    },
    listParentVerifications: (threadId: string) => parent.get(threadId) ?? [],
    getReviewRecord: (threadId: string, revision: number) => reviews.get(threadId)?.find((item) => item.resultRevision === revision) ?? null,
    listReviewRecords: (threadId: string) => reviews.get(threadId) ?? [],
    putChildVerification: async (threadId: string, bundle: ResultVerificationBundle) => {
      child.set(threadId, [...(child.get(threadId) ?? []).filter((item) => item.resultRevision !== bundle.resultRevision), bundle]);
    },
    putParentVerification: async (threadId: string, bundle: ParentVerificationBundle) => {
      parent.set(threadId, [...(parent.get(threadId) ?? []).filter((item) => item.mergedResultRevision !== bundle.mergedResultRevision), bundle]);
    },
    putReviewRecord: async (threadId: string, record: ResultReviewRecord) => {
      reviews.set(threadId, [...(reviews.get(threadId) ?? []).filter((item) => item.resultRevision !== record.resultRevision), record]);
    },
  } as unknown as WorkingStateStore;
  const legacyAccess: TestWorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, {} as never),
  };
  const access = asTestWorkingStateRootAccess(legacyAccess);
  return { store, access };
};

const attachChild = (
  coordinator: ReturnType<typeof createVerificationCoordinator>,
  actor: HarnessActorIdentity,
  runId: string,
  captureIdentity: () => Promise<CapturedVerificationIdentity>,
) => {
  coordinator.attachParentSession(actor.sessionId, {
    workspaceId: "ws", parentRoot: "/ws", parentSessionId: actor.sessionId, actor,
  });
  coordinator.attachThreadSession(actor.sessionId, {
    workspaceId: "ws", threadId: "thread-a", runId, worktreePath: "/ws/thread", branchId: "thread-a", captureIdentity,
  });
};

const lifecycle = async (
  coordinator: ReturnType<typeof createVerificationCoordinator>,
  input: { actor?: HarnessActorIdentity; id: string; command?: string; cwd?: string; startedAt?: number },
) => {
  const actor = input.actor ?? ACTOR;
  const startedAt = input.startedAt ?? Date.now();
  const common = {
    actor, executionId: input.id, commandRunId: `shell-${input.id}`, command: input.command ?? "bun test",
    cwd: input.cwd ?? "/ws/thread", startedAt,
  };
  await coordinator.beginCommand(common);
  await coordinator.completeCommand({ ...common, endedAt: Math.max(startedAt, Date.now()), exitCode: 0, cancelled: false, outputPreview: "ok" });
};

describe("verification coordinator", () => {
  it("marks a command uncertain when its observed input changes during the process", async () => {
    const { store } = memoryStore({ 1: "tree-after" });
    const hashes = ["tree-before", "tree-after"];
    const coordinator = createVerificationCoordinator();
    attachChild(coordinator, ACTOR, "run-1", async () => ({ treeHash: hashes.shift() ?? null }));
    await lifecycle(coordinator, { id: "changed" });
    const projection = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(projection.childChecks).toMatchObject({ binding: "uncertain", allExitedZero: null });
    expect(projection.childChecks?.commands[0]).toMatchObject({ relation: "uncertain", inputChanged: true, exitCode: 0 });
  });

  it("binds an exact observed tree once and never rebinds the command to a later publish", async () => {
    const { store } = memoryStore({ 1: "tree-1", 2: "tree-2" });
    const coordinator = createVerificationCoordinator();
    attachChild(coordinator, ACTOR, "run-1", async () => ({ treeHash: "tree-1" }));
    await lifecycle(coordinator, { id: "once" });
    const first = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    const second = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 2, worktreePath: "/ws/thread",
    });
    expect(first.childChecks?.commands).toEqual([expect.objectContaining({ relation: "same-run-matching-result", inputChanged: false })]);
    expect(first.childChecks?.allExitedZero).toBe(true);
    expect(second.childChecks).toMatchObject({ binding: "uncertain", commands: [], allExitedZero: null });
  });

  it("does not attach a background command that completed after an unchanged result was first published", async () => {
    const { store } = memoryStore({ 1: "tree-1" }, { 1: 20 });
    const coordinator = createVerificationCoordinator();
    attachChild(coordinator, ACTOR, "run-1", async () => ({ treeHash: "tree-1" }));
    const event = {
      actor: ACTOR, executionId: "late", commandRunId: "shell-late", command: "background check", cwd: "/ws/thread", startedAt: 10,
    };
    await coordinator.beginCommand(event);
    const first = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(first.childChecks?.commands).toEqual([]);
    await coordinator.completeCommand({ ...event, endedAt: 30, exitCode: 0, cancelled: false });
    const repeated = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(repeated.childChecks?.commands).toEqual([]);
  });

  it("does not consume another workspace or branch binding", async () => {
    const { store } = memoryStore({ 1: "tree" });
    const coordinator = createVerificationCoordinator();
    attachChild(coordinator, ACTOR, "run-1", async () => ({ treeHash: "tree" }));
    await lifecycle(coordinator, { id: "scoped" });
    const wrong = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "other", threadId: "thread-a", runId: "run-1", branchId: "other-branch", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(wrong.childChecks?.commands).toEqual([]);
    const right = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(right.childChecks?.commands).toHaveLength(1);
  });

  it("clears observations across detach, re-registration, and a new ThreadRun", async () => {
    const { store } = memoryStore({ 1: "tree" });
    const coordinator = createVerificationCoordinator();
    attachChild(coordinator, ACTOR, "run-1", async () => ({ treeHash: "tree" }));
    await coordinator.beginCommand({ actor: ACTOR, executionId: "detached", commandRunId: "shell-old", command: "old", cwd: "/ws/thread", startedAt: 1 });
    const generation2 = { ...ACTOR, workerGeneration: 2 };
    coordinator.revokeSessionActor(generation2.sessionId);
    coordinator.attachParentSession(generation2.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: generation2.sessionId, actor: generation2,
    });
    await coordinator.completeCommand({
      actor: ACTOR, executionId: "detached", commandRunId: "shell-old", command: "old", cwd: "/ws/thread",
      startedAt: 1, endedAt: 2, exitCode: 0, cancelled: false,
    });
    await lifecycle(coordinator, { actor: generation2, id: "re-registered" });
    const rebound = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-1", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(rebound.childChecks?.commands).toEqual([expect.objectContaining({ command: "bun test" })]);
    attachChild(coordinator, { ...generation2, runId: "run-2" }, "run-2", async () => ({ treeHash: "tree" }));
    await lifecycle(coordinator, { actor: { ...generation2, runId: "run-2" }, id: "old-run" });
    coordinator.attachThreadSession(generation2.sessionId, {
      workspaceId: "ws", threadId: "thread-a", runId: "run-3", worktreePath: "/ws/thread", branchId: "thread-a",
      captureIdentity: async () => ({ treeHash: "tree" }),
    });
    const projection = await coordinator.bindPublishedResult(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", threadId: "thread-a", runId: "run-3", branchId: "thread-a", resultRevision: 1, worktreePath: "/ws/thread",
    });
    expect(projection.childChecks?.commands).toEqual([]);
  });

  it("records only post-merge commands from the exact parent session and restores a persisted window", async () => {
    const { store, access } = memoryStore({ 1: "child" });
    const parentIdentity: CapturedVerificationIdentity = { treeHash: "parent-after-merge" };
    const onProjection = vi.fn();
    const coordinator = createVerificationCoordinator({
      workingStates: access,
      captureParentIdentity: async () => parentIdentity,
      loadParentWindows: async (_workspaceId, parentSessionId) => {
        const bundle = store.getParentVerification("thread-a", 1);
        return parentSessionId === "parent-1" && bundle
          ? [{ parent: { kind: "session" as const, id: "parent-1" }, threadId: "thread-a", bundle }]
          : [];
      },
      onProjection,
    });
    const parentActor = { ...ACTOR, sessionId: "parent-1", runId: "parent-run" };
    coordinator.attachParentSession(parentActor.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: parentActor.sessionId, actor: parentActor,
    });
    await lifecycle(coordinator, { actor: parentActor, id: "before", cwd: "/ws", startedAt: 1 });
    const opened = await coordinator.recordParentMerge(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", parent: { kind: "session", id: "parent-1" }, parentRoot: "/ws", parentSessionId: "parent-1",
      threadId: "thread-a", branchId: "thread-a", mergedResultRevision: 1, mergeOperationId: "merge-1", integrated: true, draftUnsaved: false, parentIdentity,
    });
    expect(opened.parentChecks).toMatchObject({ binding: "not-recorded", mergeOperationId: "merge-1", commands: [] });
    const otherActor = { ...parentActor, sessionId: "parent-2" };
    coordinator.attachParentSession(otherActor.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: otherActor.sessionId, actor: otherActor,
    });
    await lifecycle(coordinator, { actor: otherActor, id: "other", cwd: "/ws", startedAt: Date.now() });
    expect(store.getParentVerification("thread-a", 1)?.checks).toEqual([]);

    // Simulate Host restart by using a new coordinator that only sees the persisted bundle.
    const reopened = createVerificationCoordinator({
      workingStates: access,
      captureParentIdentity: async () => parentIdentity,
      loadParentWindows: async () => [{ parent: { kind: "session", id: "parent-1" }, threadId: "thread-a", bundle: store.getParentVerification("thread-a", 1)! }],
      onProjection,
    });
    reopened.attachParentSession(parentActor.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: parentActor.sessionId, actor: parentActor,
    });
    await lifecycle(reopened, { actor: parentActor, id: "after", cwd: "/ws", startedAt: Date.now() });
    expect(store.getParentVerification("thread-a", 1)).toMatchObject({
      binding: "bound", mergeOperationId: "merge-1",
      checks: [expect.objectContaining({ id: "after", relationToPublished: "post-merge-matching-tree" })],
    });
    expect(onProjection).toHaveBeenCalled();
  });

  it("loads persisted windows even after a new in-memory window opens", async () => {
    const { store, access } = memoryStore();
    const parentActor = { ...ACTOR, sessionId: "parent-1", runId: "parent-run" };
    const parentIdentity: CapturedVerificationIdentity = { treeHash: "same-parent-tree" };
    await store.putParentVerification("thread-b", {
      branchId: "thread-b",
      mergedResultRevision: 2,
      mergeOperationId: "merge-b",
      windowOpenedAt: Date.now() - 100,
      recordedAt: Date.now() - 100,
      parentTreeHash: parentIdentity.treeHash!,
      draftUnsaved: false,
      binding: "not-recorded",
      checks: [],
    });
    const coordinator = createVerificationCoordinator({
      workingStates: access,
      captureParentIdentity: async () => parentIdentity,
      loadParentWindows: async () => [{
        parent: { kind: "session", id: "parent-1" },
        threadId: "thread-b",
        bundle: store.getParentVerification("thread-b", 2)!,
      }],
    });
    coordinator.attachParentSession(parentActor.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: parentActor.sessionId, actor: parentActor,
    });
    await coordinator.recordParentMerge(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", parent: { kind: "session", id: "parent-1" }, parentRoot: "/ws", parentSessionId: "parent-1",
      threadId: "thread-a", branchId: "thread-a", mergedResultRevision: 1, mergeOperationId: "merge-a", integrated: true,
      draftUnsaved: false, parentIdentity,
    });

    await lifecycle(coordinator, { actor: parentActor, id: "shared-check", cwd: "/ws", startedAt: Date.now() });
    expect(store.getParentVerification("thread-a", 1)?.checks).toHaveLength(1);
    expect(store.getParentVerification("thread-b", 2)?.checks).toHaveLength(1);
  });

  it("drops a parent completion when the actor changes while persisted windows load", async () => {
    const { store, access } = memoryStore();
    const parentActor = { ...ACTOR, sessionId: "parent-1", runId: "parent-run" };
    const replacement = { ...parentActor, workerGeneration: parentActor.workerGeneration + 1 };
    let releaseLoad: () => void = () => undefined;
    let signalLoad: () => void = () => undefined;
    const loadStarted = new Promise<void>((resolve) => { signalLoad = resolve; });
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    await store.putParentVerification("thread-a", {
      branchId: "thread-a",
      mergedResultRevision: 1,
      mergeOperationId: "merge-a",
      windowOpenedAt: 1,
      recordedAt: 1,
      parentTreeHash: "parent-tree",
      draftUnsaved: false,
      binding: "not-recorded",
      checks: [],
    });
    const coordinator = createVerificationCoordinator({
      workingStates: access,
      captureParentIdentity: async () => ({ treeHash: "parent-tree" }),
      loadParentWindows: async () => {
        signalLoad();
        await loadGate;
        return [{
          parent: { kind: "session", id: "parent-1" },
          threadId: "thread-a",
          bundle: store.getParentVerification("thread-a", 1)!,
        }];
      },
    });
    coordinator.attachParentSession(parentActor.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: parentActor.sessionId, actor: parentActor,
    });
    const common = {
      actor: parentActor, executionId: "late-generation", commandRunId: "shell-late", command: "bun test",
      cwd: "/ws", startedAt: 2,
    };
    await coordinator.beginCommand(common);
    const completion = coordinator.completeCommand({ ...common, endedAt: 3, exitCode: 0, cancelled: false });
    await loadStarted;
    coordinator.attachParentSession(replacement.sessionId, {
      workspaceId: "ws", parentRoot: "/ws", parentSessionId: replacement.sessionId, actor: replacement,
    });
    releaseLoad();
    await completion;
    expect(store.getParentVerification("thread-a", 1)?.checks).toEqual([]);
  });

  it("does not open a parent verification window for incomplete integration or an unsaved draft", async () => {
    const { store } = memoryStore();
    const coordinator = createVerificationCoordinator();
    const incomplete = await coordinator.recordParentMerge(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", parent: { kind: "session", id: "parent-1" }, parentRoot: "/ws", parentSessionId: "parent-1",
      threadId: "thread-a", branchId: "thread-a", mergedResultRevision: 1, mergeOperationId: "merge-failed", integrated: false,
      draftUnsaved: false, parentIdentity: { treeHash: null, reason: "conflict" },
    });
    expect(incomplete.parentChecks?.binding).toBe("not-integrated");
    const draft = await coordinator.recordParentMerge(asTestWorkingStateRootStore(store), {
      workspaceId: "ws", parent: { kind: "session", id: "parent-1" }, parentRoot: "/ws", parentSessionId: "parent-1",
      threadId: "thread-a", branchId: "thread-a", mergedResultRevision: 2, mergeOperationId: "merge-draft", integrated: false,
      draftUnsaved: true, parentIdentity: { treeHash: null, reason: "draft" },
    });
    expect(draft.parentChecks).toMatchObject({ binding: "cannot-verify-unsaved-draft", allExitedZero: null });
  });

  it("keeps review identity exact across r1/r10, cancellation, and late completion", async () => {
    const { store } = memoryStore();
    const coordinator = createVerificationCoordinator();
    await coordinator.putReview(asTestWorkingStateRootStore(store), "thread-a", {
      resultRevision: 1, status: "running", recordedAt: 1, reviewThreadId: "review-r1", reviewRunId: "run-r1",
    }, 10, "thread-a");
    await coordinator.putReview(asTestWorkingStateRootStore(store), "thread-a", {
      resultRevision: 10, status: "running", recordedAt: 2, reviewThreadId: "review-r10", reviewRunId: "run-r10",
    }, 10, "thread-a");
    await coordinator.putReview(asTestWorkingStateRootStore(store), "thread-a", {
      resultRevision: 10, status: "cancelled", recordedAt: 3, reviewThreadId: "review-r10", reviewRunId: "run-r10",
    }, 10, "thread-a");
    await coordinator.putReview(asTestWorkingStateRootStore(store), "thread-a", {
      resultRevision: 10, status: "completed", recordedAt: 4, reviewThreadId: "late-other", reviewRunId: "late-other",
    }, 10, "thread-a");
    expect(store.getReviewRecord("thread-a", 1)?.status).toBe("running");
    expect(store.getReviewRecord("thread-a", 10)).toMatchObject({ status: "cancelled", reviewThreadId: "review-r10" });
  });
});
