import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";
import type { WebSearchItem } from "@varin/protocol";

const WebSearchParams = Type.Object({
  query: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String({ description: "Natural-language search objective; used alongside or instead of query." })),
  queries: Type.Optional(Type.Array(Type.String(), { description: "Additional queries in the same batch; each reports its own status." })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "Known URLs to fetch and pin as fixed snapshots in the same batch." })),
  cursor: Type.Optional(Type.String({ description: "Opaque continuation token returned as nextCursor by a previous result page." })),
  allowed_domains: Type.Optional(Type.Array(Type.String())),
  blocked_domains: Type.Optional(Type.Array(Type.String())),
  recency: Type.Optional(Type.Union([
    Type.Literal("day"),
    Type.Literal("week"),
    Type.Literal("month"),
    Type.Literal("year"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const encodeWebText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const itemLabel = (item: WebSearchItem): string => {
  if (item.kind === "objective") return `objective ${JSON.stringify(item.query ?? "")}`;
  if (item.kind === "url") return `url ${item.url ?? ""}`;
  if (item.kind === "page") return "next page";
  return `query ${JSON.stringify(item.query ?? "")}`;
};

const formatResults = (results: WebSearchItem["results"], lines: string[]): void => {
  for (const [index, entry] of (results ?? []).entries()) {
    lines.push(`   ${index + 1}. ${encodeWebText(entry.title)}`);
    lines.push(`      URL: ${entry.url}`);
    if (entry.publishedAt) lines.push(`      Published: ${encodeWebText(entry.publishedAt)}`);
    if (entry.snippet) lines.push(`      ${encodeWebText(entry.snippet)}`);
    if (entry.summary) lines.push(`      summary: ${encodeWebText(entry.summary)}`);
  }
};

export function createWebSearchTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "websearch",
    label: "Web Search",
    description: "Search the web for current information. Accepts a query, a natural-language objective, several queries, known URLs to pin as snapshots, or a cursor from a previous result page. Each requested item reports its own status. Works without search credentials by default; a user-configured provider takes precedence. Use webfetch to read a page or re-read a pinned snapshot.",
    promptSnippet: "websearch: search the web for current information",
    promptGuidelines: [
      "Results contain summaries and source links. webfetch reads a source page or pinned snapshot; nextCursor continues a result page.",
    ],
    parameters: WebSearchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("web.search", {
          ...(params.query ? { query: params.query } : {}),
          ...(params.objective ? { objective: params.objective } : {}),
          ...(params.queries?.length ? { queries: params.queries } : {}),
          ...(params.urls?.length ? { urls: params.urls } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.allowed_domains ? { allowedDomains: params.allowed_domains } : {}),
          ...(params.blocked_domains ? { blockedDomains: params.blocked_domains } : {}),
          ...(params.recency ? { recency: params.recency } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        }, signal ? { signal } : undefined);

        const sources: Array<{ title: string; url: string; snapshotId?: string }> = [];
        const lines: string[] = [`web search (${result.providerId})`, ...(result.notices ?? [])];
        for (const item of result.items) {
          const label = itemLabel(item);
          if (item.kind === "url" && item.fetch?.status === "ok") {
            const fetch = item.fetch;
            lines.push(`- ${label}: ok — ${fetch.finalUrl} (${fetch.bytes} bytes${fetch.rendered ? ", rendered" : ""})`);
            if (fetch.snapshot) lines.push(`    snapshot_id: ${fetch.snapshot.snapshotId}`);
            sources.push({ title: fetch.title ?? fetch.finalUrl, url: fetch.finalUrl, ...(fetch.snapshot ? { snapshotId: fetch.snapshot.snapshotId } : {}) });
            continue;
          }
          if (item.status === "ok" || item.status === "empty") {
            const count = item.results?.length ?? 0;
            lines.push(`- ${label}: ${count === 0 ? "empty (no results)" : `${count} results`}`);
            formatResults(item.results, lines);
            for (const entry of item.results ?? []) sources.push({ title: entry.title, url: entry.url });
            if (item.nextCursor) lines.push(`    more pages: websearch({cursor: "${item.nextCursor}"})`);
            continue;
          }
          lines.push(`- ${label}: ${item.status}${item.detail ? ` — ${item.detail}` : ""}`);
        }

        const usable = result.items.some((item) => item.status === "ok" || item.status === "empty");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            kind: "websearch",
            providerId: result.providerId,
            capabilities: result.capabilities,
            count: result.items.reduce((sum, item) => sum + (item.results?.length ?? 0), 0),
            notices: result.notices ?? [],
            items: result.items.map((item) => ({
              kind: item.kind,
              status: item.status,
              ...(item.query ? { query: item.query } : {}),
              ...(item.url ? { url: item.url } : {}),
              ...(item.nextCursor ? { nextCursor: item.nextCursor } : {}),
              ...(item.detail ? { detail: item.detail } : {}),
            })),
            sources,
          },
          ...(usable ? {} : { isError: true }),
        };
      } catch (error) {
        const unavailable = error instanceof HarnessRequestError && error.code === "unavailable";
        return {
          content: [{
            type: "text",
            text: `${unavailable ? "websearch unavailable" : "websearch error"}: ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { kind: "websearch", providerId: "error", count: 0 },
          isError: true,
        };
      }
    },
  });
}
