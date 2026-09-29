import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createMemoryTool } from "../../src/harness/memory-tools.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessRequestData } from "@varin/protocol";

const SESSION = "session-1";
const isError = (result: unknown) => (result as { isError?: boolean }).isError;

function scriptedBridge(handlers: Record<string, (params: never) => unknown>) {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      const request = data as HarnessRequestData;
      requests.push(request);
      queueMicrotask(() => {
        const handler = handlers[request.method];
        if (!handler) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "unavailable", message: `no handler for ${request.method}` },
          });
          return;
        }
        try {
          bridge.respond(SESSION, request.requestId, { ok: true, result: handler(request.params as never) });
        } catch (error) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    },
    sessionId: SESSION,
    defaultTimeoutMs: 5_000,
  });
  return { bridge, requests };
}

const execute = (tool: ReturnType<typeof createMemoryTool>, params: Record<string, unknown>) =>
  tool.execute("call-1", params as never, undefined, undefined, undefined as never);

describe("memory tool", () => {
  it("remember forwards content, trigger, and nature to the unified service", async () => {
    const { bridge, requests } = scriptedBridge({
      "memory.remember": (params: { content: string; trigger?: string; nature?: string }) => ({
        created: true,
        item: {
          id: 7, scope: "workspace", status: "accepted",
          content: params.content, trigger: params.trigger ?? "", nature: params.nature,
          createdAt: 1, recallCount: 0,
        },
      }),
    });
    const tool = createMemoryTool(bridge, SESSION);
    const result = await execute(tool, {
      action: "remember",
      content: "Deploys run at 14:00",
      trigger: "deploy",
      nature: "decision",
    });
    assert.equal(isError(result), undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "memory.remember");
    assert.deepEqual(requests[0]!.params, {
      content: "Deploys run at 14:00", trigger: "deploy", nature: "decision",
    });
  });

  it("remember without content fails before any host call", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createMemoryTool(bridge, SESSION);
    const result = await execute(tool, { action: "remember" });
    assert.equal(isError(result), true);
    assert.equal(requests.length, 0);
  });

  it("get returns the item and its revision chain", async () => {
    const { bridge, requests } = scriptedBridge({
      "memory.get": () => ({
        item: { id: 9, scope: "workspace", status: "accepted", content: "new", trigger: "", createdAt: 2, recallCount: 0 },
        chain: [
          { id: 4, scope: "workspace", status: "accepted", content: "old", trigger: "", createdAt: 1, recallCount: 0, invalidAt: 2 },
          { id: 9, scope: "workspace", status: "accepted", content: "new", trigger: "", createdAt: 2, recallCount: 0 },
        ],
      }),
    });
    const tool = createMemoryTool(bridge, SESSION);
    const result = await execute(tool, { action: "get", id: 9 });
    assert.equal(isError(result), undefined);
    assert.deepEqual(requests[0]!.params, { id: 9 });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /revision chain/);
    assert.match(text, /#4.*retired/s);
  });

  it("correct requires id and corrected content before any host call", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createMemoryTool(bridge, SESSION);
    assert.equal(isError(await execute(tool, { action: "correct", id: 3 })), true);
    assert.equal(isError(await execute(tool, { action: "correct", content: "x" })), true);
    assert.equal(requests.length, 0);
  });

  it("forget sends the id to memory.forget", async () => {
    const { bridge, requests } = scriptedBridge({
      "memory.forget": (params: { id: number }) => ({ forgotten: params.id === 5 }),
    });
    const tool = createMemoryTool(bridge, SESSION);
    const result = await execute(tool, { action: "forget", id: 5 });
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "memory.forget");
    assert.deepEqual(requests[0]!.params, { id: 5 });
  });

  it("search forwards the query and renders matched items", async () => {
    const { bridge, requests } = scriptedBridge({
      "memory.search": (params: { query: string }) => ({
        results: params.query === "deploy"
          ? [{
            item: { id: 11, scope: "workspace", status: "accepted", content: "Deploys at 14:00", trigger: "deploy", nature: "decision", createdAt: 1, recallCount: 0 },
            score: 1,
          }]
          : [],
      }),
    });
    const tool = createMemoryTool(bridge, SESSION);
    const hit = await execute(tool, { action: "search", query: "deploy", k: 3 });
    assert.equal(isError(hit), undefined);
    assert.deepEqual(requests[0]!.params, { query: "deploy", k: 3 });
    assert.match((hit.content[0] as { text: string }).text, /Deploys at 14:00/);
    const miss = await execute(tool, { action: "search", query: "nothing" });
    assert.match((miss.content[0] as { text: string }).text, /no durable memory matches/);
  });

  it("host errors surface as structured tool errors", async () => {
    const { bridge } = scriptedBridge({});
    const tool = createMemoryTool(bridge, SESSION);
    const result = await execute(tool, { action: "get", id: 1 });
    assert.equal(isError(result), true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /unavailable/);
  });
});

describe("memory tool selection", () => {
  const deps = {
    bridge: undefined as never,
    cwd: "C:/workspace",
    isOpenAIFamily: true,
    sessionId: SESSION,
    workspaceMutationJournal: undefined,
  };

  it("registers by default and respects tools.memory = false", () => {
    const registered = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, deps).map((tool) => tool.name);
    assert.equal(registered.includes("memory"), true);
    const disabled = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { memory: false } },
      deps,
    ).map((tool) => tool.name);
    assert.equal(disabled.includes("memory"), false);
  });
});
