import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ScholarlySearchResult } from "@varin/protocol";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";

const ResearchSearchParams = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("paper"),
    Type.Literal("relations"),
  ]),
  provider: Type.Optional(Type.Union([Type.Literal("openalex"), Type.Literal("semantic-scholar")])),
  query: Type.Optional(Type.String()),
  paper_id: Type.Optional(Type.String()),
  relation: Type.Optional(Type.Union([
    Type.Literal("references"),
    Type.Literal("citations"),
    Type.Literal("related"),
  ], { description: "Required with action=relations: outgoing references, incoming citations, or provider related works." })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const encode = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type ResearchSearchDetails = {
  kind: "research-search";
  status: ScholarlySearchResult["status"];
  provider?: string;
  action?: string;
  relation?: string;
  papers: unknown[] | number;
  capabilities?: string[];
  relationKinds?: string[];
  nextCursor?: string;
  sources?: Array<{ url: string; title: string; provider?: string; paperId?: string; relation?: string }>;
};

const details = (value: ResearchSearchDetails): ResearchSearchDetails => value;

const formatPaper = (paper: ScholarlySearchResult["papers"][number], index?: number): string => {
  const prefix = index === undefined ? "" : `${index + 1}. `;
  const lines = [`${prefix}${encode(paper.title)} [${paper.provider}:${paper.id}]`];
  if (paper.year !== undefined) lines.push(`   Year: ${paper.year}`);
  if (paper.authors.length) lines.push(`   Authors: ${paper.authors.slice(0, 8).map((author) => encode(author.name)).join(", ")}`);
  if (paper.doi) lines.push(`   DOI: ${encode(paper.doi)}`);
  if (paper.externalIds?.arxiv) lines.push(`   arXiv: ${encode(paper.externalIds.arxiv)}`);
  if (paper.version) lines.push(`   Version: ${paper.version}`);
  if (paper.landingUrl) lines.push(`   URL: ${paper.landingUrl}`);
  if (paper.openAccessUrl) lines.push(`   Open access: ${paper.openAccessUrl}`);
  lines.push(`   Content: ${paper.content}`);
  if (paper.abstract) lines.push(`   Abstract: ${encode(paper.abstract)}`);
  return lines.join("\n");
};

const paperSource = (paper: ScholarlySearchResult["papers"][number], relation?: string) => {
  const url = paper.landingUrl ?? paper.openAccessUrl;
  return url
    ? [{
      url,
      title: paper.title,
      provider: paper.provider,
      paperId: paper.id,
      ...(relation ? { relation } : {}),
    }]
    : [];
};

export function createResearchSearchTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "research_search",
    label: "Research Search",
    description: "Search scholarly metadata, look up one paper, or expand its references/citations/related works through OpenAlex or Semantic Scholar. Metadata discovery is separate from reading the linked source.",
    promptSnippet: "research_search: find papers, metadata, relations, and open-access locations",
    promptGuidelines: [
      "paper_id is a provider's returned paper identity. relations returns one page and nextCursor; cursor continues that page sequence.",
      "Results are scholarly metadata and source locations, not the linked paper's full content.",
    ],
    parameters: ResearchSearchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request("research.search", {
          action: params.action,
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.query ? { query: params.query } : {}),
          ...(params.paper_id ? { paperId: params.paper_id } : {}),
          ...(params.relation ? { relation: params.relation } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        }, signal ? { signal } : undefined) as ScholarlySearchResult;
        if (result.status === "failed" || result.status === "unavailable") {
          return {
            content: [{ type: "text", text: `research_search ${result.status}: ${result.message ?? "no further detail"}` }],
            details: details({
              kind: "research-search",
              status: result.status,
              provider: result.provider,
              ...(params.relation ? { relation: params.relation } : {}),
              papers: 0,
              capabilities: result.capabilities,
              ...(result.relationKinds ? { relationKinds: result.relationKinds } : {}),
            }),
            isError: result.status === "failed",
          };
        }
        const relationLabel = result.relation
          ? ` ${result.relation.kind} of ${result.relation.source.provider}:${result.relation.source.id}`
          : "";
        const header = `${result.status === "empty" ? "No papers" : `${result.papers.length} papers`} (${result.provider}, ${result.action}${relationLabel})`;
        const body = result.papers.map((paper, index) => formatPaper(paper, index)).join("\n");
        const next = result.nextCursor ? `\nNext cursor: ${result.nextCursor}` : "";
        return {
          content: [{ type: "text", text: `${header}${body ? `\n${body}` : ""}${next}\nMetadata is not paper content; use webfetch on a trusted landing/open-access URL to read it.` }],
          details: details({
            kind: "research-search",
            status: result.status,
            provider: result.provider,
            action: result.action,
            ...(result.relation ? { relation: result.relation.kind } : {}),
            papers: result.papers.map((paper) => ({
              id: paper.id,
              title: paper.title,
              provider: paper.provider,
              content: paper.content,
              ...(paper.doi ? { doi: paper.doi } : {}),
              ...(paper.version ? { version: paper.version } : {}),
              ...(paper.externalIds ? { externalIds: paper.externalIds } : {}),
              ...(paper.openAccessUrl ? { openAccessUrl: paper.openAccessUrl } : {}),
              ...(paper.availableFields ? { availableFields: paper.availableFields } : {}),
            })),
            capabilities: result.capabilities,
            ...(result.relationKinds ? { relationKinds: result.relationKinds } : {}),
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            sources: result.papers.flatMap((paper) => paperSource(paper, result.relation?.kind)),
          }),
        };
      } catch (error) {
        const unavailable = error instanceof HarnessRequestError && error.code === "unavailable";
        return {
          content: [{ type: "text", text: `research_search ${unavailable ? "unavailable" : "error"}: ${error instanceof Error ? error.message : String(error)}` }],
          details: details({ kind: "research-search", status: unavailable ? "unavailable" : "failed", papers: 0 }),
          isError: !unavailable,
        };
      }
    },
  });
}
