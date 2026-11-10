import { createHash } from "node:crypto";
import {
  mergeHarnessWebDomainPolicy,
  parseHarnessWebSearchSettings,
  mintSearchCursor,
  parseSearchCursor,
  type FetchResult,
  type HarnessWebDomainPolicy,
  type HarnessWebSourcePreferences,
  type HarnessWebSearchSettings,
  type SearchResultItem,
  type WebSearchItem,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchFailure,
  type WebSearchAttempt,
  type WebSearchAppliedFilter,
  type WebSearchConnectionInfo,
  type WebSearchProviderCapabilities,
  type SearchContentKind,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";

export interface SearchOptions {
  objective?: string;
  connectionId?: string;
  /** Validated optional selector preference, distinct from an exact user selection. */
  autoPreferredConnectionId?: string;
  preferredDomains?: string[];
  allowedDomains?: string[];
  blockedDomains?: string[];
  recency?: "day" | "week" | "month" | "year";
  language?: string;
  region?: string;
  strictFilters?: boolean;
  limit?: number;
  page?: { kind: "offset" | "page"; value: number };
  signal?: AbortSignal;
}

export interface SearchProvider {
  id: string;
  /** Hash of configuration and credential generation; never exposes credentials. */
  cacheKey?: string;
  connections?: WebSearchConnectionInfo[];
  smartSelection?: boolean;
  capabilities: WebSearchProviderCapabilities;
  search(query: string, options: SearchOptions): Promise<SearchProviderResponse>;
}

export class SearchProviderError extends Error {
  constructor(readonly failure: WebSearchFailure, readonly attempts?: WebSearchAttempt[]) {
    super(failure.message);
    this.name = "SearchProviderError";
  }
}

export const classifySearchFailure = (error: unknown): WebSearchFailure => {
  if (error instanceof SearchProviderError) return error.failure;
  if (error instanceof Error && error.name === "AbortError") return { kind: "cancelled", message: "cancelled" };
  return { kind: error instanceof TypeError || (error instanceof Error && error.name === "EgressError") ? "network" : "unknown", message: conciseFailure(error, "request failed") };
};

export interface SearchProviderResponse {
  results: SearchResultItem[];
  connectionId?: string;
  capabilities?: WebSearchProviderCapabilities;
  attempts?: WebSearchAttempt[];
  appliedFilters?: WebSearchAppliedFilter[];
  /** A provider may report the actual source when it is a router/failover. */
  providerId?: string;
  /** Set when the provider exposes a further page; the service mints a cursor. */
  nextPage?: { kind: "offset" | "page"; value: number };
  notices?: string[];
}

export type ResolveSearchProviderResult = SearchProvider | { unavailable: true; hint: string; failure?: WebSearchFailure };

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
  anysearch: "https://api.anysearch.com/v1/search",
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

const httpFailure = (response: Response, provider: string): SearchProviderError => {
  const retry = response.headers.get("retry-after");
  const seconds = retry === null ? NaN : Number(retry);
  const retryAfterMs = retry === null ? NaN : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
  return new SearchProviderError({
    kind: response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate-limited" : "network",
    message: `${provider} search failed with HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}`,
    httpStatus: response.status,
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs: Math.max(0, retryAfterMs) } : {}),
  });
};

const requireResults = (value: unknown, provider: string): unknown[] => {
  if (!Array.isArray(value)) throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed results` });
  return value;
};

const responseJson = async (response: Response, provider: string): Promise<Record<string, unknown>> => {
  if (!response.ok) throw httpFailure(response, provider);
  try {
    const value = await response.json() as unknown;
    if (isRecord(value)) return value;
  } catch { /* Report protocol failure without leaking an upstream response. */ }
  throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed JSON` });
};

const recencyStart = (recency: "day" | "week" | "month" | "year", now: number): string => {
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 365;
  return new Date(now - days * 24 * 60 * 60 * 1_000).toISOString();
};

const recencyDate = (recency: "day" | "week" | "month" | "year", now: number): string => (
  recencyStart(recency, now).slice(0, 10)
);

