import {
  mergeHarnessWebDomainPolicy,
  mintSearchCursor,
  parseSearchCursor,
  type FetchResult,
  type HarnessWebDomainPolicy,
  type HarnessWebSearchSettings,
  type SearchResultItem,
  type WebSearchItem,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { HarnessServiceError } from "./service-error.js";

export interface SearchProvider {
  id: string;
  /**
   * Pagination mechanism the provider adapter actually implements.
   * "offset" means Brave-style page indices; "page" means SearXNG pageno.
   * false means a cursor must never be minted for this provider.
   */
  capabilities: { pagination: "offset" | "page" | false };
  search(query: string, options: {
    allowedDomains?: string[];
    blockedDomains?: string[];
    recency?: "day" | "week" | "month" | "year";
    limit?: number;
    /** Continuation page for providers whose capability allows it. */
    page?: { kind: "offset" | "page"; value: number };
    signal?: AbortSignal;
  }): Promise<SearchProviderResponse>;
}

export interface SearchProviderResponse {
  results: SearchResultItem[];
  /** A provider may report the actual source when it is a router/failover. */
  providerId?: string;
  /** Set when the provider exposes a further page; the service mints a cursor. */
  nextPage?: { kind: "offset" | "page"; value: number };
  notices?: string[];
}

export type ResolveSearchProviderResult = SearchProvider | { unavailable: true; hint: string };

interface SearchProviderRuntime {
  apiKey: string | null;
  fetch: typeof globalThis.fetch;
  now: () => number;
}

const DEFAULT_ENDPOINTS: Record<Exclude<HarnessWebSearchSettings["provider"], "searxng">, string> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
  tavily: "https://api.tavily.com/search",
  jina: "https://s.jina.ai/",
};

const DEFAULT_EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
const DEFAULT_PARALLEL_MCP_ENDPOINT = "https://search.parallel.ai/mcp";

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(text).filter(Boolean) : []
);

const endpointFor = (settings: HarnessWebSearchSettings): string => {
  const configured = settings.endpoint?.trim();
  const raw = configured || (settings.provider === "searxng" ? "" : DEFAULT_ENDPOINTS[settings.provider]);
  if (!raw) throw new Error("SearXNG search requires an endpoint");
  const endpoint = new URL(raw);
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password) {
    throw new Error("Search provider endpoint must be an HTTP(S) URL without embedded credentials");
  }
  return endpoint.href;
};

const requireCredential = (settings: HarnessWebSearchSettings, apiKey: string | null): string => {
  if (apiKey) return apiKey;
  throw new Error(`Search credential is not configured for ${settings.provider}`);
};

