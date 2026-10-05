import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePresets, resolveResearchCapabilityOptions, type HarnessRequestData } from "@varin/protocol";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createDispatchTool, createSendTool } from "../../src/harness/thread-tools.js";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionHost } from "../../src/session-host.js";
import { createHarnessEmit } from "../harness-emit.js";
import { PiRuntimeBroker } from "../../../runtime-broker/src/runtime-broker.js";

describe("Native thread dispatch", () => {
  it("finishes a nonblocking question turn and delivers a later answer through the native session only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-question-session-"));
    const faux = fauxProvider();
    const model = faux.getModel();
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage([fauxToolCall("ask_question", { question: "What is the project name?", type: "input" })]); },
      () => { calls++; return fauxAssistantMessage("I will continue the independent work."); },
      (context) => { calls++; assert.ok(JSON.stringify(context.messages).includes("QUESTION_LATE_RESPONSE_OK")); return fauxAssistantMessage("The user answer is available."); },
    ]);
    const harness = createHarnessEmit({});
    const host = new SessionHost({ agentDir: root, emit: harness.emit, projectTrustOverride: true, configureServices: async services => {
      services.modelRuntime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple, api: model.api, baseUrl: model.baseUrl,
        models: [{ api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, cost: model.cost, id: model.id, input: model.input, maxTokens: model.maxTokens, name: model.name, reasoning: model.reasoning }] });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    } });
    harness.bind(host); host.setHarnessThreadRuntimeEnabled(true);
    try {
      const session = await host.create(root);
      assert.match(host.session.systemPrompt.match(/<tools>([\s\S]*?)<\/tools>/)?.[1] ?? "", /submit_code/);
      await host.prompt(session.sessionId, "Proceed and ask for the name without stopping.");
      await host.session.waitForIdle();
      assert.equal(calls, 2);
      const pending = host.snapshot().questions![0]!;
      await host.close(session.sessionId);
      const input = { requestId: pending.id, value: [{ id: pending.questions[0]!.id, value: "QUESTION_LATE_RESPONSE_OK" }] };
      let continuation: { messageId: string; text: string } | undefined;
      const broker = new PiRuntimeBroker({ agentDir: root, hostEntry: resolve(import.meta.dirname, "../../src/main.ts"),
        execArgv: ["--import", import.meta.resolve("tsx")], projectTrustOverride: true,
        client: { clientName: "question-continuation-test", clientVersion: "0.1.0", mode: "test" } });
      broker.setQuestionContinuation(async (_sessionId, reply) => { continuation = reply; return true; });
      try {
        assert.equal(await broker.respondToExtensionUi(session.sessionId, input), true);
        const first = continuation;
        assert.equal(await broker.respondToExtensionUi(session.sessionId, input), true);
        assert.deepEqual(continuation, first);
        assert.deepEqual(broker.activeSessionIds, []);
      } finally { await broker.dispose(); }
      assert.ok(continuation);
      await host.open({ sessionFile: session.sessionFile! });
      await host.requestThreadMessage(session.sessionId, continuation.messageId, continuation.text);
      await host.session.waitForIdle();
      assert.equal(calls, 3);
      const completed = host.session.messages.findLast(message => message.role === "assistant");
      assert.equal(completed?.stopReason, "stop");
      assert.match(JSON.stringify(completed?.content), /The user answer is available/);
      assert.equal((await host.requestThreadMessage(session.sessionId, continuation.messageId, continuation.text)).alreadyDelivered, true);
      assert.equal(calls, 3);
      assert.equal(host.snapshot().questions?.length, 0);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("uses the current research model for a new dispatch or capability assignment", async () => {
    let request: HarnessRequestData | undefined;
    const lastRequest = (): HarnessRequestData | undefined => request;
    const bridge = new HostServicesBridge({ sessionId: "caller", emit: (_event, data) => {
      request = data as HarnessRequestData;
      queueMicrotask(() => bridge.respond("caller", request!.requestId, { ok: true, result: { text: "started", threadId: "child", queued: false, accepted: true } }));
    } });
    let modelId = "first-choice";
    let enabled = true;
    let configured = true;
    const options = { getResearchCapabilities: async () => resolveResearchCapabilityOptions({
      researchExperimentalDesign: configured ? { enabled, providerId: "user", modelId } : { enabled },
    }) };
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
    for (const tool of [dispatch, send]) {
      const result = await tool.execute("disabled", { task: "Compare mechanisms", message: "Compare mechanisms", kind: "request", threadId: "child",
        capability: "experimental-design", model: "inherit" } as never,
        undefined, undefined, { model: { provider: "caller", id: "main" } } as never);
      assert.equal((result as { isError?: boolean }).isError, true);
      assert.equal(request, undefined);
    }
    enabled = true;
    configured = false;
    for (const tool of [dispatch, send]) {
      const result = await tool.execute("inherit", { task: "Compare mechanisms", message: "Compare mechanisms", kind: "request", threadId: "child",
        capability: "experimental-design", model: "inherit" } as never,
        undefined, undefined, { model: { provider: "caller", id: "main" } } as never);
      assert.equal((result as { isError?: boolean }).isError, undefined);
      assert.deepEqual((lastRequest()?.params as { model?: unknown }).model,
        tool.name === "send" ? "inherit" : { providerId: "caller", modelId: "main" });
    }
  });
  it("passes the current caller model for inheritance instead of a cached startup model", async () => {
    let request: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({ sessionId: "caller", emit: (_event, data) => {
      request = data as HarnessRequestData;
      queueMicrotask(() => bridge.respond("caller", request!.requestId, { ok: true, result: { text: "started", threadId: "child", queued: false } }));
    } });
    const tool = createDispatchTool(bridge, "caller", resolvePresets({}, { providerId: "old", modelId: "startup" }));
    await tool.execute("call", { task: "Implement", preset: "worker" } as never, undefined, undefined,
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
