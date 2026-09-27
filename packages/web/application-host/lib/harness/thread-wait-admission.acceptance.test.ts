import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadSendService, createThreadWaitService } from "./thread-services.js";
import type { HarnessServiceContext } from "./router.js";

const workspaceId = "audit-workspace";
const root = { kind: "session" as const, id: "root-session" };
const fixture = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "varin-wait-admission-"));
  const registry = createThreadRegistry({ dataDir, hostId: "audit-host" });
  const base = { scopeId: workspaceId, brief: "audit work", kind: "implementation" as const,
    createdBy: "agent" as const, concurrency: 1, autoRun: true, worktree: "isolated" as const,
    tools: ["read", "wait", "send", "dispatch"], permissions: {} };
  const owner = await registry.createThread({ ...base, parent: root });
  const run = await registry.startRun(workspaceId, owner.id);
  await registry.markRunRunning(workspaceId, owner.id, run.id, "owner-session");
  const child = await registry.createThread({ ...base, parent: { kind: "thread", id: owner.id }, autoRun: false });
  const controller = new AbortController();
  const context: HarnessServiceContext = {
    actor: { authorityInstanceId: "audit-host", grantedCapabilities: ["control.thread"],
      sessionId: "owner-session", workerGeneration: 1, workerId: "owner-worker", workspaceId },
    authorizedPaths: [], sessionId: "owner-session", signal: controller.signal, workspaceId,
  };
  const sendToSession = vi.fn(async () => undefined);
  const host = { threadRegistry: registry, threadSendToSession: sendToSession };
  const wait = createThreadWaitService(host as never);
  return { registry, owner, run, child, context, controller, sendToSession,
    send: createThreadSendService(host as never), wait,
    startChild: async () => {
      const childRun = await registry.startRun(workspaceId, child.id);
      await registry.markRunRunning(workspaceId, child.id, childRun.id, "child-session");
      return childRun;
    },
    yielded: async () => vi.waitFor(async () => {
      expect((await registry.getActiveRun(workspaceId, owner.id))?.executionYielded).toBe(true);
    }),
    dispose: async () => { controller.abort(); await registry.dispose(); rmSync(dataDir, { force: true, recursive: true }); },
  };
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("real dependency wait admission", () => {
  it("does not wake on child startup/progress or resume two Runs with one slot", async () => {
    const f = await fixture();
    let returned = false;
    const pending = f.wait.handle({ ids: [f.child.id], timeoutMs: 2_000 }, f.context)
      .then((result) => { returned = true; return result; });
    try {
      await f.yielded();
      const childRun = await f.startChild();
      await f.registry.updateRunProgress(workspaceId, f.child.id, { steps: 3 });
      await delay(35);
      expect(returned).toBe(false);
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
      await f.registry.endRun(workspaceId, f.child.id, childRun.id, "success");
      const result = await pending;
      expect(result.timedOut).toBe(false);
      expect(result.done).toBe(1);
      expect((await f.registry.getActiveRun(workspaceId, f.owner.id))?.executionYielded).toBe(false);
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
    } finally { await f.dispose(); await pending.catch(() => undefined); }
  });

  it("a dependency timeout cannot reclaim a slot still used by a child", async () => {
    const f = await fixture();
    let returned = false;
    const pending = f.wait.handle({ ids: [f.child.id], timeoutMs: 120 }, f.context)
      .then((result) => { returned = true; return result; });
    try {
      await f.yielded();
      const childRun = await f.startChild();
      await delay(150);
      expect(returned).toBe(false);
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
      await f.registry.endRun(workspaceId, f.child.id, childRun.id, "success");
      expect((await pending).timedOut).toBe(true);
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
    } finally { await f.dispose(); await pending.catch(() => undefined); }
  });

  it("ordinary inform and cosmetic attention changes do not wake or reacquire", async () => {
    const f = await fixture();
    const pending = f.wait.handle({ ids: [f.child.id], timeoutMs: 180 }, f.context);
    try {
      await f.yielded();
      const rootContext = { ...f.context, sessionId: root.id,
        actor: { ...f.context.actor, sessionId: root.id, workerId: "root-worker" } };
      await f.send.handle({ threadId: f.owner.id, kind: "inform", message: "For later, not a new task.",
        requestId: "ordinary-note", from: "parent-agent" }, rootContext);
      await f.registry.setAttention(workspaceId, f.owner.id, "none");
      // The inform must be durably held for the next input boundary, not
      // delivered mid-wait. Once that record exists the wait can only finish
      // through its own deadline or a real dependency change.
      await vi.waitFor(async () => {
        const owner = await f.registry.getThreadById(workspaceId, f.owner.id);
        expect(owner?.messages?.some((message) => message.id === "ordinary-note" && message.status === "held")).toBe(true);
      });
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(0);
      expect(f.sendToSession).not.toHaveBeenCalled();
      expect((await pending).timedOut).toBe(true);
      expect(f.sendToSession).toHaveBeenCalledOnce();
    } finally { await f.dispose(); await pending.catch(() => undefined); }
  });

  it("cancellation while reacquiring preserves the occupied child slot", async () => {
    const f = await fixture();
    const pending = f.wait.handle({ ids: [f.child.id], timeoutMs: 120 }, f.context);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await f.yielded();
      const childRun = await f.startChild();
      await delay(150);
      f.controller.abort();
      await rejected;
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
      expect((await f.registry.getActiveRun(workspaceId, f.owner.id))?.executionYielded).toBe(true);
      await f.registry.endRun(workspaceId, f.child.id, childRun.id, "success");
    } finally { await f.dispose(); await pending.catch(() => undefined); }
  });

  it("parallel reacquisition is atomic and never admits both contenders", async () => {
    const f = await fixture();
    try {
      await f.registry.yieldExecutionSlot(workspaceId, f.owner.id, f.run.id, { kind: "thread", text: "blocked" });
      const childRun = await f.startChild();
      await f.registry.yieldExecutionSlot(workspaceId, f.child.id, childRun.id, { kind: "thread", text: "blocked" });
      const admitted: string[] = [];
      const one = f.registry.awaitExecutionSlot(workspaceId, f.owner.id, f.run.id, f.context.signal)
        .then(() => { admitted.push(f.owner.id); });
      const two = f.registry.awaitExecutionSlot(workspaceId, f.child.id, childRun.id, f.context.signal)
        .then(() => { admitted.push(f.child.id); });
      await vi.waitFor(() => expect(admitted).toHaveLength(1));
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
      const first = admitted[0]!;
      await f.registry.endRun(workspaceId, first, first === f.owner.id ? f.run.id : childRun.id, "success");
      await Promise.all([one, two]);
      expect(admitted).toHaveLength(2);
      expect(await f.registry.countActiveInRoot(workspaceId, root)).toBe(1);
    } finally { await f.dispose(); }
  });
});