const normalizeResults = (values: unknown[], contentKind: SearchContentKind = "unknown"): SearchResultItem[] => (
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
      || text(value.text)
      || text(value.snippet);
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
      contentKind: text(value.description) ? "search-description" : highlights.length || excerpts.length ? "provider-excerpt" : contentKind,
      ...(highlights.length || excerpts.length ? { excerpts: [...highlights, ...excerpts] } : {}),
      ...(text(value.author) ? { author: text(value.author) } : {}),
      ...(text(value.updatedAt) || text(value.updated_date) ? { updatedAt: text(value.updatedAt) || text(value.updated_date) } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(summary ? { summary, summaryKind: text(value.summary) ? "generated-summary" as const : "paper-abstract" as const } : {}),
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
  throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed JSON/SSE` });
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
  if (!response.ok) throw httpFailure(response, input.provider);
  const body = await response.text();
  const rpc = parseMcpTransport(body, input.provider);
  if ("error" in rpc) throw new SearchProviderError({ kind: "protocol", message: `${input.provider} search returned a JSON-RPC error` });
  if (!isRecord(rpc.result)) throw new SearchProviderError({ kind: "protocol", message: `${input.provider} search returned malformed JSON-RPC` });
  if (rpc.result.isError === true) throw new SearchProviderError({ kind: "protocol", message: `${input.provider} search tool failed` });
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
    if (structured.length > 0 && normalized.length === 0) throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed result` });
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
      if (fromJson.length > 0 && normalized.length === 0) throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed result` });
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
  throw new SearchProviderError({ kind: "protocol", message: `${provider} search returned malformed result` });
};

const defaultRecencyNotice = (provider: string, recency: string | undefined): string[] => (
  recency
    ? [`${provider} MCP cannot guarantee an exact ${recency} recency filter.`]
    : []
);

const exaMcpProvider = (runtime: SearchProviderRuntime): SearchProvider => ({
  id: "default-exa",
  capabilities: { pagination: false, objective: true, domains: "native", recency: "native", language: "unsupported", region: "unsupported", excerpts: true },
  search: async (query, options) => {
    const advanced = options.allowedDomains !== undefined
      || Boolean(options.blockedDomains?.length)
      || Boolean(options.recency);
    const endpoint = new URL(DEFAULT_EXA_MCP_ENDPOINT);
    if (advanced) endpoint.searchParams.set("tools", "web_search_advanced_exa");
    const guidance = objectiveGuidance(query, options);
    const args: Record<string, unknown> = { query, numResults: Math.min(options.limit ?? 10, 100) };
    if (advanced) args.enableHighlights = true;
    if (!advanced) args.objective = guidance;
    else if (options.objective || options.preferredDomains?.length) args.highlightsQuery = guidance;
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
  capabilities: { pagination: false, objective: true, domains: "operator", recency: "guidance", language: "guidance", region: "guidance", excerpts: true },
  search: async (query, options) => {
    const guidance = [
      ...(options.allowedDomains?.length ? [`prefer results from these domains: ${options.allowedDomains.join(", ")}`] : []),
      ...(options.blockedDomains?.length ? [`exclude results from these domains: ${options.blockedDomains.join(", ")}`] : []),
      ...(options.recency ? [`prefer results from the last ${options.recency}`] : []),
      ...(options.language ? [`prefer language ${options.language}`] : []),
      ...(options.region ? [`prefer region ${options.region}`] : []),
    ];
    const guidanceText = guidance.length ? ` (${guidance.join("; ")})` : "";
    const result = await callMcpTool({
      fetch: runtime.fetch,
      endpoint: DEFAULT_PARALLEL_MCP_ENDPOINT,
      provider: "Parallel",
      tool: "web_search",
      arguments: {
        objective: `${objectiveGuidance(query, options)}${guidanceText}`,
        search_queries: [domainQuery(query, options)],
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

const objectiveGuidance = (query: string, options: SearchOptions): string => [options.objective || query,
  ...(options.preferredDomains?.length ? [`Prefer sources from ${options.preferredDomains.join(", ")}; other sources are allowed.`] : []),
].join("\n");

/** Domain operands are validated hostnames, not arbitrary query syntax. */
const domainQuery = (query: string, options: SearchOptions): string => [
  query,
  ...(options.allowedDomains?.length ? [`(${options.allowedDomains.map(domain => `site:${domain}`).join(" OR ")})`] : []),
  ...(options.blockedDomains ?? []).map(domain => `-site:${domain}`),
].join(" ");

const braveProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-brave",
  capabilities: { pagination: "offset", domains: "operator", recency: "native", language: "native", region: "native", excerpts: false },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", domainQuery(query, options));
    endpoint.searchParams.set("count", String(Math.min(options.limit ?? 10, 20)));
    if (options.language) endpoint.searchParams.set("search_lang", options.language);
    if (options.region) endpoint.searchParams.set("country", options.region.toUpperCase());
    // Brave paginates by a 0..9 offset page index, not a result offset.
    const offset = options.page?.kind === "offset" ? options.page.value : 0;
    if (offset > 0) endpoint.searchParams.set("offset", String(Math.min(offset, 9)));
    if (options.recency) endpoint.searchParams.set("freshness", ({ day: "pd", week: "pw", month: "pm", year: "py" })[options.recency]);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: { Accept: "application/json", "X-Subscription-Token": requireCredential(settings, runtime.apiKey) },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Brave");
    // Brave may omit the web vertical when there are no web hits. A present,
    // malformed vertical/result list is a protocol failure, not zero matches.
    if (payload.error != null || (payload.web == null && payload.type !== "search" && !isRecord(payload.query))) {
      throw new SearchProviderError({ kind: "protocol", message: "Brave returned an invalid search response" });
    }
    if (payload.web != null && !isRecord(payload.web)) {
      throw new SearchProviderError({ kind: "protocol", message: "Brave returned an invalid web result object" });
    }
    const web = isRecord(payload.web) ? payload.web : undefined;
    const queryMeta = isRecord(payload.query) ? payload.query : {};
    const moreAvailable = queryMeta.more_results_available === true && offset < 9;
    return {
      results: normalizeResults(web === undefined ? [] : requireResults(web.results, "Brave"), "search-description"),
      ...(moreAvailable ? { nextPage: { kind: "offset" as const, value: offset + 1 } } : {}),
    };
  },
});

const exaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-exa",
  capabilities: { pagination: false, objective: true, domains: "native", recency: "native", language: "unsupported", region: "unsupported", excerpts: true },
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": requireCredential(settings, runtime.apiKey) },
      body: JSON.stringify({
        query,
        numResults: Math.min(options.limit ?? 10, 100),
        ...(options.objective || options.preferredDomains?.length ? { objective: objectiveGuidance(query, options) } : {}),
        contents: { highlights: true },
        ...(options.allowedDomains?.length ? { includeDomains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { excludeDomains: options.blockedDomains } : {}),
        ...(options.recency ? { startPublishedDate: recencyStart(options.recency, runtime.now()) } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Exa");
    return { results: normalizeResults(requireResults(payload.results, settings.provider), "provider-excerpt") };
  },
});

const tavilyProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-tavily",
  capabilities: { pagination: false, domains: "native", recency: "native", language: "native", region: "native", excerpts: true },
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: Math.min(options.limit ?? 10, 20),
        ...(options.language ? { language: options.language, filter_by_language: options.strictFilters === true } : {}),
        ...(options.region ? { country: new Intl.DisplayNames(["en"], { type: "region" }).of(options.region.toUpperCase())?.toLowerCase() } : {}),
        ...(options.allowedDomains?.length ? { include_domains: options.allowedDomains } : options.preferredDomains?.length ? { include_domains: options.preferredDomains, include_domains_mode: "boost" } : {}),
        ...(options.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
        ...(options.recency ? { time_range: options.recency, include_published_date: true, filter_by_published_date: options.strictFilters === true } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Tavily");
    return { results: normalizeResults(requireResults(payload.results, settings.provider), "provider-excerpt") };
  },
});

const jinaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-jina",
  capabilities: { pagination: false, domains: "operator", recency: "native", language: "native", region: "native", excerpts: true },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", domainQuery(query, options));
    endpoint.searchParams.set("num", String(Math.min(options.limit ?? 10, 20)));
    if (options.recency) endpoint.searchParams.set("tbs", `qdr:${({ day: "d", week: "w", month: "m", year: "y" })[options.recency]}`);
    if (options.language) endpoint.searchParams.set("hl", options.language);
    if (options.region) endpoint.searchParams.set("gl", options.region.toLowerCase());
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Jina");
    const values = requireResults(payload.data ?? payload.results, "Jina");
    return { results: normalizeResults(values, "provider-excerpt").slice(0, options.limit ?? 10) };
  },
});

const searxngProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-searxng",
  capabilities: { pagination: "page", domains: "operator", recency: "guidance", language: "native", region: "unsupported", excerpts: false },
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    if (endpoint.pathname === "/" || endpoint.pathname === "") endpoint.pathname = "/search";
    endpoint.searchParams.set("q", domainQuery(query, options));
    endpoint.searchParams.set("format", "json");
    if (options.language) endpoint.searchParams.set("language", options.language);
    const page = options.page?.kind === "page" ? options.page.value : 1;
    if (page > 1) endpoint.searchParams.set("pageno", String(page));
    if (options.recency === "week") {
      throw new SearchProviderError({ kind: "unsupported", message: "SearXNG does not support an exact week recency filter; use day, month, or year" });
    }
    if (options.recency) endpoint.searchParams.set("time_range", options.recency);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "SearXNG");
    const raw = requireResults(payload.results, "SearXNG");
    const results = normalizeResults(raw, "search-description");
    // SearXNG does not report a result count; a non-empty page may have a successor.
    return {
      results,
      ...(raw.length > 0 ? { nextPage: { kind: "page" as const, value: page + 1 } } : {}),
    };
  },
});

/** AnySearch's general search API. Its excerpts are not a fetched page body.
 * The API supports a language preference and cn/intl zones, not exact locale filters. */
const anysearchProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-anysearch",
  capabilities: { pagination: false, domains: "post-filter", recency: "unsupported", language: "guidance", region: "guidance", excerpts: true },
  search: async (query, options) => {
    const zone = options.region?.toLowerCase();
    const supportedZone = zone === "cn" || zone === "intl";
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}) },
      body: JSON.stringify({ query, max_results: Math.max(1, Math.min(options.limit ?? 10, 10)),
        ...(options.language ? { language: options.language } : {}), ...(supportedZone ? { zone } : {}) }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "AnySearch");
    if (payload.code !== undefined && payload.code !== 0) {
      const code = payload.code;
      const kind = code === 401 || code === 403 ? "authentication" : code === 429 ? "rate-limited" : "protocol";
      throw new SearchProviderError({ kind, message: `AnySearch search returned ${kind === "authentication" ? "an authentication error" : kind === "rate-limited" ? "a rate limit error" : "an API error"}${typeof code === "number" ? ` (code ${code})` : ""}` });
    }
    const results = requireResults(isRecord(payload.data) ? payload.data.results : undefined, "AnySearch");
    const normalized = normalizeResults(results, "provider-excerpt");
    if (results.length && !normalized.length) throw new SearchProviderError({ kind: "protocol", message: "AnySearch search returned malformed results" });
    const notices = [
      ...(options.region && !supportedZone ? [`AnySearch supports only cn/intl zone preferences; region ${options.region} was not applied.`] : []),
      ...((options.limit ?? 10) > 10 ? ["AnySearch returns at most 10 results per search and does not expose pagination."] : []),
    ];
    return { results: normalized, ...(notices.length ? { notices } : {}) };
  },
});

export const parseSearchProviderSettings = (value: unknown): HarnessWebSearchSettings | null => {
  if (!isRecord(value)) return null;
  const provider = value.provider;
  if (provider !== "brave" && provider !== "exa" && provider !== "tavily" && provider !== "jina" && provider !== "searxng" && provider !== "anysearch") return null;
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
  if (settings.provider === "anysearch") return anysearchProvider(settings, runtime);
  return searxngProvider(settings, runtime);
};

export const searchFilterApplication = (provider: SearchProvider, options: SearchOptions): WebSearchAppliedFilter[] => {
  const capability = provider.capabilities;
  const applied: WebSearchAppliedFilter[] = [];
  if (options.preferredDomains?.length) applied.push({ field: "preferredDomains", method: provider.id.includes("exa") || provider.id.includes("parallel") ? "guidance" : provider.id === "configured-tavily" && !options.allowedDomains?.length ? "native" : "ranking" });
  if (options.allowedDomains !== undefined) applied.push({ field: "allowedDomains", method: capability.domains ?? "post-filter", verified: true });
  if (options.blockedDomains?.length) applied.push({ field: "blockedDomains", method: capability.domains ?? "post-filter", verified: true });
  if (options.recency) applied.push({ field: "recency", method: capability.recency === "native" ? "native" : capability.recency === "guidance" ? "guidance" : "unsupported",
    basis: provider.id.includes("exa") ? "published" : "provider-defined" });
  for (const field of ["language", "region"] as const) {
    if (options[field]) applied.push({ field, method: field === "region" && provider.id === "configured-anysearch"
      && !["cn", "intl"].includes(options.region!.toLowerCase()) ? "unsupported" : capability[field] ?? "unsupported" });
  }
  return applied;
};

const unsupportedFilter = (provider: SearchProvider, options: SearchOptions): string | undefined => {
  if (!options.strictFilters) return undefined;
  const missing = searchFilterApplication(provider, options).filter(filter => filter.field !== "preferredDomains" && (filter.method === "unsupported" || filter.method === "guidance" || filter.method === "post-filter"));
  // Locale parameters commonly bias ranking; only Tavily exposes explicit language filtering.
  if (options.language && provider.id !== "configured-tavily") missing.push({ field: "language", method: "unsupported" });
  if (options.region) missing.push({ field: "region", method: "unsupported" });
  return missing.length ? `${provider.id} cannot strictly apply: ${[...new Set(missing.map(filter => filter.field))].join(", ")}` : undefined;
};

/** Shared parser for preparation, API settings and legacy migration. */
export const parseSearchSettings = parseHarnessWebSearchSettings;

export const resolveConfiguredSearchProvider = (input: {
  settings?: unknown;
  auth: unknown;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ResolveSearchProviderResult => {
  const runtime: SearchProviderRuntime = { apiKey: null, fetch: input.fetch ?? globalThis.fetch, now: input.now ?? Date.now };
  const settings = input.settings === undefined ? undefined : parseHarnessWebSearchSettings(input.settings);
  if (settings === null) return { unavailable: true, hint: "invalid search provider configuration", failure: { kind: "not-configured", message: "invalid search provider configuration" } };
  if (settings?.enabled === false) return { unavailable: true, hint: "web search connections are disabled", failure: { kind: "disabled", message: "web search connections are disabled" } };
  type Entry = { info: WebSearchConnectionInfo; provider: SearchProvider; failure?: WebSearchFailure };
  const entries: Entry[] = settings?.connections ? settings.connections.map(connection => {
    const apiKey = resolveSearchCredential(input.auth, connection.credentialRef);
    const provider = createConfiguredSearchProvider(connection, { apiKey, fetch: runtime.fetch, now: runtime.now });
    let failure: WebSearchFailure | undefined;
    if (!connection.enabled) failure = { kind: "disabled", message: "search connection is disabled" };
    else if (connection.provider !== "searxng" && connection.provider !== "anysearch" && !apiKey) failure = { kind: "not-configured", message: connection.credentialRef ? `search credential is unavailable: ${connection.credentialRef}` : `search credential reference is required for ${connection.provider}` };
    else {
      try { endpointFor(connection); }
      catch (error) { failure = { kind: "not-configured", message: conciseFailure(error, "invalid search endpoint") }; }
    }
    return { provider, ...(failure ? { failure } : {}), info: { id: connection.id, name: connection.name,
      providerId: provider.id, enabled: connection.enabled, available: !failure, capabilities: provider.capabilities,
      ...(connection.description ? { description: connection.description } : {}), ...(failure ? { detail: failure.message } : {}) } };
  }) : [exaMcpProvider(runtime), parallelMcpProvider(runtime)].map(provider => ({ provider,
    info: { id: provider.id, name: provider.id === "default-exa" ? "Exa · keyless" : "Parallel · keyless", providerId: provider.id,
      enabled: true, available: true, capabilities: provider.capabilities } }));
  const defaultId = settings?.defaultConnectionId ?? (settings?.connections ? settings.connections.find(connection => connection.enabled)?.id : "default-exa");
  const route = [...new Set([...(defaultId ? [defaultId] : []), ...(settings?.connections ? settings.fallbackConnectionIds : ["default-parallel"])])];
  const defaultEntry = entries.find(entry => entry.info.id === defaultId);
  const cacheKey = createHash("sha256").update(JSON.stringify({ settings: settings ?? "default", credentials: settings?.connections?.map(connection => resolveSearchCredential(input.auth, connection.credentialRef)) })).digest("hex");
  return {
    id: defaultId ?? "none", cacheKey, connections: entries.map(entry => entry.info), smartSelection: settings?.smartSelection === true,
    capabilities: defaultEntry?.provider.capabilities ?? { pagination: false },
    search: async (query, options) => {
      const selected = options.connectionId ? [options.connectionId] : options.autoPreferredConnectionId ? [...new Set([options.autoPreferredConnectionId, ...route])] : route;
      const attempts: WebSearchAttempt[] = [];
      for (const id of selected) {
        options.signal?.throwIfAborted();
        const entry = entries.find(candidate => candidate.info.id === id);
        if (!entry) {
          const failure: WebSearchFailure = { kind: "not-configured", message: `unknown search connection: ${id}` };
          attempts.push({ connectionId: id, providerId: "none", status: "unavailable", failure });
          continue;
        }
        // Explicitly disabled connections never run, including if present in fallback settings.
        if (entry.failure) {
          attempts.push({ connectionId: id, providerId: entry.provider.id, status: "unavailable", failure: entry.failure });
          continue;
        }
        const missing = unsupportedFilter(entry.provider, options);
        if (missing) {
          attempts.push({ connectionId: id, providerId: entry.provider.id, status: "unsupported", failure: { kind: "unsupported", message: missing } });
          continue;
        }
        try {
          const response = await entry.provider.search(query, options);
          attempts.push({ connectionId: id, providerId: entry.provider.id, status: response.results.length ? "ok" : "empty" });
          const appliedFilters = searchFilterApplication(entry.provider, options);
          const notices = [
            ...attempts.slice(0, -1).map(attempt => `${attempt.connectionId} failed (${attempt.failure?.message ?? attempt.status}); used ${id}.`),
            ...appliedFilters.filter(filter => filter.method === "unsupported" || filter.method === "guidance" || filter.method === "post-filter").map(filter => `${id}: ${filter.field} uses ${filter.method}; exact matching is not guaranteed.`),
            ...(response.notices ?? []),
          ];
          return { ...response, connectionId: id, providerId: entry.provider.id, capabilities: entry.provider.capabilities,
            attempts, appliedFilters, ...(notices.length ? { notices } : {}) };
        } catch (error) {
          if (isCancellation(error, options.signal)) throw error;
          const failure = classifySearchFailure(error);
          attempts.push({ connectionId: id, providerId: entry.provider.id, status: failure.kind === "unsupported" ? "unsupported" : "failed", failure });
        }
      }
      const last = attempts.at(-1)?.failure ?? { kind: "not-configured" as const, message: "No enabled search route is configured" };
      throw new SearchProviderError(last, attempts);
    },
  };
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

export function createWebSearchService<C extends { signal: AbortSignal } = { signal: AbortSignal }>(
  resolveProvider: (ctx: C) => Promise<ResolveSearchProviderResult>,
  resolveDomainPolicy: (ctx: C) => Promise<HarnessWebDomainPolicy> = async () => ({ block: [] }),
  deps: {
    fetchUrl?: (url: string, ctx: C) => Promise<FetchResult>;
    resolveSourcePreferences?: (ctx: C) => Promise<HarnessWebSourcePreferences>;
    selectConnection?: (input: { request: WebSearchRequest; connections: WebSearchConnectionInfo[]; signal: AbortSignal }, ctx: C) => Promise<{ connectionId?: string; reason?: string }>;
    now?: () => number;
    /** Rebuildable response cache budget, independent from retained material. */
    cacheTtlMs?: number;
    cacheMaxBytes?: number;
    cacheMaxEntries?: number;
  } = {},
): { handle(params: WebSearchRequest, ctx: C): Promise<WebSearchResult>; dispose(): Promise<void> } {
  type Cached = { response: SearchProviderResponse; retrievedAt: number; expires: number; bytes: number };
  type Producer = { controller: AbortController; readers: number; promise: Promise<Cached> };
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Producer>();
  const latest = new Map<string, Producer>();
  const producers = new Set<Producer>();
  const identities = new WeakMap<SearchProvider, number>();
  let nextIdentity = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cacheBytes = 0;
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? 60_000;
  const maxBytes = deps.cacheMaxBytes ?? 8 * 1024 * 1024;
  const maxEntries = deps.cacheMaxEntries ?? 128;
  const drop = (key: string) => { const entry = cache.get(key); if (entry) cacheBytes -= entry.bytes; cache.delete(key); };
  const prune = () => {
    clearTimeout(timer); timer = undefined;
    const timestamp = now();
    for (const [key, value] of cache) if (value.expires <= timestamp) drop(key);
    while ((cacheBytes > maxBytes || cache.size > maxEntries) && cache.size) drop(cache.keys().next().value!);
    if (cache.size && !disposed) {
      timer = setTimeout(prune, Math.max(1, Math.min(...[...cache.values()].map(entry => entry.expires)) - timestamp));
      timer.unref?.();
    }
  };
  const request = async (provider: SearchProvider, query: string, options: SearchOptions, signal: AbortSignal, refresh: boolean) => {
    signal.throwIfAborted();
    if (disposed) throw new DOMException("Search service is closed", "AbortError");
    if (!identities.has(provider)) identities.set(provider, ++nextIdentity);
    const keyFor = (value: SearchOptions) => {
      const { signal: _signal, ...semanticOptions } = value;
      // Initial upstream pages and defaults have one cache identity regardless
      // of whether they came from a fresh call or a continuation cursor.
      if (semanticOptions.page?.value === (semanticOptions.page?.kind === 'page' ? 1 : 0)) delete semanticOptions.page;
      if (semanticOptions.limit === 10) delete semanticOptions.limit;
      return JSON.stringify([provider.cacheKey ?? identities.get(provider), query,
        Object.fromEntries(Object.entries(semanticOptions).sort(([a], [b]) => a.localeCompare(b)))]);
    };
    const key = keyFor(options);
    prune();
    const cached = !refresh ? cache.get(key) : undefined;
    if (cached) return { ...structuredClone(cached), fromCache: true };
    // A refresh is a new observation and never attaches to an older producer.
    const pendingKey = refresh ? `${key}:refresh:${++nextIdentity}` : key;
    let producer = pending.get(pendingKey);
    if (!producer) {
      const controller = new AbortController();
      producer = { controller, readers: 0, promise: undefined! };
      const current = producer;
      pending.set(pendingKey, current); producers.add(current); latest.set(key, current);
      current.promise = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const response = await provider.search(query, { ...options, signal: controller.signal });
        controller.signal.throwIfAborted();
        const retrievedAt = now();
        const entry: Cached = { response, retrievedAt, expires: retrievedAt + ttl, bytes: new TextEncoder().encode(key + JSON.stringify(response)).byteLength };
        if (!disposed && latest.get(key) === current && ttl > 0 && entry.bytes <= maxBytes) {
          const { autoPreferredConnectionId: _preferred, ...exact } = options;
          const exactKey = keyFor({ ...exact, connectionId: response.connectionId ?? options.connectionId ?? provider.id });
          for (const cacheKey of new Set([key, exactKey])) {
            // Do not let an older automatic lookup overwrite a newer explicit
            // observation. Each cursor will also verify its page ordering.
            if (cacheKey !== key && latest.has(cacheKey) && latest.get(cacheKey) !== current) continue;
            drop(cacheKey); cache.set(cacheKey, structuredClone(entry)); cacheBytes += entry.bytes;
          }
          prune();
        }
        return entry;
      }).finally(() => { if (pending.get(pendingKey) === current) pending.delete(pendingKey); producers.delete(current); if (latest.get(key) === current) latest.delete(key); });
    }
    const current = producer;
    current.readers++;
    return new Promise<Cached & { fromCache: boolean }>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true; signal.removeEventListener("abort", abort); current.readers--;
        if (!current.readers && producers.has(current)) {
          if (pending.get(pendingKey) === current) pending.delete(pendingKey);
          current.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        const cancelled = () => reject(new DOMException("cancelled", "AbortError"));
        // Last-reader cancellation does not certify physical executor stop.
        // Drain the original producer before its invocation can be released.
        if (!current.readers && producers.has(current)) void current.promise.then(cancelled, cancelled);
        else cancelled();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      current.promise.then(value => { if (finish()) resolve({ ...structuredClone(value), fromCache: false }); }, error => { if (finish()) reject(error); });
    });
  };
  return {
    async dispose() {
      disposed = true; clearTimeout(timer); cache.clear(); cacheBytes = 0;
      const work = [...producers];
      for (const producer of work) producer.controller.abort();
      await Promise.allSettled(work.map(producer => producer.promise));
      pending.clear();
    },
    handle: async (params, ctx) => {
      const preferences = await deps.resolveSourcePreferences?.(ctx);
      params = { ...params,
        ...(params.preferredDomains === undefined && preferences?.preferredDomains ? { preferredDomains: preferences.preferredDomains } : {}),
        ...(params.blockedDomains === undefined && preferences?.excludedDomains ? { blockedDomains: preferences.excludedDomains } : {}),
      };
      const objective = params.objective?.trim();
      const queries = [params.query, ...(params.queries ?? [])].map(value => typeof value === "string" ? value.trim() : "").filter(Boolean);
      const queryItems: Array<{ kind: "query" | "objective"; query: string }> = queries.map(query => ({ kind: "query", query }));
      if (!queryItems.length && objective) queryItems.push({ kind: "objective", query: objective });
      const urlItems = [...new Set((params.urls ?? []).map(value => typeof value === "string" ? value.trim() : "").filter(Boolean))];
      const cursorRaw = params.cursor?.trim();
      if (!queryItems.length && !urlItems.length && !cursorRaw && params.action !== "connections") throw new HarnessServiceError("invalid-params", "web.search requires query, objective, queries, urls, cursor, or action=connections");
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) throw new HarnessServiceError("invalid-params", "limit must be a positive integer");
      if (params.connectionId && params.connectionIds?.length) throw new HarnessServiceError("invalid-params", "Specify connectionId or connectionIds, not both");
      if (params.region && !/^[a-z]{2}$/iu.test(params.region)) throw new HarnessServiceError("invalid-params", "region must be a two-letter country code");
      if (params.language && !/^[a-z]{2,3}(?:-[a-z]{2,8})?$/iu.test(params.language)) throw new HarnessServiceError("invalid-params", "language must be a language code");
      const domainInput = [...(params.allowedDomains ?? []), ...(params.blockedDomains ?? []), ...(params.preferredDomains ?? [])];
      if (domainInput.some(domain => typeof domain !== "string" || !/^[a-z0-9\p{L}](?:[a-z0-9\p{L}.-]*[a-z0-9\p{L}])?$/iu.test(domain))) throw new HarnessServiceError("invalid-params", "domain filters must contain hostnames, not URLs or search operators");
      const notices: string[] = [];
      const providerResult = queryItems.length || cursorRaw || params.action === "connections" ? await resolveProvider(ctx) : null;
      const provider = providerResult && !("unavailable" in providerResult) ? providerResult : null;
      const unavailable = providerResult && "unavailable" in providerResult ? providerResult : null;
      const policy = await resolveDomainPolicy(ctx);
      if ([...(policy.allow ?? []), ...policy.block].some(domain => !/^[a-z0-9\p{L}](?:[a-z0-9\p{L}.-]*[a-z0-9\p{L}])?$/iu.test(domain))) {
        throw new HarnessServiceError("invalid-params", "Configured search domain policy contains an invalid hostname");
      }
      let autoPreferredConnectionId: string | undefined;
      const eligible = provider?.connections?.filter(connection => connection.enabled && connection.available
        && !unsupportedFilter({ id: connection.providerId, capabilities: connection.capabilities, search: async () => ({ results: [] }) }, params)) ?? [];
      if (provider?.smartSelection && deps.selectConnection && !params.connectionId && !params.connectionIds?.length && !cursorRaw && queryItems.length && eligible.length > 1) {
        try {
          const selected = await deps.selectConnection({ request: params, connections: eligible, signal: ctx.signal }, ctx);
          if (selected.connectionId && eligible.some(connection => connection.id === selected.connectionId)) autoPreferredConnectionId = selected.connectionId;
          else notices.push(selected.reason || "Search selection did not choose an available connection; using configured route.");
        } catch (error) {
          if (isRecord(error) && error.code === "web-assistance-indeterminate") throw error;
          if (!isCancellation(error, ctx.signal)) notices.push("Search selection failed; using configured route.");
        }
      }
      const runSearch = async (kind: "query" | "objective" | "page", query: string, input: SearchOptions,
        continuation?: { offset: number; hash: string }): Promise<WebSearchItem> => {
        const echo = { query, ...(input.objective ? { objective: input.objective } : {}), ...(input.connectionId ? { connectionId: input.connectionId } : {}) };
        if (!provider) return { kind, ...echo, status: "unavailable", detail: unavailable?.hint ?? "search provider is unavailable", ...(unavailable?.failure ? { failure: unavailable.failure } : {}) };
        const domains = mergeHarnessWebDomainPolicy(policy, { ...(input.allowedDomains === undefined ? {} : { allow: input.allowedDomains }), ...(input.blockedDomains === undefined ? {} : { block: input.blockedDomains }) });
        if (domains.allow?.length === 0) return { kind, ...echo, status: "denied", detail: "domain allowlist is empty" };
        try {
          const requested: SearchOptions = { ...input,
            ...(domains.allow === undefined ? {} : { allowedDomains: domains.allow }),
            ...(domains.block.length ? { blockedDomains: domains.block } : {}),
            ...(autoPreferredConnectionId && !input.connectionId ? { autoPreferredConnectionId } : {}),
          };
          const { response, retrievedAt, fromCache } = await request(provider, query, requested, ctx.signal, params.refresh === true);
          const providerId = response.providerId ?? provider.id;
          const connectionId = response.connectionId ?? input.connectionId ?? provider.id;
          const ranked = filterByDomainPolicy(response.results, domains.allow, domains.block);
          if (input.preferredDomains?.length) ranked.sort((a, b) => Number(filterByDomainPolicy([b], input.preferredDomains, []).length > 0) - Number(filterByDomainPolicy([a], input.preferredDomains, []).length > 0));
          const pageHash = createHash("sha256").update(JSON.stringify(ranked)).digest("hex");
          if (continuation && (continuation.hash !== pageHash || continuation.offset >= ranked.length)) {
            return { kind, ...echo, connectionId, providerId, status: "failed",
              detail: "The search page or its filtering changed; refresh the original query to continue without skipping results." };
          }
          const offset = continuation?.offset ?? 0;
          const results = ranked.slice(offset, offset + (input.limit ?? 10)).map(result => ({ ...result,
            provenance: [{ connectionId, providerId, query, ...(input.objective ? { objective: input.objective } : {}), retrievedAt }],
          }));
          const pagination = response.capabilities?.pagination ?? provider.capabilities.pagination;
          const remaining = offset + results.length < ranked.length && pagination !== false;
          const nextPage = remaining ? { kind: pagination, value: input.page?.value ?? (pagination === "page" ? 1 : 0) } : response.nextPage;
          const nextCursor = nextPage && nextPage.kind === pagination ? mintSearchCursor({ v: 1, p: providerId, c: connectionId,
            ...(provider.cacheKey ? { config: provider.cacheKey } : {}), q: query, k: nextPage.kind, n: nextPage.value,
            ...(remaining ? { resultOffset: offset + results.length, pageHash } : {}),
            ...(input.objective ? { objective: input.objective } : {}), ...(input.language ? { language: input.language } : {}), ...(input.region ? { region: input.region } : {}),
            ...(input.strictFilters !== undefined ? { strictFilters: input.strictFilters } : {}),
            ...(input.allowedDomains !== undefined ? { allow: input.allowedDomains } : {}), ...(input.blockedDomains ? { block: input.blockedDomains } : {}),
            ...(input.preferredDomains ? { prefer: input.preferredDomains } : {}),
            ...(input.recency ? { recency: input.recency } : {}), ...(input.limit ? { limit: input.limit } : {}),
          }) : undefined;
          notices.push(...(response.notices ?? []));
          return { kind, ...echo, connectionId, providerId, retrievedAt, fromCache, status: results.length ? "ok" : "empty", results,
            ...(response.attempts ? { attempts: response.attempts } : {}), appliedFilters: response.appliedFilters ?? searchFilterApplication(provider, requested),
            ...(nextCursor ? { nextCursor } : {}),
          };
        } catch (error) {
          const failure = isCancellation(error, ctx.signal) ? { kind: "cancelled" as const, message: "cancelled" } : classifySearchFailure(error);
          return { kind, ...echo, status: failure.kind === "cancelled" ? "cancelled" : failure.kind === "unsupported" ? "unsupported" : failure.kind === "not-configured" || failure.kind === "disabled" ? "unavailable" : "failed",
            detail: failure.message, failure, ...(error instanceof SearchProviderError && error.attempts ? { attempts: error.attempts, providerId: error.attempts.at(-1)?.providerId ?? provider.id, connectionId: error.attempts.at(-1)?.connectionId ?? provider.id } : {}) };
        }
      };
      const common: SearchOptions = { ...(objective ? { objective } : {}), ...(params.allowedDomains !== undefined ? { allowedDomains: params.allowedDomains } : {}),
        ...(params.blockedDomains !== undefined ? { blockedDomains: params.blockedDomains } : {}), ...(params.preferredDomains ? { preferredDomains: params.preferredDomains } : {}), ...(params.recency ? { recency: params.recency } : {}),
        ...(params.limit ? { limit: params.limit } : {}), ...(params.language ? { language: params.language } : {}), ...(params.region ? { region: params.region } : {}),
        ...(params.strictFilters !== undefined ? { strictFilters: params.strictFilters } : {}) };
      const selectedConnections = [...new Set(params.connectionIds?.length ? params.connectionIds : [params.connectionId])];
      const runCursor = async (): Promise<WebSearchItem> => {
        const payload = parseSearchCursor(cursorRaw!);
        if (!payload) return { kind: "page", status: "failed", detail: "unknown or malformed cursor" };
        if (payload.config && payload.config !== provider?.cacheKey) return { kind: "page", status: "failed", detail: "search connection configuration changed; refresh the original query" };
        const selected = provider?.connections?.find(connection => connection.id === payload.c);
        if (params.connectionId && params.connectionId !== (payload.c ?? payload.p)) return { kind: "page", status: "failed", detail: "cursor belongs to another connection" };
        if (!selected && payload.p !== provider?.id) return { kind: "page", status: provider?.capabilities.pagination === false ? "unsupported" : "failed", detail: `cursor belongs to provider ${payload.p}, not ${provider?.id ?? "none"}` };
        const pagination = selected?.capabilities.pagination ?? provider?.capabilities.pagination;
        if (pagination !== payload.k) return { kind: "page", status: "unsupported", detail: "provider does not support this pagination cursor" };
        return runSearch("page", payload.q, { connectionId: payload.c ?? payload.p, page: { kind: payload.k, value: payload.n },
          ...(payload.allow !== undefined ? { allowedDomains: payload.allow } : {}), ...(payload.block ? { blockedDomains: payload.block } : {}), ...(payload.prefer ? { preferredDomains: payload.prefer } : {}),
          ...(payload.recency ? { recency: payload.recency } : {}), ...(payload.limit ? { limit: payload.limit } : {}),
          ...(payload.objective ? { objective: payload.objective } : {}), ...(payload.language ? { language: payload.language } : {}), ...(payload.region ? { region: payload.region } : {}),
          ...(payload.strictFilters !== undefined ? { strictFilters: payload.strictFilters } : {}),
        }, payload.resultOffset !== undefined && payload.pageHash ? { offset: payload.resultOffset, hash: payload.pageHash } : undefined);
      };
      const items = await Promise.all([
        ...queryItems.flatMap(item => selectedConnections.map(connectionId => runSearch(item.kind, item.query, { ...common, ...(connectionId ? { connectionId } : {}) }))),
        ...urlItems.map(async (url): Promise<WebSearchItem> => {
          if (!deps.fetchUrl) return { kind: "url", url, status: "unavailable", detail: "host fetch path is not configured" };
          try { ctx.signal.throwIfAborted(); const fetch = await deps.fetchUrl(url, ctx); return { kind: "url", url, fetch, ...mapFetchStatus(fetch) }; }
          catch (error) { return { kind: "url", url, status: isCancellation(error, ctx.signal) ? "cancelled" : "failed", detail: conciseFailure(error, "fetch failed") }; }
        }),
        ...(cursorRaw ? [runCursor()] : []),
      ]);
      const providerIds = [...new Set(items.map(item => item.providerId).filter((id): id is string => Boolean(id)))];
      const merged = new Map<string, SearchResultItem>();
      for (const item of items) for (const result of item.results ?? []) {
        const url = new URL(result.url);
        for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key) || key === "fbclid" || key === "gclid") url.searchParams.delete(key);
        const key = url.href;
        const previous = merged.get(key);
        if (!previous) merged.set(key, structuredClone(result));
        else { previous.provenance = [...(previous.provenance ?? []), ...(result.provenance ?? [])];
          if (previous.excerpts || result.excerpts) previous.excerpts = [...new Set([...(previous.excerpts ?? []), ...(result.excerpts ?? [])])]; }
      }
      return { providerId: providerIds.length > 1 ? "mixed" : providerIds[0] ?? provider?.id ?? "none", ...(objective ? { objective } : {}),
        capabilities: { pagination: Boolean(provider?.connections?.some(connection => connection.capabilities.pagination) || provider?.capabilities.pagination), fetch: Boolean(deps.fetchUrl) },
        items, results: [...merged.values()], ...(params.action === "connections" && provider?.connections ? { connections: provider.connections } : {}),
        ...(unavailable && params.action === "connections" ? { notices: [unavailable.hint] } : notices.length ? { notices: [...new Set(notices)] } : {}),
      };
    },
  };
}
