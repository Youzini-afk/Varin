import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager, convertToLlm, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { attachContextRequestBoundary } from "../../src/harness/context-request-boundary.js";
import { createRequestContextInjector } from "../../src/harness/request-context.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

const MODEL = { provider: "faux", id: "faux-1", api: "openai-completions", contextWindow: 100_000, maxTokens: 400 } as Model<Api>;
const response = (stopReason: "stop" | "error" = "stop"): AssistantMessage => ({
  role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
  content: [{ type: "text", text: "ok" }], stopReason, timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const providerStream = (fail = false) => {
  const stream = createAssistantMessageEventStream();
  if (fail) stream.push({ type: "error", reason: "error", error: response("error") });
  else {
    stream.push({ type: "start", partial: response() });
    stream.push({ type: "done", reason: "stop", message: response() });
  }
  return stream;
};
const session = (stream: StreamFn, model = MODEL, initial = "Investigate this task"): AgentSession => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: initial, timestamp: Date.now() });
  return {
    model, sessionId: manager.getSessionId(), sessionManager: manager,
    agent: { streamFunction: stream, convertToLlm, state: {
      systemPrompt: "stable", tools: [], thinkingLevel: "off", messages: manager.buildSessionContext().messages,
    } },
  } as unknown as AgentSession;
};
const contextFor = (bound: AgentSession): Context => ({
  systemPrompt: "stable", messages: convertToLlm(bound.sessionManager.buildSessionContext().messages),
});
const textOf = (context: Context) => JSON.stringify(context.messages);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("per-request environment and team context", () => {
  it("keeps unchanged teammates on every request, retaining only new environment facts", async () => {
    const calls: string[] = [];
    const outgoing: Context[] = [];
    const bridge = { request: async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === "zone2.status") return { status: "ready", content: '<varin-status>t-1 · investigate · working · reading…</varin-status>' };
      if (method === "zone2.assemble") return params.afterEventId === 7
        ? { content: null, eventCursor: 7 }
        : { content: '<varin-context event-cursor="7">USER_EDIT</varin-context>', eventCursor: 7,
          deliveryId: "delivery-7", observationRefs: ["edit-7"], materialRevisions: { "block:plan": "revision-2" } };
      if (method === "zone2.delivered") return { committed: true };
      throw new Error(method);
    } } as unknown as HostServicesBridge;
    const bound = session(async (_model, context) => { outgoing.push(structuredClone(context)); return providerStream(); });
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
      observe: () => undefined, compact: async () => { throw new Error("unexpected compaction"); },
      inject: createRequestContextInjector(bridge),
    });
    const first = await bound.agent.streamFunction(MODEL, contextFor(bound), {});
    await first.result();
    bound.sessionManager.appendMessage(response());
    bound.sessionManager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
    const second = await bound.agent.streamFunction(MODEL, contextFor(bound), {});
    await second.result();
    await flush();
    assert.equal(calls.filter((method) => method === "zone2.status").length, 2);
    assert.equal(calls.filter((method) => method === "zone2.delivered").length, 1);
    assert.ok(outgoing.every((context) => textOf(context).includes("t-1")));
    assert.equal(outgoing[1]!.messages.filter((message) => JSON.stringify(message).includes("USER_EDIT")).length, 1);
    const branch = bound.sessionManager.getBranch();
    assert.equal(branch.filter((entry) => entry.type === "custom_message").length, 1);
    assert.ok(!JSON.stringify(branch).includes("varin-status"));
    // The prior real history and environment prefix remain in the same order;
    // the old transient table is replaced at the new tail, never in history.
    assert.deepEqual(outgoing[1]!.messages.slice(0, 2).map(({ role, content }) => ({ role, content })),
      outgoing[0]!.messages.slice(0, 2).map(({ role, content }) => ({ role, content })));
    boundary.dispose();
  });

  it("does not retain or acknowledge prepared facts when the provider fails before starting", async () => {
    let confirmed = false;
    const bound = session(async () => providerStream(true));
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
      observe: () => undefined, compact: async () => { throw new Error("unexpected"); },
      inject: async (request) => ({ request, retained: { content: "not sent", details: {} }, confirm: () => { confirmed = true; } }),
    });
    const stream = await bound.agent.streamFunction(MODEL, contextFor(bound), {});
    assert.equal((await stream.result()).stopReason, "error");
    await flush();
    assert.equal(confirmed, false);
    assert.ok(!JSON.stringify(bound.sessionManager.getBranch()).includes("not sent"));
    boundary.dispose();
  });

  it("includes the tail in capacity admission before calling the provider", async () => {
    let dispatched = false;
    const model = { ...MODEL, contextWindow: 120 };
    const bound = session(async () => { dispatched = true; return providerStream(); }, model);
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: false, reserveTokens: 40, keepRecentTokens: 20 }),
      observe: () => undefined, compact: async () => { throw new Error("unexpected"); },
      inject: async (request) => ({ request: { ...request, context: { ...request.context,
        messages: [...request.context.messages, { role: "user", content: "tail ".repeat(300), timestamp: 1 }] } } }),
    });
    await assert.rejects(async () => bound.agent.streamFunction(model, contextFor(bound), {}), /automatic compaction is disabled/);
    assert.equal(dispatched, false);
    boundary.dispose();
  });

  it("rebuilds candidate observations and the current table after compaction", async () => {
    const model = { ...MODEL, contextWindow: 350 };
    const bound = session(async (_model, context) => { assert.ok(textOf(context).includes("CURRENT_TABLE_2")); return providerStream(); }, model, "old detail ".repeat(180));
    bound.sessionManager.appendMessage(response());
    const kept = bound.sessionManager.appendMessage({ role: "user", content: "retain this", timestamp: Date.now() });
    const initial = contextFor(bound);
    let prepared = 0;
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 50, keepRecentTokens: 30 }),
      observe: () => undefined,
      compact: async () => ({ summary: "earlier work", firstKeptEntryId: kept, tokensBefore: 500 }),
      inject: async (request) => ({ request: { ...request, context: { ...request.context,
        messages: [...request.context.messages, { role: "user", content: `CURRENT_TABLE_${++prepared}`, timestamp: 1 }] } } }),
    });
    await (await bound.agent.streamFunction(model, initial, {})).result();
    assert.equal(prepared, 2);
    assert.ok(!JSON.stringify(bound.sessionManager.getBranch()).includes("CURRENT_TABLE"));
    boundary.dispose();
  });

  it("distinguishes unavailable current observations from an empty team without retaining either notice", async () => {
    const bridge = { request: async () => { throw new Error("offline"); } } as unknown as HostServicesBridge;
    const bound = session(async () => providerStream());
    const inject = createRequestContextInjector(bridge);
    const candidate = await inject({ model: MODEL, context: contextFor(bound), options: {}, inputTokens: 0, reserveTokens: 0, needsSpace: false }, bound);
    assert.ok(textOf(candidate!.request!.context).includes('status=\\"unavailable\\"'));
    assert.equal(candidate!.retained, undefined);
  });
});
