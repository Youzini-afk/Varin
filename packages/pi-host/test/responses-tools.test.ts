import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, validateToolArguments, type Model } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { HarnessRequestData } from "@varin/protocol";
import { HostServicesBridge } from "../src/harness/host-services-bridge.js";
import { createDispatchTool } from "../src/harness/thread-tools.js";
import { createDocumentReadTool } from "../src/harness/document-read-tool.js";
import { createWebFetchTool } from "../src/harness/webfetch-tool.js";
import { createHistoryTool } from "../src/harness/history-tool.js";

test("Responses keeps minimal tool calls optional through provider conversion and execution", async () => {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({ sessionId: "session", emit: (_event, request) => {
    requests.push(request);
    const result = request.method === "thread.dispatch"
      ? { text: "started", threadId: "child", queued: false }
      : { status: "ok", finalUrl: "https://example.com", markdown: "readable body" };
    queueMicrotask(() => bridge.respond("session", request.requestId, { ok: true, result }));
  } });
  const cases = [
    { tool: createDispatchTool(bridge, "session", []), args: { task: "Inspect the source" }, method: "thread.dispatch" },
    { tool: createDocumentReadTool(bridge), args: { path: "fixture.pdf", view: "text" }, method: "materials.read" },
    { tool: createWebFetchTool(bridge, "session"), args: { url: "https://example.com" }, method: "web.fetch" },
    { tool: createHistoryTool(bridge), args: {}, method: undefined },
  ];
  try {
    // Exercise the provider's actual request builder too: its compatibility
    // defaults previously removed strict:false before the HTTP request.
    const model: Model<"openai-responses"> = {
      api: "openai-responses", provider: "fixture", id: "fixture", name: "Fixture", baseUrl: "https://example.invalid",
      reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let payload: { tools: Array<{ strict?: boolean }> } | undefined;
    const streamed = await streamResponses(model, normalizeContext({ tools: cases.map(({ tool }) => tool), messages: [] }), {
      apiKey: "fixture-key", fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response", status: "completed", output: [] } })}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    }).result();
    assert.notEqual(streamed.stopReason, "error", streamed.errorMessage);
    assert.equal(payload?.tools.length, cases.length);
    assert.ok(payload?.tools.every((tool) => tool.strict === false));
    // Codex passes null while standard Responses uses the default. Both must
    // preserve omitted selectors rather than asking the server to fill them.
    for (const options of [undefined, { strict: null }]) {
      for (const { tool, args, method } of cases) {
        const [wire] = convertResponsesTools([tool], options);
        assert.equal(wire?.type, "function");
        if (wire?.type !== "function") throw new Error("Expected a function tool");
        assert.equal(wire.strict, false);
        const call = { type: "toolCall" as const, id: "call", name: tool.name, arguments: args };
        const parsed = validateToolArguments({ ...tool, parameters: wire.parameters as typeof tool.parameters }, call);
        const before = requests.length;
        const result = await tool.execute("call", parsed, undefined, undefined, {
          model: { provider: "fixture", id: "current" }, sessionManager: { getBranch: () => [] },
        } as never);
        assert.notEqual(result.isError, true);
        if (method) {
          assert.equal(requests.at(-1)?.method, method);
          const sent = requests.at(-1)!.params;
          assert.ok(sent && typeof sent === "object");
          for (const selector of ["bot", "capability", "artifact", "page", "runId"]) {
            assert.equal(Object.hasOwn(sent, selector), false, `${tool.name} should omit ${selector}`);
          }
        } else assert.equal(requests.length, before, "current history stays in the native session");
      }
    }
  } finally { bridge.dispose(); }
});
