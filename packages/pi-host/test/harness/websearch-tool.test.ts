import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createWebSearchTool } from "../../src/harness/websearch-tool.js";
import type { HarnessRequestData } from "@varin/protocol";

function createTestBridge(sessionId: string) {
  const emitted: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_e, data) => { emitted.push(data); },
    sessionId,
    defaultTimeoutMs: 5000,
  });
  return { bridge, emitted };
}

describe("websearch tool", () => {
  it("formats search results", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc1", { query: "hello world" } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        providerId: "test-provider",
        capabilities: { pagination: false, fetch: true },
        notices: ["Exa is unavailable; used Parallel."],
        items: [{
          kind: "query",
          query: "hello world",
          status: "ok",
          results: [
            { title: "Hello World", url: "https://example.com/1", snippet: "A greeting" },
            { title: "World Hello", url: "https://example.com/2", snippet: "Reversed" },
          ],
        }],
      },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }> };
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes('query "hello world"'));
    assert.ok(text.includes("2 results"));
    assert.ok(text.includes("1. Hello World"));
    assert.ok(text.includes("Exa is unavailable; used Parallel."));
    assert.ok(text.includes("https://example.com/1"));
    assert.ok(text.includes("A greeting"));
    bridge.dispose();
  });

  it("reports a successful empty search without a configuration error", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc2", { query: "test" } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        providerId: "default-exa",
        capabilities: { pagination: false, fetch: true },
        items: [{ kind: "query", query: "test", status: "empty", results: [] }],
      },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.notEqual(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes("empty"));
    assert.ok(!text.includes("configured"));
    bridge.dispose();
  });

  it("renders mixed batches with per-item status and snapshot entries", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("batch", {
      queries: ["good", "bad"],
      urls: ["https://example.com/known"],
    } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    const requestData = emitted[0]!;
    const params = requestData.params as { queries?: string[]; urls?: string[] };
    assert.deepEqual(params.queries, ["good", "bad"]);
    assert.deepEqual(params.urls, ["https://example.com/known"]);
    bridge.respond("test", requestData.requestId, {
      ok: true,
      result: {
        providerId: "batch",
        capabilities: { pagination: false, fetch: true },
        items: [
          { kind: "query", query: "good", status: "ok", results: [{ title: "Hit", url: "https://example.com/good", snippet: "s" }] },
          { kind: "query", query: "bad", status: "failed", detail: "provider down" },
          {
            kind: "url",
            url: "https://example.com/known",
            status: "ok",
            fetch: {
              status: "ok",
              url: "https://example.com/known",
              finalUrl: "https://example.com/known",
              contentType: "text/plain",
              markdown: "body",
              bytes: 4,
              fromCache: false,
              rendered: false,
              snapshot: { snapshotId: "snap-1", sourceUrl: "https://example.com/known", finalUrl: "https://example.com/known", fetchedAt: 1, contentHash: "sha256-x", representation: "raw-text", byteLength: 4 },
            },
          },
        ],
      },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }>; isError?: boolean; details?: Record<string, unknown> };
    assert.notEqual(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /query "good": 1 results/);
    assert.match(text, /query "bad": failed — provider down/);
    assert.match(text, /url https:\/\/example\.com\/known: ok/);
    assert.match(text, /snapshot_id: snap-1/);
    const details = result.details as { sources?: Array<{ url: string; snapshotId?: string }> };
    assert.equal(details.sources?.length, 2);
    assert.equal(details.sources?.[1]?.snapshotId, "snap-1");
    bridge.dispose();
  });

  it("passes domain filters to the service", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc3", {
      query: "test",
      allowed_domains: ["example.com"],
      blocked_domains: ["spam.com"],
      recency: "week",
      limit: 5,
    } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    const requestData = emitted[0]!;
    assert.equal(requestData.method, "web.search");
    const params = requestData.params as { allowedDomains?: string[]; blockedDomains?: string[]; recency?: string; limit?: number };
    assert.deepEqual(params.allowedDomains, ["example.com"]);
    assert.deepEqual(params.blockedDomains, ["spam.com"]);
    assert.equal(params.recency, "week");
    assert.equal(params.limit, 5);

    bridge.respond("test", requestData.requestId, {
      ok: true,
      result: {
        providerId: "p",
        capabilities: { pagination: false, fetch: false },
        items: [{ kind: "query", query: "test", status: "empty", results: [] }],
      },
    });

    const result = await resultPromise as { isError?: boolean };
    assert.notEqual(result.isError, true);
    bridge.dispose();
  });

  it("surfaces Host credential revocation as unavailable", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc4", { query: "test" } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: false,
      error: { code: "unavailable", message: "search credential is unavailable: search-v1" },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(result.content[0]?.text ?? "", /^websearch unavailable: search credential is unavailable/);
    bridge.dispose();
  });

  it("cancels the Host search when the tool is aborted", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const controller = new AbortController();
    const pending = createWebSearchTool(bridge, "test").execute("cancel", { query: "test" } as never, controller.signal, undefined as never, undefined as never);
    controller.abort();
    const result = await pending;
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1]?.requestId, emitted[0]?.requestId);
    bridge.dispose();
  });
});