const responseJson = async (response: Response, provider: string): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new Error(`${provider} search failed with HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isRecord(value)) throw new Error(`${provider} search returned malformed JSON`);
  return value;
};

const recencyStart = (recency: "day" | "week" | "month" | "year", now: number): string => {
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 365;
  return new Date(now - days * 24 * 60 * 60 * 1_000).toISOString();
};

const recencyDate = (recency: "day" | "week" | "month" | "year", now: number): string => (
  recencyStart(recency, now).slice(0, 10)
);

const normalizeResults = (values: unknown[]): SearchResultItem[] => (
  values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = text(value.url) || text(value.link);
    if (!url) return [];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    } catch {
      return [];
    }
    const highlights = stringList(value.highlights);
    const excerpts = stringList(value.excerpts);
    const snippet = text(value.description)
      || text(value.content)
      || highlights.join(" … ")
      || excerpts.join(" … ")
      || text(value.text);
    const publishedAt = text(value.publishedAt)
      || text(value.publishedDate)
      || text(value.published_date)
      || text(value.publish_date)
      || text(value.published_at)
      || text(value.date);
    const summary = text(value.summary) || text(value.abstract);
    return [{
      title: text(value.title) || url,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
      ...(summary ? { summary } : {}),
    }];
  })
);

interface McpToolResult {
  content?: unknown;
  structuredContent?: unknown;
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

/** Parse both ordinary JSON-RPC and the single-event SSE transport used by MCP. */
const parseMcpTransport = (body: string, provider: string): Record<string, unknown> => {
  const direct = parseJson(body.trim());
  if (isRecord(direct)) return direct;

  const events = body.split(/\r?\n\r?\n/u).flatMap((event) => {
    const data = event.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    const parsed = parseJson(data);
    return isRecord(parsed) ? [parsed] : [];
  });
  const rpc = events.findLast((value) => "result" in value || "error" in value);
  if (rpc) return rpc;
  throw new Error(`${provider} search returned malformed JSON/SSE`);
};

const callMcpTool = async (input: {
  fetch: typeof globalThis.fetch;
  endpoint: string;
  provider: string;
  tool: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<McpToolResult> => {
  const response = await input.fetch(input.endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: input.tool, arguments: input.arguments },
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    const suffix = response.status === 429 ? " (rate limited)" : "";
    throw new Error(`${input.provider} search failed with HTTP ${response.status}${suffix}`);
  }
  const body = await response.text();
  const rpc = parseMcpTransport(body, input.provider);
  if ("error" in rpc) throw new Error(`${input.provider} search returned a JSON-RPC error`);
  if (!isRecord(rpc.result)) throw new Error(`${input.provider} search returned malformed JSON-RPC`);
  if (rpc.result.isError === true) throw new Error(`${input.provider} search tool failed`);
  return rpc.result as McpToolResult;
};

const resultArray = (value: unknown): unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.data)) return value.data;
  if (isRecord(value.data)) return resultArray(value.data);
  return undefined;
};

const parseLabelledMcpResults = (value: string): unknown[] => {
  const blocks = value.split(/(?=^\s*Title\s*:)/imu).filter((block) => /^\s*Title\s*:/imu.test(block));
  return blocks.flatMap((block) => {
    const title = block.match(/^\s*Title\s*:\s*(.+)$/imu)?.[1]?.trim();
    const url = block.match(/^\s*(?:URL|Link)\s*:\s*(https?:\/\/\S+)\s*$/imu)?.[1]
      ?? block.match(/https?:\/\/\S+/u)?.[0];
    if (!title || !url) return [];
    const lines = block.split(/\r?\n/u);
    const section = (label: RegExp): string => {
      const start = lines.findIndex((line) => label.test(line));
      if (start < 0) return "";
      const first = lines[start]?.replace(label, "").trim() ?? "";
      const end = lines.findIndex((line, index) => index > start && /^\s*(?:Title|URL|Link|Published(?: Date)?|Date|Text|Description|Snippet|Highlights?)\s*:/iu.test(line));
      return [first, ...lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim())]
        .filter(Boolean)
        .join("\n");
    };
    const highlightsMatch = section(/^\s*Highlights?\s*:\s*/iu);
    let highlights: string[] = [];
    const parsedHighlights = parseJson(highlightsMatch);
    if (Array.isArray(parsedHighlights)) highlights = stringList(parsedHighlights);
    else if (highlightsMatch) highlights = highlightsMatch
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
      .filter(Boolean);
    const textValue = section(/^\s*(?:Text|Description|Snippet)\s*:\s*/iu);
    const publishedAt = block.match(/^\s*(?:Published(?: Date)?|Date)\s*:[\t ]*(.*)$/imu)?.[1]?.trim();
    return [{
      title,
      url,
      highlights,
      ...(textValue ? { text: textValue } : {}),
      ...(publishedAt && !/^(?:n\/a|unknown|null)$/iu.test(publishedAt) ? { publishedAt } : {}),
    }];
  });
};

const parseMcpSearchResults = (toolResult: McpToolResult, provider: string): SearchResultItem[] => {
  const structured = resultArray(toolResult.structuredContent);
  const structuredEmpty = structured?.length === 0;
  if (structured) {
    const normalized = normalizeResults(structured);
    if (structured.length > 0 && normalized.length === 0) throw new Error(`${provider} search returned malformed result`);
    if (normalized.length > 0) return normalized;
  }

  const content = Array.isArray(toolResult.content) ? toolResult.content : [];
  const results: SearchResultItem[] = [];
  let recognized = false;
  for (const item of content) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const textValue = item.text;
    const parsed = parseJson(textValue);
    const fromJson = resultArray(parsed);
    if (fromJson) {
      const normalized = normalizeResults(fromJson);
      if (fromJson.length > 0 && normalized.length === 0) throw new Error(`${provider} search returned malformed result`);
      results.push(...normalized);
      recognized = true;
      continue;
    }
    const labelled = parseLabelledMcpResults(textValue);
    if (labelled.length) {
      results.push(...normalizeResults(labelled));
      recognized = true;
      continue;
    }
    if (/\b(?:no|0)\s+results?\b/iu.test(textValue)) recognized = true;
  }
  if (recognized) return results;
  if (structuredEmpty && content.length === 0) return [];
  throw new Error(`${provider} search returned malformed result`);
};

const defaultRecencyNotice = (provider: string, recency: string | undefined): string[] => (
  recency
    ? [`${provider} MCP cannot guarantee an exact ${recency} recency filter.`]
    : []
);

const exaMcpProvider = (runtime: SearchProviderRuntime): SearchProvider => ({
  id: "default-exa",
  capabilities: { pagination: false },
  search: async (query, options) => {
    const advanced = options.allowedDomains !== undefined
      || Boolean(options.blockedDomains?.length)
      || Boolean(options.recency);
    const endpoint = new URL(DEFAULT_EXA_MCP_ENDPOINT);
    if (advanced) endpoint.searchParams.set("tools", "web_search_advanced_exa");
    const args: Record<string, unknown> = { query, numResults: options.limit ?? 10 };
    if (!advanced) args.objective = query;
    if (options.allowedDomains?.length) args.includeDomains = options.allowedDomains;
    if (options.blockedDomains?.length) args.excludeDomains = options.blockedDomains;
    if (options.recency) args.startPublishedDate = recencyDate(options.recency, runtime.now());
    const tool = advanced ? "web_search_advanced_exa" : "web_search_exa";
    const result = await callMcpTool({
      fetch: runtime.fetch,
      endpoint: endpoint.href,
      provider: "Exa",
      tool,
      arguments: args,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      providerId: "default-exa",
      results: parseMcpSearchResults(result, "Exa"),
    };
  },
});

const parallelMcpProvider = (runtime: SearchProviderRuntime): SearchProvider => ({
  id: "default-parallel",
  capabilities: { pagination: false },
  search: async (query, options) => {
    const guidance = [
      ...(options.allowedDomains?.length ? [`prefer results from these domains: ${options.allowedDomains.join(", ")}`] : []),
      ...(options.blockedDomains?.length ? [`exclude results from these domains: ${options.blockedDomains.join(", ")}`] : []),
      ...(options.recency ? [`prefer results from the last ${options.recency}`] : []),
    ];
    const guidanceText = guidance.length ? ` (${guidance.join("; ")})` : "";
    const result = await callMcpTool({
      fetch: runtime.fetch,
      endpoint: DEFAULT_PARALLEL_MCP_ENDPOINT,
      provider: "Parallel",
      tool: "web_search",
      arguments: {
        objective: `${query}${guidanceText}`,
        search_queries: [`${query}${guidanceText}`],
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const notices = defaultRecencyNotice("Parallel", options.recency);
    return {
      providerId: "default-parallel",
      results: parseMcpSearchResults(result, "Parallel"),
      ...(notices.length ? { notices } : {}),
    };
  },
});

const isCancellation = (error: unknown, signal: AbortSignal | undefined): boolean => (
  Boolean(signal?.aborted)
  || (error instanceof Error && error.name === "AbortError")
);

const conciseFailure = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/\s+/gu, " ").trim();
  if (!message) return fallback;
  return message;
};

const defaultSearchProvider = (runtime: SearchProviderRuntime): SearchProvider => {
  const exa = exaMcpProvider(runtime);
  const parallel = parallelMcpProvider(runtime);
  return {
    id: "default-exa",
    capabilities: { pagination: false },
    search: async (query, options) => {
      try {
        return await exa.search(query, options);
      } catch (error) {
        if (isCancellation(error, options.signal)) throw error;
        const exaReason = conciseFailure(error, "request failed");
        const failoverNotice = `Exa MCP failed (${exaReason}); used Parallel MCP.`;
        try {
          const response = await parallel.search(query, options);
          return {
            ...response,
            notices: [failoverNotice, ...(response.notices ?? [])],
          };
        } catch (parallelError) {
          if (isCancellation(parallelError, options.signal)) throw parallelError;
          const parallelReason = conciseFailure(parallelError, "request failed");
          throw new Error(`Exa MCP failed (${exaReason}); Parallel MCP failed (${parallelReason})`);
        }
      }
    },
  };
};

const braveProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-brave",
  capabilities: { pagination: "offset" },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(Math.min(options.limit ?? 10, 20)));
    // Brave paginates by a 0..9 offset page index, not a result offset.
    const offset = options.page?.kind === "offset" ? options.page.value : 0;
    if (offset > 0) endpoint.searchParams.set("offset", String(Math.min(offset, 9)));
    if (options.recency) endpoint.searchParams.set("freshness", ({ day: "pd", week: "pw", month: "pm", year: "py" })[options.recency]);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: { Accept: "application/json", "X-Subscription-Token": requireCredential(settings, runtime.apiKey) },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Brave");
    const web = isRecord(payload.web) ? payload.web : {};
    const queryMeta = isRecord(payload.query) ? payload.query : {};
    const moreAvailable = queryMeta.more_results_available === true && offset < 9;
    return {
      results: normalizeResults(Array.isArray(web.results) ? web.results : []),
      ...(moreAvailable ? { nextPage: { kind: "offset" as const, value: offset + 1 } } : {}),
    };
  },
});

const exaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-exa",
  capabilities: { pagination: false },
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": requireCredential(settings, runtime.apiKey) },
      body: JSON.stringify({
        query,
        numResults: options.limit ?? 10,
        contents: { highlights: true },
        ...(options.allowedDomains?.length ? { includeDomains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { excludeDomains: options.blockedDomains } : {}),
        ...(options.recency ? { startPublishedDate: recencyStart(options.recency, runtime.now()) } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Exa");
    return { results: normalizeResults(Array.isArray(payload.results) ? payload.results : []) };
  },
});

const tavilyProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-tavily",
  capabilities: { pagination: false },
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: options.limit ?? 10,
        ...(options.allowedDomains?.length ? { include_domains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
        ...(options.recency ? { time_range: options.recency } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Tavily");
    return { results: normalizeResults(Array.isArray(payload.results) ? payload.results : []) };
  },
});

const jinaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-jina",
  capabilities: { pagination: false },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", query);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Jina");
    const values = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.results) ? payload.results : [];
    return { results: normalizeResults(values).slice(0, options.limit ?? 10) };
  },
});

const searxngProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-searxng",
  capabilities: { pagination: "page" },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    if (endpoint.pathname === "/" || endpoint.pathname === "") endpoint.pathname = "/search";
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const page = options.page?.kind === "page" ? options.page.value : 1;
    if (page > 1) endpoint.searchParams.set("pageno", String(page));
    if (options.recency === "week") {
      throw new Error("SearXNG does not support an exact week recency filter; use day, month, or year");
    }
    if (options.recency) endpoint.searchParams.set("time_range", options.recency);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "SearXNG");
    const raw = Array.isArray(payload.results) ? payload.results : [];
    const results = normalizeResults(raw).slice(0, options.limit ?? 10);
    // SearXNG does not report a result count; a non-empty page may have a successor.
    return {
      results,
      ...(raw.length > 0 ? { nextPage: { kind: "page" as const, value: page + 1 } } : {}),
    };
  },
});

export const parseSearchProviderSettings = (value: unknown): HarnessWebSearchSettings | null => {
  if (!isRecord(value)) return null;
  const provider = value.provider;
  if (provider !== "brave" && provider !== "exa" && provider !== "tavily" && provider !== "jina" && provider !== "searxng") return null;
  if (("endpoint" in value && value.endpoint !== undefined && typeof value.endpoint !== "string")
    || ("credentialRef" in value && value.credentialRef !== undefined && typeof value.credentialRef !== "string")) return null;
  const endpoint = text(value.endpoint);
  const credentialRef = text(value.credentialRef);
  return {
    provider,
    ...(endpoint ? { endpoint } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  };
};

export const resolveSearchCredential = (auth: unknown, credentialRef: string | undefined): string | null => {
  if (!credentialRef || !isRecord(auth)) return null;
  const entry = auth[credentialRef];
  if (!isRecord(entry)) return null;
  return text(entry.key) || text(entry.token) || text(entry.access) || text(entry.apiKey) || null;
};

export const createConfiguredSearchProvider = (
  settings: HarnessWebSearchSettings,
  options: { apiKey?: string | null; fetch?: typeof globalThis.fetch; now?: () => number } = {},
): SearchProvider => {
  const runtime: SearchProviderRuntime = {
    apiKey: options.apiKey ?? null,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? Date.now,
  };
  if (settings.provider === "brave") return braveProvider(settings, runtime);
  if (settings.provider === "exa") return exaProvider(settings, runtime);
  if (settings.provider === "tavily") return tavilyProvider(settings, runtime);
  if (settings.provider === "jina") return jinaProvider(settings, runtime);
  return searxngProvider(settings, runtime);
};

export const resolveConfiguredSearchProvider = (input: {
  settings?: unknown;
  auth: unknown;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ResolveSearchProviderResult => {
  const runtime: SearchProviderRuntime = {
    apiKey: null,
    fetch: input.fetch ?? globalThis.fetch,
    now: input.now ?? Date.now,
  };
  // No settings means the Host-owned anonymous default. An explicitly supplied
  // malformed value remains unavailable so a broken user configuration cannot
  // silently select a different provider.
  if (input.settings === undefined) return defaultSearchProvider(runtime);
  const settings = parseSearchProviderSettings(input.settings);
  if (!settings) return { unavailable: true, hint: "invalid search provider configuration" };
  const credentialRef = settings.credentialRef;
  const apiKey = resolveSearchCredential(input.auth, credentialRef);
  if (settings.provider !== "searxng" && !apiKey) {
    return {
      unavailable: true,
      hint: credentialRef
        ? `search credential is unavailable: ${credentialRef}`
        : `search credential reference is required for ${settings.provider}`,
    };
  }
  try {
    // Validate endpoint eagerly so a malformed setting does not advertise a
    // tool that can only fail after the session has been constructed.
    endpointFor(settings);
    return createConfiguredSearchProvider(settings, {
      apiKey,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    return { unavailable: true, hint: error instanceof Error ? error.message : "invalid search provider configuration" };
  }
};

export function filterByDomainPolicy<T extends { url: string }>(
  results: T[],
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): T[] {
  return results.filter((result) => {
    try {
      const hostname = new URL(result.url).hostname.toLowerCase();
      if (blockedDomains?.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) return false;
      if (allowedDomains !== undefined && !allowedDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) return false;
      return true;
    } catch {
      return false;
    }
  });
}

const mapFetchStatus = (fetch: FetchResult): Pick<WebSearchItem, "status" | "detail"> => {
  switch (fetch.status) {
    case "ok": return { status: "ok" };
    case "redirect-cross-host": return { status: "partial", detail: `redirected to another host: ${fetch.location}` };
    case "blocked": return { status: "denied", detail: `fetch blocked: ${fetch.reason}` };
    case "empty-shell": return { status: "unavailable", detail: fetch.hint };
    case "renderer-unavailable": return fetch.reason === "disabled"
      ? { status: "denied", detail: "Web rendering is disabled in this session's settings (harness.web.render)" }
      : { status: "unavailable", detail: "This Host does not provide a web renderer" };
    case "page-image-unavailable": return { status: "unavailable", detail: fetch.reason };
    case "snapshot-missing": return { status: "unavailable", detail: `snapshot is missing: ${fetch.snapshotId}` };
    case "structure-unsupported": return { status: "unsupported", detail: `snapshot cannot express ${fetch.kind}` };
    case "position-not-found": return { status: "empty", detail: fetch.detail };
    case "failed": return { status: "failed", detail: fetch.reason };
  }
};

export function createWebSearchService(
  resolveProvider: (ctx: { sessionId: string; workspaceId: string | null }) => Promise<ResolveSearchProviderResult>,
  resolveDomainPolicy: (ctx: { sessionId: string; workspaceId: string | null }) => Promise<HarnessWebDomainPolicy> = async () => ({ block: [] }),
  deps: {
    /** Host-bound fetch used for `urls` items; absent means fetch is unwired. */
    fetchUrl?: (url: string, ctx: HarnessServiceContext) => Promise<FetchResult>;
  } = {},
): HarnessService<"web.search"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const queryItems: Array<{ kind: "query" | "objective"; query: string }> = [];
      if (params.query?.trim()) queryItems.push({ kind: "query", query: params.query.trim() });
      for (const entry of params.queries ?? []) {
        const query = typeof entry === "string" ? entry.trim() : "";
        if (query) queryItems.push({ kind: "query", query });
      }
      if (params.objective?.trim()) queryItems.push({ kind: "objective", query: params.objective.trim() });
      const urlItems = (params.urls ?? []).map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
      const cursorRaw = params.cursor?.trim() ?? "";
      if (queryItems.length === 0 && urlItems.length === 0 && !cursorRaw) {
        throw new HarnessServiceError("invalid-params", "web.search requires query, objective, queries, urls, or cursor");
      }

      const notices: string[] = [];
      const needsProvider = queryItems.length > 0 || Boolean(cursorRaw);
      const providerResult = needsProvider ? await resolveProvider(ctx) : null;
      const provider = providerResult && !("unavailable" in providerResult) ? providerResult : null;
      const providerHint = providerResult && "unavailable" in providerResult ? providerResult.hint : "search provider is unavailable";
      const paginationKind = provider?.capabilities?.pagination;
      // A routing/failover provider reports which engine actually answered.
      let effectiveProviderId = provider?.id;

      const runSearch = async (
        kind: "query" | "objective" | "page",
        query: string,
        constraints: { allow?: string[]; block?: string[]; recency?: "day" | "week" | "month" | "year"; limit?: number },
        page?: { kind: "offset" | "page"; value: number },
      ): Promise<WebSearchItem> => {
        const echo = kind === "page" ? {} : { query };
        if (!provider) return { kind, ...echo, status: "unavailable", detail: providerHint };
        const domainPolicy = mergeHarnessWebDomainPolicy(await resolveDomainPolicy(ctx), {
          ...(constraints.allow === undefined ? {} : { allow: constraints.allow }),
          ...(constraints.block === undefined ? {} : { block: constraints.block }),
        });
        if (domainPolicy.allow?.length === 0) {
          return { kind, ...echo, status: "denied", detail: "domain allowlist is empty" };
        }
        try {
          const response = await provider.search(query, {
            ...(domainPolicy.allow === undefined ? {} : { allowedDomains: domainPolicy.allow }),
            ...(domainPolicy.block.length === 0 ? {} : { blockedDomains: domainPolicy.block }),
            ...(constraints.recency ? { recency: constraints.recency } : {}),
            ...(constraints.limit ? { limit: constraints.limit } : {}),
            ...(page ? { page } : {}),
            signal: ctx.signal,
          });
          if (response.providerId) effectiveProviderId = response.providerId;
          notices.push(...(response.notices ?? []));
          const results = filterByDomainPolicy(response.results, domainPolicy.allow, domainPolicy.block)
            .slice(0, constraints.limit ?? 10);
          const nextCursor = response.nextPage && paginationKind !== false && paginationKind !== undefined
            ? mintSearchCursor({
              v: 1,
              p: provider.id,
              q: query,
              k: response.nextPage.kind,
              n: response.nextPage.value,
              ...(constraints.allow ? { allow: constraints.allow } : {}),
              ...(constraints.block ? { block: constraints.block } : {}),
              ...(constraints.recency ? { recency: constraints.recency } : {}),
              ...(constraints.limit ? { limit: constraints.limit } : {}),
            })
            : undefined;
          return {
            kind,
            ...echo,
            status: results.length === 0 ? "empty" : "ok",
            results,
            ...(nextCursor ? { nextCursor } : {}),
          };
        } catch (error) {
          if (isCancellation(error, ctx.signal)) return { kind, ...echo, status: "cancelled", detail: "cancelled" };
          return { kind, ...echo, status: "failed", detail: conciseFailure(error, "request failed") };
        }
      };

      const items: WebSearchItem[] = await Promise.all([
        ...queryItems.map((item) => runSearch(item.kind, item.query, {
          ...(params.allowedDomains !== undefined ? { allow: params.allowedDomains } : {}),
          ...(params.blockedDomains !== undefined ? { block: params.blockedDomains } : {}),
          ...(params.recency ? { recency: params.recency } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        })),
        ...urlItems.map(async (url): Promise<WebSearchItem> => {
          if (!deps.fetchUrl) return { kind: "url", url, status: "unavailable", detail: "host fetch path is not configured" };
          try {
            const fetch = await deps.fetchUrl(url, ctx);
            return { kind: "url", url, fetch, ...mapFetchStatus(fetch) };
          } catch (error) {
            if (isCancellation(error, ctx.signal)) return { kind: "url", url, status: "cancelled", detail: "cancelled" };
            return { kind: "url", url, status: "failed", detail: conciseFailure(error, "fetch failed") };
          }
        }),
        ...(cursorRaw ? [runCursor(cursorRaw)] : []),
      ]);

      async function runCursor(raw: string): Promise<WebSearchItem> {
        const payload = parseSearchCursor(raw);
        if (!payload) return { kind: "page", status: "failed", detail: "unknown or malformed cursor" };
        if (!provider) return { kind: "page", status: "unavailable", detail: providerHint };
        if (paginationKind !== "offset" && paginationKind !== "page") {
          return { kind: "page", status: "unsupported", detail: `provider ${provider.id} does not support pagination` };
        }
        if (payload.p !== provider.id) {
          return { kind: "page", status: "failed", detail: `cursor was minted by provider ${payload.p}, not ${provider.id}` };
        }
        if (payload.k !== paginationKind) {
          return { kind: "page", status: "failed", detail: `cursor pagination kind ${payload.k} does not match provider` };
        }
        return runSearch("page", payload.q, {
          ...(payload.allow ? { allow: payload.allow } : {}),
          ...(payload.block ? { block: payload.block } : {}),
          ...(payload.recency ? { recency: payload.recency } : {}),
          ...(payload.limit ? { limit: payload.limit } : {}),
        }, { kind: payload.k, value: payload.n });
      }

      return {
        providerId: effectiveProviderId ?? "none",
        capabilities: {
          pagination: paginationKind === "offset" || paginationKind === "page",
          fetch: Boolean(deps.fetchUrl),
        },
        items,
        ...(notices.length ? { notices } : {}),
      };
    },
  };
}
