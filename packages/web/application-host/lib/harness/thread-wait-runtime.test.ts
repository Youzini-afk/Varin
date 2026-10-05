import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadWaitRuntime } from "./thread-wait-runtime.js";
import { createThreadWaitService } from "./thread-services.js";

it("retains an indefinite root wait across restart and resumes once on a real dependency result", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-dependency-wait-"));
  let waitRuntime: ReturnType<typeof createThreadWaitRuntime> | undefined;
  let armed!: () => void;
  const arm = new Promise<void>(resolve => { armed = resolve; });
  let registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => {
    if (thread.dependencyWait) armed();
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
    expect((await registry.getThreadById("workspace", root.id))?.dependencyWait?.deadline).toBeUndefined();
    signal.abort(); await pending;
    await registry.endRun("workspace", root.id, rootRun.id, "lost", "Host restarted");
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "host", onThreadChanged: (scope, _parent, thread, run) => waitRuntime?.observe(scope, thread, run) });
    await registry.reconcileAfterHostRestart();
    let resumed!: () => void;
    const completed = new Promise<void>(resolve => { resumed = resolve; });
    const resume = vi.fn(async (_scope, thread) => {
      await registry.admitRun("workspace", thread.id, "pi", { allowSettled: true, sessionOwner: "attached-root" });
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
    expect((await registry.getThreadById("workspace", root.id))?.dependencyWait).toBeUndefined();
  } finally { await waitRuntime?.dispose(); await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});
