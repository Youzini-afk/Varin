import { describe, expect, it, vi } from "vitest";
import { mintSearchCursor } from "@varin/protocol";
import {
  createConfiguredSearchProvider,
  createWebSearchService,
  filterByDomainPolicy,
  parseSearchProviderSettings,
  resolveConfiguredSearchProvider,
  resolveSearchCredential,
} from "./web-search.js";

const context = { signal: new AbortController().signal };

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

const mcpResponse = (result: unknown, status = 200): Response => jsonResponse({
  jsonrpc: "2.0",
  id: 1,
  result,
}, status);

describe("configured web search providers", () => {
  it("calls Brave with its documented header, freshness, and result shape", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({
      web: { results: [{ title: "Brave result", url: "https://docs.example/a", description: "snippet" }] },
    }));
    const provider = createConfiguredSearchProvider({ provider: "brave" }, { apiKey: "brave-secret", fetch });
    await expect(provider.search("query", { limit: 50, recency: "week" })).resolves.toEqual({
      results: [{ title: "Brave result", url: "https://docs.example/a", snippet: "snippet" }],
    });
    const [requestUrl, init] = fetch.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("query");
    expect(url.searchParams.get("count")).toBe("20");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-secret");
  });

  it("maps Exa domain and recency options without exposing its credential", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({
      results: [{ title: "Exa result", url: "https://exa.example/a", highlights: ["first", "second"], publishedDate: "2026-09-01" }],
    }));
    const provider = createConfiguredSearchProvider({ provider: "exa", credentialRef: "exa-search" }, {
      apiKey: "exa-secret",
      fetch,
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    });
    const results = await provider.search("query", {
      allowedDomains: ["exa.example"],
      blockedDomains: ["blocked.example"],
      recency: "day",
      limit: 4,
    });
    expect(results.results[0]).toMatchObject({ snippet: "first … second", publishedAt: "2026-09-01" });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "query",
      numResults: 4,
      includeDomains: ["exa.example"],
      excludeDomains: ["blocked.example"],
      startPublishedDate: "2026-09-04T00:00:00.000Z",
    });
    expect(JSON.stringify(init)).not.toContain("credentialRef");
  });

  it("supports Tavily, Jina, and credential-optional SearXNG response shapes", async () => {
    const tavilyFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ results: [{ title: "T", url: "https://t.example", content: "T body" }] }));
    const tavily = createConfiguredSearchProvider({ provider: "tavily" }, { apiKey: "tvly", fetch: tavilyFetch });
    expect((await tavily.search("q", { recency: "month" })).results[0]?.snippet).toBe("T body");
    expect(JSON.parse(String(tavilyFetch.mock.calls[0]![1]?.body))).toMatchObject({ time_range: "month" });

    const jinaFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ data: [{ title: "J", url: "https://j.example", content: "J body" }] }));
    const jina = createConfiguredSearchProvider({ provider: "jina" }, { apiKey: "jina", fetch: jinaFetch });
    expect(await jina.search("q", {})).toEqual({ results: [{ title: "J", url: "https://j.example", snippet: "J body" }] });
    expect(new URL(String(jinaFetch.mock.calls[0]![0])).searchParams.get("q")).toBe("q");

    const searxFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ results: [{ title: "S", url: "https://s.example", content: "S body" }] }));
    const searx = createConfiguredSearchProvider({ provider: "searxng", endpoint: "http://127.0.0.1:8080" }, { fetch: searxFetch });
    expect((await searx.search("q", { recency: "month" })).results).toHaveLength(1);
    const searxUrl = new URL(String(searxFetch.mock.calls[0]![0]));
    expect(searxUrl.pathname).toBe("/search");
    expect(searxUrl.searchParams.get("format")).toBe("json");
    expect(searxUrl.searchParams.get("time_range")).toBe("month");
    await expect(searx.search("q", { recency: "week" })).rejects.toThrow("exact week");
  });

  it("parses public settings and resolves only the named Pi auth entry", () => {
    expect(parseSearchProviderSettings({ provider: "brave", credentialRef: "brave-search", unknown: true })).toEqual({
      provider: "brave",
      credentialRef: "brave-search",
    });
    expect(parseSearchProviderSettings({ provider: "unknown" })).toBeNull();
    expect(resolveSearchCredential({
      brave: { type: "api_key", key: "secret" },
      other: { token: "other-secret" },
    }, "brave")).toBe("secret");
    expect(resolveSearchCredential({ brave: { key: "secret" } }, "missing")).toBeNull();
    expect(resolveConfiguredSearchProvider({
      settings: { provider: "brave", credentialRef: "missing" },
      auth: {},
    })).toEqual({ unavailable: true, hint: "search credential is unavailable: missing" });
    expect(resolveConfiguredSearchProvider({
      settings: { provider: "searxng", endpoint: "http://localhost:8080" },
      auth: {},
      fetch: vi.fn(),
    })).toMatchObject({ id: "configured-searxng" });
    expect(resolveConfiguredSearchProvider({ settings: {}, auth: {} })).toEqual({
      unavailable: true,
      hint: "invalid search provider configuration",
    });
  });

  it("filters returned domains and reports provider failure as an item status", async () => {
    expect(filterByDomainPolicy([
      { url: "https://docs.example/a" },
      { url: "https://blocked.example/b" },
      { url: "not-a-url" },
    ], ["example"], ["blocked.example"])).toEqual([{ url: "https://docs.example/a" }]);

    const service = createWebSearchService(async () => ({
      id: "broken",
      capabilities: { pagination: false },
      search: async () => { throw new Error("provider unavailable"); },
    }));
    await expect(service.handle({ query: "q" }, context)).resolves.toMatchObject({
      providerId: "broken",
      items: [{ kind: "query", query: "q", status: "failed", detail: "provider unavailable" }],
    });
    const unavailable = createWebSearchService(async () => ({ unavailable: true, hint: "configure search" }));
    await expect(unavailable.handle({ query: "q" }, context)).resolves.toMatchObject({
      providerId: "none",
      items: [{ kind: "query", query: "q", status: "unavailable", detail: "configure search" }],
    });
  });

  it("intersects tool domain filters with the frozen persistent policy", async () => {
    const search = vi.fn(async () => ({ results: [
      { title: "Docs", url: "https://api.docs.example.com/a", snippet: "ok" },
      { title: "Other", url: "https://other.example.com/b", snippet: "blocked by allow" },
      { title: "Tracker", url: "https://tracker.docs.example.com/c", snippet: "blocked" },
    ] }));
    const service = createWebSearchService(
      async () => ({ id: "configured-test", capabilities: { pagination: false }, search }),
      async () => ({ allow: ["example.com"], block: ["tracker.docs.example.com"] }),
    );
    const result = await service.handle({
      query: "q",
      allowedDomains: ["docs.example.com"],
      blockedDomains: ["ads.docs.example.com"],
    }, context);
    expect(search).toHaveBeenCalledWith("q", expect.objectContaining({
      allowedDomains: ["docs.example.com"],
      blockedDomains: ["tracker.docs.example.com", "ads.docs.example.com"],
    }));
    expect(result.items[0]?.status).toBe("ok");
    expect(result.items[0]?.results).toEqual([
      { title: "Docs", url: "https://api.docs.example.com/a", snippet: "ok" },
    ]);
  });

  it("uses the anonymous Exa MCP default and reports its real provider id", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
      expect(String(input)).toBe("https://mcp.exa.ai/mcp");
      expect(body.params.name).toBe("web_search_exa");
      expect(body.params.arguments).toMatchObject({ query: "current news", objective: "current news", numResults: 3 });
      return mcpResponse({ structuredContent: { results: [{ title: "Exa", url: "https://exa.example/a", highlights: ["result"] }] } });
    });
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    expect("unavailable" in resolved).toBe(false);
    if ("unavailable" in resolved) return;
    await expect(resolved.search("current news", { limit: 3 })).resolves.toEqual({
      providerId: "default-exa",
      results: [{ title: "Exa", url: "https://exa.example/a", snippet: "result" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses Exa MCP SSE text blocks and preserves all highlights", async () => {
    const rpc = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: [
          "Title: First",
          "URL: https://exa.example/first",
          "Published Date: 2026-09-01",
          "Text: body text",
          "Highlights:",
          "- first highlight",
          "- second highlight",
          "",
          "Title: Second",
          "URL: https://exa.example/second",
          "Highlights: [\"third highlight\"]",
        ].join("\n") }],
      },
    };
    const fetch = vi.fn(async () => new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("query", {})).resolves.toEqual({
      providerId: "default-exa",
      results: [
        { title: "First", url: "https://exa.example/first", snippet: "first highlight … second highlight", publishedAt: "2026-09-01" },
        { title: "Second", url: "https://exa.example/second", snippet: "third highlight" },
      ],
    });
  });

  it("uses Exa advanced hard filters for domains and exact recency", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("tools")).toBe("web_search_advanced_exa");
      const body = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
      expect(body.params.name).toBe("web_search_advanced_exa");
      expect(body.params.arguments).toEqual({
        query: "query",
        numResults: 10,
        includeDomains: ["docs.example"],
        excludeDomains: ["ads.example"],
        startPublishedDate: "2026-09-17",
      });
      return mcpResponse({ structuredContent: { results: [{ title: "Advanced", url: "https://docs.example/a", highlights: ["exact"] }] } });
    });
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch, now: () => Date.parse("2026-09-18T00:00:00.000Z") });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("query", {
      allowedDomains: ["docs.example"],
      blockedDomains: ["ads.example"],
      recency: "day",
    })).resolves.toEqual({
      providerId: "default-exa",
      results: [{ title: "Advanced", url: "https://docs.example/a", snippet: "exact" }],
    });
  });

  it("fails over from an Exa error to Parallel in order and surfaces a notice", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => {
      if (String(input) === "https://mcp.exa.ai/mcp") return new Response("rate limited", { status: 429 });
      return mcpResponse({ content: [{ type: "text", text: JSON.stringify({
        search_id: "s1",
        results: [{ title: "Parallel", url: "https://parallel.example/a", publish_date: "2026-09-18", excerpts: ["excerpt"] }],
      }) }] });
    });
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("query", { limit: 2 })).resolves.toEqual({
      providerId: "default-parallel",
      results: [{ title: "Parallel", url: "https://parallel.example/a", snippet: "excerpt", publishedAt: "2026-09-18" }],
      notices: ["Exa MCP failed (Exa search failed with HTTP 429 (rate limited)); used Parallel MCP."],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const parallelBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as { params: { name: string; arguments: unknown } };
    expect(parallelBody.params).toEqual({ name: "web_search", arguments: { objective: "query", search_queries: ["query"] } });
  });

  it("reports both default providers failed instead of returning a fake empty result", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("query", {})).rejects.toThrow("Exa MCP failed (Exa search failed with HTTP 503); Parallel MCP failed (Parallel search failed with HTTP 503)");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes Parallel domain and recency guidance while retaining the final Host filter", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (String(input).includes("mcp.exa.ai")) return new Response("down", { status: 503 });
      const body = JSON.parse(String(init?.body)) as { params: { arguments: { objective: string; search_queries: string[] } } };
      expect(body.params.arguments.objective).toContain("prefer results from these domains: docs.example");
      expect(body.params.arguments.objective).toContain("exclude results from these domains: ads.example");
      expect(body.params.arguments.objective).toContain("prefer results from the last week");
      expect(body.params.arguments.search_queries[0]).toBe(body.params.arguments.objective);
      return mcpResponse({ structuredContent: { results: [{ title: "Parallel", url: "https://ads.example/a", highlights: ["filtered"] }] } });
    });
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    const service = createWebSearchService(async () => resolved);
    await expect(service.handle({ query: "query", allowedDomains: ["docs.example"], blockedDomains: ["ads.example"], recency: "week" }, context)).resolves.toMatchObject({
      providerId: "default-parallel",
      items: [{ status: "empty", results: [] }],
      notices: [expect.stringContaining("Exa MCP failed"), expect.stringContaining("Parallel MCP cannot guarantee")],
    });
  });

  it("never falls back from an explicitly configured provider", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const resolved = resolveConfiguredSearchProvider({
      settings: { provider: "exa", credentialRef: "custom-exa" },
      auth: { "custom-exa": { key: "secret" } },
      fetch,
    });
    if ("unavailable" in resolved) throw new Error("configured provider unexpectedly unavailable");
    await expect(resolved.search("query", {})).rejects.toThrow("Exa search failed with HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a valid empty Exa result successful without trying Parallel", async () => {
    const fetch = vi.fn(async () => mcpResponse({ structuredContent: { results: [] } }));
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("no hits", {})).resolves.toEqual({ providerId: "default-exa", results: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start Parallel after cancellation of Exa", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    });
    const resolved = resolveConfiguredSearchProvider({ settings: undefined, auth: {}, fetch });
    if ("unavailable" in resolved) throw new Error("default provider unexpectedly unavailable");
    await expect(resolved.search("query", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("denies an empty domain allowlist per item without calling the provider", async () => {
    const search = vi.fn(async () => ({ results: [{ title: "should not call", url: "https://example.com", snippet: "" }] }));
    const service = createWebSearchService(async () => ({ id: "default", capabilities: { pagination: false }, search }));
    await expect(service.handle({ query: "query", allowedDomains: [] }, context)).resolves.toMatchObject({
      providerId: "default",
      items: [{ kind: "query", query: "query", status: "denied" }],
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts a natural-language objective when no literal query is supplied", async () => {
    const search = vi.fn(async (query: string) => ({ results: [{ title: "Objective", url: "https://example.com/objective", snippet: query }] }));
    const service = createWebSearchService(async () => ({ id: "objective", capabilities: { pagination: false }, search }));
    await expect(service.handle({ objective: "find recent papers about agent memory" }, context)).resolves.toMatchObject({
      providerId: "objective",
      items: [{ kind: "objective", status: "ok", results: [{ snippet: "find recent papers about agent memory" }] }],
    });
    expect(search).toHaveBeenCalledWith("find recent papers about agent memory", expect.anything());
  });

  it("keeps per-item status independent across a mixed batch", async () => {
    const search = vi.fn(async (query: string) => {
      if (query === "bad") throw new Error("boom");
      return { results: [{ title: "Hit", url: `https://example.com/${query}`, snippet: query }] };
    });
    const fetchUrl = vi.fn(async (url: string) => ({
      status: "ok" as const,
      url,
      finalUrl: url,
      contentType: "text/plain",
      markdown: "fetched body",
      bytes: 12,
      fromCache: false,
      rendered: false,
      snapshot: {
        snapshotId: "snap-url-1",
        sourceUrl: url,
        finalUrl: url,
        fetchedAt: 1,
        contentHash: "sha256-body",
        representation: "raw-text",
        byteLength: 12,
      },
    }));
    const service = createWebSearchService(
      async () => ({ id: "batch", capabilities: { pagination: false }, search }),
      undefined,
      { fetchUrl },
    );
    const result = await service.handle({
      queries: ["alpha", "bad"],
      urls: ["https://example.com/known"],
      objective: "goal",
    }, context);

    // Canonical item order: query, queries, objective, urls, cursor.
    expect(result.items).toHaveLength(4);
    expect(result.items.map((item) => item.status)).toEqual(["ok", "failed", "ok", "ok"]);
    expect(result.items[0]?.results?.[0]?.url).toBe("https://example.com/alpha");
    expect(result.items[1]?.detail).toBe("boom");
    expect(result.items[2]?.kind).toBe("objective");
    expect(result.items[3]?.kind).toBe("url");
    expect(result.items[3]?.fetch?.status).toBe("ok");
    expect(result.items[3]?.fetch?.status === "ok" ? result.items[3].fetch.snapshot?.snapshotId : null).toBe("snap-url-1");
    expect(result.capabilities.fetch).toBe(true);
  });

  it("marks url items unavailable when no host fetch path is wired", async () => {
    const service = createWebSearchService(async () => ({ id: "p", capabilities: { pagination: false }, search: vi.fn() }));
    const result = await service.handle({ urls: ["https://example.com/x"] }, context);
    expect(result.items[0]?.status).toBe("unavailable");
    expect(result.capabilities).toEqual({ pagination: false, fetch: false });
    // URL-only batches never touch the search provider.
    expect(result.providerId).toBe("none");
  });

  it("mints and continues a Brave pagination cursor", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      const offset = url.searchParams.get("offset");
      return jsonResponse({
        query: { more_results_available: offset !== "1" },
        web: { results: [{ title: `Brave p${offset ?? "0"}`, url: `https://docs.example/${offset ?? "0"}`, description: "snippet" }] },
      });
    });
    const provider = createConfiguredSearchProvider({ provider: "brave" }, { apiKey: "k", fetch });
    const service = createWebSearchService(async () => provider);

    const first = await service.handle({ query: "q" }, context);
    expect(first.capabilities.pagination).toBe(true);
    const cursor = first.items[0]?.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await service.handle({ cursor: cursor! }, context);
    expect(second.items[0]?.kind).toBe("page");
    expect(second.items[0]?.status).toBe("ok");
    expect(second.items[0]?.results?.[0]?.url).toBe("https://docs.example/1");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("offset")).toBe("1");
    expect(second.items[0]?.nextCursor).toBeUndefined();
  });

  it("rejects cursors on non-paginating providers and cursors minted by another provider", async () => {
    const service = createWebSearchService(async () => ({
      id: "default-exa",
      capabilities: { pagination: false },
      search: vi.fn(),
    }));
    const foreign = mintSearchCursor({ v: 1, p: "configured-brave", q: "q", k: "offset", n: 1 });
    const unsupported = await service.handle({ cursor: foreign }, context);
    expect(unsupported.items[0]?.status).toBe("unsupported");

    const paginating = createWebSearchService(async () => ({
      id: "configured-searxng",
      capabilities: { pagination: "page" as const },
      search: vi.fn(async () => ({ results: [] })),
    }));
    const wrongProvider = await paginating.handle({ cursor: foreign }, context);
    expect(wrongProvider.items[0]?.status).toBe("failed");
    expect(wrongProvider.items[0]?.detail).toContain("configured-brave");
  });

  it("marks aborted batch items cancelled without erasing completed siblings", async () => {
    const controller = new AbortController();
    const search = vi.fn(async (query: string) => {
      if (query === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }
      return { results: [{ title: "Fast", url: "https://example.com/fast", snippet: "" }] };
    });
    const service = createWebSearchService(async () => ({ id: "p", capabilities: { pagination: false }, search }));
    const result = await service.handle({ queries: ["fast", "slow"] }, {
      ...context,
      signal: controller.signal,
    });
    expect(result.items.map((item) => item.status)).toEqual(["ok", "cancelled"]);
  });
});
