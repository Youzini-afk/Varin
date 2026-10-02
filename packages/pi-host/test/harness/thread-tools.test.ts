import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePresets, resolveResearchCapabilities, type HarnessRequestData } from "@varin/protocol";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createDispatchTool, createSendTool } from "../../src/harness/thread-tools.js";

describe("Native thread dispatch", () => {
  it("uses the current research model for a new dispatch or capability assignment", async () => {
    let request: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({ sessionId: "caller", emit: (_event, data) => {
      request = data as HarnessRequestData;
      queueMicrotask(() => bridge.respond("caller", request!.requestId, { ok: true, result: { text: "started", threadId: "child", queued: false, accepted: true } }));
    } });
    let modelId = "first-choice";
    let enabled = true;
    const options = { getResearchCapabilities: async () => resolveResearchCapabilities({ researchExperimentalDesign: { enabled, providerId: "user", modelId } }) };
    const dispatch = createDispatchTool(bridge, "caller", [], options);
    const send = createSendTool(bridge, "caller", options);
    for (const tool of [dispatch, send]) {
      modelId = `updated-for-${tool.name}`;
      await tool.execute("call", { task: "Compare mechanisms", message: "Compare mechanisms", kind: "request", threadId: "child", capability: "experimental-design" } as never,
        undefined, undefined, {} as never);
      assert.deepEqual((request?.params as { model?: unknown }).model, { providerId: "user", modelId });
    }
    enabled = false;
    request = undefined;
    const result = await dispatch.execute("disabled", { task: "Compare mechanisms", capability: "experimental-design" } as never,
      undefined, undefined, {} as never);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(request, undefined);
  });
  it("passes the current caller model for inheritance instead of a cached startup model", async () => {
    let request: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({ sessionId: "caller", emit: (_event, data) => {
      request = data as HarnessRequestData;
      queueMicrotask(() => bridge.respond("caller", request!.requestId, { ok: true, result: { text: "started", threadId: "child", queued: false } }));
    } });
    const tool = createDispatchTool(bridge, "caller", resolvePresets({}, { providerId: "old", modelId: "startup" }));
    await tool.execute("call", { task: "Implement", preset: "hard-implement" } as never, undefined, undefined,
      { model: { provider: "selected", id: "current" } } as never);
    assert.deepEqual((request?.params as { model?: unknown }).model, { providerId: "selected", modelId: "current" });
  });
  it("lets the Host resolve a custom agent created after this tool's catalog snapshot", async () => {
    let request: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({ sessionId: "caller", emit: (_event, data) => {
      request = data as HarnessRequestData;
      queueMicrotask(() => bridge.respond("caller", request!.requestId, { ok: true, result: { text: "started", threadId: "child", queued: false } }));
    } });
    const result = await createDispatchTool(bridge, "caller", []).execute("call", { task: "Read source", preset: "custom:new-agent" } as never,
      undefined, undefined, { model: { provider: "caller", id: "main" } } as never);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(request?.method, "thread.dispatch");
    assert.equal((request?.params as { preset?: string }).preset, "custom:new-agent");
  });
  it("passes the current model as fallback for a Bot without a model preference", async () => {
    const sessionId = "caller-session";
    let dispatched: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({
      sessionId,
      defaultTimeoutMs: 5_000,
      emit: (_event, data) => {
        dispatched = data as HarnessRequestData;
        queueMicrotask(() => bridge.respond(sessionId, dispatched!.requestId, {
          ok: true,
          result: { text: "consult started", threadId: "consult-1", queued: false },
        }));
      },
    });
    const tool = createDispatchTool(bridge, sessionId, [], {
      getActiveToolNames: () => ["read", "recall", "memory"],
    });
    const result = await tool.execute("call-1", {
      task: "Compare two approaches", kind: "discussion", bot: "bot-1",
    } as never, undefined, undefined, {
      model: { provider: "caller-provider", id: "caller-model" },
    } as never);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(dispatched?.method, "thread.dispatch");
    assert.deepEqual(dispatched?.params, {
      task: "Compare two approaches",
      kind: "discussion",
      bot: "bot-1",
      model: { providerId: "caller-provider", modelId: "caller-model" },
      tools: ["read", "recall", "memory"],
    });
  });
});
