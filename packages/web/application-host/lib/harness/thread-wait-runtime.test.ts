import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadWaitRuntime } from "./thread-wait-runtime.js";
import { createThreadSendService, createThreadWaitService } from "./thread-services.js";

it("retains an indefinite root wait across restart and resumes once on a real dependency result", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-dependency-wait-"));
  let waitRuntime: ReturnType<typeof createThreadWaitRuntime> | undefined;
  let armed!: () => void;
  const arm = new Promise<void>(resolve => { armed = resolve; });
  let registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => {
    if (thread.dependencyWaits) armed();
    waitRuntime?.observe(scope, thread, run);
  } });
  const parent = { kind: "session", id: "main" } as const;
  try {
    const root = await registry.createThread({ scopeId: "workspace", parent, brief: "Overall implementation", kind: "discussion", purpose: "agent-root",
      createdBy: "user", concurrency: 2, autoRun: false, worktree: "none", tools: ["wait"], permissions: {} });
    const rootRun = await registry.startRun("workspace", root.id);
    await registry.markRunRunning("workspace", root.id, rootRun.id, "main");
    const child = await registry.createThread({ scopeId: "workspace", parent: { kind: "thread", id: root.id }, brief: "Independent work",
      kind: "implementation", createdBy: "agent", concurrency: 2, autoRun: false, worktree: "none", tools: [], permissions: {} });
    const signal = new AbortController();
    const pending = createThreadWaitService({ threadRegistry: registry } as never).handle({ ids: [child.id] }, {
      actor: { authorityInstanceId: "host", sessionId: "main", workerId: "worker", workerGeneration: 1, workspaceId: "workspace", grantedCapabilities: ["control.thread"] },
      authorizedPaths: [], sessionId: "main", workspaceId: "workspace", signal: signal.signal,
    }).catch(error => error);
    await arm;
    expect((await registry.getThreadById("workspace", root.id))?.dependencyWaits?.[0]?.deadline).toBeUndefined();
    signal.abort(); await pending;
    await registry.endRun("workspace", root.id, rootRun.id, "lost", "Host restarted");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => waitRuntime?.observe(scope, thread, run) });
    await registry.reconcileAfterHostRestart();
    let resumed!: () => void;
    const completed = new Promise<void>(resolve => { resumed = resolve; });
    const resume = vi.fn(async (_scope, thread) => {
      const admitted = await registry.admitRun("workspace", thread.id, "pi", { allowSettled: true, sessionOwner: "attached-root" });
      await registry.markRunRunning("workspace", thread.id, admitted.run.id, "main");
      resumed();
    });
    waitRuntime = createThreadWaitRuntime({ registry, resume, onError: error => { throw error; } });
    await waitRuntime.reconcile();
    expect(resume).not.toHaveBeenCalled();
    const childRun = await registry.startRun("workspace", child.id);
    await registry.markRunRunning("workspace", child.id, childRun.id, "child");
    await registry.updateRunProgress("workspace", child.id, { steps: 5 });
    expect(resume).not.toHaveBeenCalled();
    await registry.endRun("workspace", child.id, childRun.id, "success");
    await completed;
    await waitRuntime.dispose(); waitRuntime = undefined;
    expect(resume).toHaveBeenCalledTimes(1);
    expect((await registry.getThreadById("workspace", root.id))?.dependencyWaits).toBeUndefined();
    await registry.recordCodeSubmission("workspace", { id: "completed-before-wait", fingerprint: "selected-change", fromThreadId: child.id, toThreadId: root.id,
      branchId: "fixed-code", resultRevision: 1, paths: ["a.ts"], appliedPaths: ["a.ts"], acceptedPaths: ["a.ts"], conflictPaths: [], status: "applied", createdAt: new Date().toISOString() });
    const receipt = await createThreadWaitService({ threadRegistry: registry } as never).handle({ ids: [] }, {
      actor: { authorityInstanceId: "host", sessionId: "main", workerId: "worker", workerGeneration: 1, workspaceId: "workspace", grantedCapabilities: ["control.thread"] },
      authorizedPaths: [], sessionId: "main", workspaceId: "workspace", signal: new AbortController().signal,
    });
    expect(receipt.text).toContain("completed-before-wait");
  } finally { await waitRuntime?.dispose(); await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

it.each(["reply", "deadline"] as const)("restores a correlated reply wait after restart on its %s and keeps late answers", async mode => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-reply-recovery-"));
  let waitRuntime: ReturnType<typeof createThreadWaitRuntime> | undefined;
  let registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => waitRuntime?.observe(scope, thread, run) });
  const context = (sessionId: string, signal = new AbortController().signal) => ({
    actor: { authorityInstanceId: "host", sessionId, workerId: "worker", workerGeneration: 1, workspaceId: "workspace", grantedCapabilities: ["control.thread" as const] },
    authorizedPaths: [], sessionId, workspaceId: "workspace", signal,
  });
  const send = () => createThreadSendService({ threadRegistry: registry, threadSendToSession: vi.fn(async () => {}) } as never);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const root = await registry.createThread({ scopeId: "workspace", parent: { kind: "session", id: "main" }, brief: "Overall task", kind: "discussion", purpose: "agent-root",
      createdBy: "user", concurrency: 3, autoRun: false, worktree: "none", tools: ["send"], permissions: {} });
    const rootRun = await registry.startRun("workspace", root.id);
    await registry.markRunRunning("workspace", root.id, rootRun.id, "main");
    const peer = await registry.createThread({ scopeId: "workspace", parent: { kind: "thread", id: root.id }, brief: "Answerer", kind: "implementation",
      createdBy: "agent", concurrency: 3, autoRun: false, worktree: "none", tools: ["send"], permissions: {} });
    const peerRun = await registry.startRun("workspace", peer.id);
    await registry.markRunRunning("workspace", peer.id, peerRun.id, "answerer");
    const signal = new AbortController();
    const pending = send().handle({ threadId: peer.id, kind: "request", from: "parent-agent", message: "What is the result?", requestId: "question", wait: 60 }, context("main", signal.signal)).catch(error => error);
    await vi.waitFor(async () => expect((await registry.getActiveRun("workspace", root.id))?.executionYielded).toBe(true));
    const retained = (await registry.getThreadById("workspace", root.id))!.dependencyWaits![0]!;
    signal.abort(); await pending;
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => waitRuntime?.observe(scope, thread, run) });
    await registry.reconcileAfterHostRestart();
    const continued = await registry.admitRun("workspace", peer.id, "pi", { allowSettled: true });
    await registry.markRunRunning("workspace", peer.id, continued.run.id, "answerer");
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const resume = vi.fn(async (_scope, thread) => {
      const admitted = await registry.admitRun("workspace", thread.id, "pi", { allowSettled: true, sessionOwner: "attached-root" });
      await registry.markRunRunning("workspace", thread.id, admitted.run.id, "main");
      done();
    });
    const errors: unknown[] = [];
    waitRuntime = createThreadWaitRuntime({ registry, resume, onError: error => { errors.push(error); done(); } });
    if (mode === "deadline") clock = vi.spyOn(Date, "now").mockReturnValue(retained.deadline! + 1);
    await waitRuntime.reconcile();
    if (mode === "reply") {
      expect(resume).not.toHaveBeenCalled();
      await send().handle({ threadId: root.id, from: "parent-agent", message: "Progress only" }, context("answerer"));
      expect(resume).not.toHaveBeenCalled();
      await send().handle({ replyTo: "question", from: "parent-agent", message: "The result is 42" }, context("answerer"));
    }
    await completed;
    await waitRuntime.dispose(); waitRuntime = undefined;
    clock?.mockRestore(); clock = undefined;
    expect(errors).toEqual([]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![1].dependencyWaits?.[0]?.replyTo).toBe("question");
    const rootNow = (await registry.getThreadById("workspace", root.id))!;
    expect(rootNow.dependencyWaits).toBeUndefined();
    if (mode === "deadline") {
      expect(rootNow.messages?.find(message => message.id === "question")?.wait?.state).toBe("elapsed");
      await send().handle({ replyTo: "question", from: "parent-agent", message: "Late answer" }, context("answerer"));
    }
    expect((await registry.getThreadById("workspace", root.id))?.messages?.find(message => message.replyTo === "question")?.text)
      .toBe(mode === "deadline" ? "Late answer" : "The result is 42");
  } finally { clock?.mockRestore(); await waitRuntime?.dispose(); await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});
