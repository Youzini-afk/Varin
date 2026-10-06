import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadSendService } from "./thread-services.js";
import type { HarnessServiceContext } from "./router.js";

const actorContext = (sessionId: string): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "identity-audit",
    grantedCapabilities: ["control.thread"],
    sessionId,
    workerGeneration: 1,
    workerId: `worker:${sessionId}`,
    workspaceId: "workspace",
  },
  authorizedPaths: [],
  sessionId,
  signal: new AbortController().signal,
  workspaceId: "workspace",
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-message-identity-"));
  const registry = createThreadRegistry({ dataDir, hostId: "identity-audit" });
  const deliver = vi.fn(async () => undefined);
  const service = createThreadSendService({ threadRegistry: registry, threadSendToSession: deliver } as never);
  const create = async (name: string) => {
    const thread = await registry.createThread({
      scopeId: "workspace",
      parent: { kind: "session", id: "root" },
      brief: name,
      kind: "implementation",
      createdBy: "agent",
      concurrency: 4,
      autoRun: true,
      worktree: "isolated",
      tools: ["send", "wait"],
      permissions: {},
    });
    const run = await registry.startRun("workspace", thread.id);
    const sessionId = `session:${name}`;
    await registry.markRunRunning("workspace", thread.id, run.id, sessionId);
    return { thread, sessionId, context: actorContext(sessionId) };
  };
  return {
    registry, deliver, service, create,
    dispose: async () => {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe("directed messages — authenticated identity and replies", () => {
  it("does not let a worker payload impersonate the user", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      await f.service.handle({ threadId: child.thread.id, message: "agent note", from: "user" }, actorContext("root"));
      const received = (await f.registry.getThreadById("workspace", child.thread.id))!.messages!;
      expect(received[0]!.from).toEqual({ kind: "session", id: "root" });
    } finally { await f.dispose(); }
  });

  it("rejects a sibling replying to a request addressed to a different sibling", async () => {
    const f = await fixture();
    try {
      const asker = await f.create("asker");
      const answerer = await f.create("answerer");
      const unrelated = await f.create("unrelated");
      await f.service.handle({
        threadId: answerer.thread.id, message: "inspect the interface", from: "parent-agent",
        kind: "request", requestId: "request-for-answerer",
      }, asker.context);
      await f.registry.setAttention("workspace", asker.thread.id, "thread", { kind: "thread", text: "Waiting for answerer" });
      f.deliver.mockClear();
      await expect(f.service.handle({
        threadId: asker.thread.id, message: "not my request", from: "parent-agent",
        replyTo: "request-for-answerer",
      }, unrelated.context)).rejects.toMatchObject({ harnessCode: "denied" });
      expect(f.deliver).not.toHaveBeenCalled();
      const after = (await f.registry.getThreadById("workspace", asker.thread.id))!;
      expect(after.waitingFor?.kind).toBe("thread");
      expect(after.messages!.find((message) => message.direction === "out")!.status).toBe("delivered");
    } finally { await f.dispose(); }
  });

  it("does not resolve a dependency when the actual reply could not be delivered", async () => {
    const f = await fixture();
    try {
      const asker = await f.create("asker");
      const answerer = await f.create("answerer");
      await f.service.handle({
        threadId: answerer.thread.id, message: "inspect", from: "parent-agent",
        kind: "request", requestId: "request-delivery",
      }, asker.context);
      await f.registry.setAttention("workspace", asker.thread.id, "thread", { kind: "thread", text: "Waiting for answerer" });
      f.deliver.mockRejectedValueOnce(new Error("worker transport unavailable"));
      await expect(f.service.handle({
        threadId: asker.thread.id, message: "the answer", from: "parent-agent", replyTo: "request-delivery",
      }, answerer.context)).rejects.toThrow("worker transport unavailable");
      const askerNow = (await f.registry.getThreadById("workspace", asker.thread.id))!;
      const answererNow = (await f.registry.getThreadById("workspace", answerer.thread.id))!;
      expect(askerNow.messages!.find((message) => message.direction === "out")!.status).toBe("delivered");
      expect(answererNow.messages!.find((message) => message.direction === "in")!.status).toBe("delivered");
      expect(askerNow.waitingFor?.kind).toBe("thread");
    } finally { await f.dispose(); }
  });

  it("rejects reuse of an idempotency key with a different message", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      const input = { threadId: child.thread.id, message: "first", from: "parent-agent" as const, requestId: "stable-id" };
      await f.service.handle(input, actorContext("root"));
      await expect(f.service.handle({ ...input, message: "different work" }, actorContext("root")))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it("keeps a trusted UI sender distinct from worker-supplied labels", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      await f.service.handle({ threadId: child.thread.id, message: "user note", from: "parent-agent" }, {
        ...actorContext("root"), requestSource: "user",
      });
      expect((await f.registry.getThreadById("workspace", child.thread.id))!.messages![0]!.from)
        .toEqual({ kind: "user", id: "root" });
    } finally { await f.dispose(); }
  });

  it("delivers concurrent retries of the same active message once", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      const input = {
        threadId: child.thread.id, message: "one operation", from: "parent-agent" as const,
        kind: "request" as const, requestId: "concurrent-retry",
      };
      const results = await Promise.all(Array.from({ length: 4 }, () => f.service.handle(input, actorContext("root"))));
      expect(f.deliver).toHaveBeenCalledTimes(1);
      expect(new Set(results.map((result) => result.messageId)).size).toBe(1);
    } finally { await f.dispose(); }
  });

  it("retains retry identity after more than 64 completed messages", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      const input = { threadId: child.thread.id, message: "first", from: "parent-agent" as const, requestId: "old-retry" };
      await f.service.handle(input, actorContext("root"));
      for (let i = 0; i < 66; i++) {
        await f.service.handle({ ...input, message: `note ${i}`, requestId: `later-${i}` }, actorContext("root"));
      }
      f.deliver.mockClear();
      await f.service.handle(input, actorContext("root"));
      expect(f.deliver).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("binds continue/fresh to the idempotency key", async () => {
    const f = await fixture();
    try {
      const child = await f.create("child");
      const input = {
        threadId: child.thread.id, message: "next task", from: "parent-agent" as const,
        kind: "request" as const, requestId: "run-policy",
      };
      await f.service.handle(input, actorContext("root"));
      await expect(f.service.handle({ ...input, context: "fresh" }, actorContext("root")))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it("accepts replies to notifications without turning them into requests or waking unrelated waits", async () => {
    const f = await fixture();
    try {
      const sender = await f.create("sender");
      const receiver = await f.create("receiver");
      await f.service.handle({
        threadId: receiver.thread.id, message: "fyi", from: "parent-agent", requestId: "plain-note",
      }, sender.context);
      f.deliver.mockClear();
      const reply = await f.service.handle({ message: "received", replyTo: "plain-note" }, receiver.context);
      expect(reply).toMatchObject({ accepted: true, delivery: "delivered", to: { kind: "thread", id: sender.thread.id } });
      expect(f.deliver).toHaveBeenCalledOnce();
      const messages = (await f.registry.getThreadById("workspace", sender.thread.id))!.messages!;
      expect(messages.find((message) => message.id === "plain-note")).toMatchObject({ kind: "inform", status: "delivered" });
      expect(messages.find((message) => message.id === reply.messageId)).toMatchObject({
        kind: "inform", replyTo: "plain-note", from: { kind: "thread", id: receiver.thread.id }, status: "delivered",
      });

      await f.registry.setAttention("workspace", sender.thread.id, "thread", { kind: "thread", text: "Waiting for other work" });
      f.deliver.mockClear();
      const held = await f.service.handle({ message: "more information", replyTo: "plain-note" }, receiver.context);
      expect(held).toMatchObject({ accepted: true, delivery: "held" });
      expect(f.deliver).not.toHaveBeenCalled();
      expect((await f.registry.getThreadById("workspace", sender.thread.id))!.waitingFor?.kind).toBe("thread");
    } finally { await f.dispose(); }
  });
});
