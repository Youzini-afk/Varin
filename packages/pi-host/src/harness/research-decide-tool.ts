import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResearchDecideResult } from "@varin/protocol";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";

const CandidateSchema = Type.Object({
  id: Type.String({ description: "Caller-assigned id joining options to ranked results." }),
  kind: Type.Union([
    Type.Literal("url"),
    Type.Literal("snapshot"),
    Type.Literal("paper"),
    Type.Literal("section"),
    Type.Literal("query"),
  ]),
  title: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String({ description: "Snippet, abstract, heading path, or query text the model may judge." })),
  url: Type.Optional(Type.String()),
  snapshot_id: Type.Optional(Type.String()),
  section: Type.Optional(Type.Object({
    snapshot_id: Type.String(),
    start_line: Type.Optional(Type.Number()),
    end_line: Type.Optional(Type.Number()),
    label: Type.Optional(Type.String()),
  })),
  paper: Type.Optional(Type.Object({
    provider_id: Type.String(),
    provider_record_id: Type.String(),
    doi: Type.Optional(Type.String()),
  })),
});

const ResearchDecideParams = Type.Object({
  goal: Type.String({ description: "The investigation objective the candidates are judged against." }),
  kind: Type.Union([
    Type.Literal("relevance"),
    Type.Literal("reading-value"),
    Type.Literal("complementary"),
    Type.Literal("duplicate"),
    Type.Literal("continuation"),
    Type.Literal("next"),
  ], { description: "Judgment kind: per-candidate scoring, or 'next' to choose one candidate to open." }),
  candidates: Type.Array(CandidateSchema, { minItems: 1 }),
  purpose: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("scholarly")], {
    description: "Fast-decision purpose slot; inferred from candidate kinds when absent.",
  })),
});

const encode = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function createResearchDecideTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "research_decide",
    label: "Research Decide",
    description: "Batch-judge real Web/scholarly candidates (URLs, snapshots, papers, sections, queries) with the configured fast-decision model. The model only selects or scores candidates you supply; when it is disabled or unavailable the original order is returned and your own judgment applies.",
    promptSnippet: "research_decide: fast-decision ranking over real URL/snapshot/paper/section/query candidates",
    promptGuidelines: [
      "kind=next selects one supplied candidate; scoring kinds rank them. Missing scores mean unevaluated. Disabled or unavailable inference retains the supplied order.",
    ],
    parameters: ResearchDecideParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request("research.decide", {
          goal: params.goal,
          kind: params.kind,
          ...(params.purpose ? { purpose: params.purpose } : {}),
          candidates: params.candidates.map((candidate) => ({
            id: candidate.id,
            kind: candidate.kind,
            ...(candidate.title ? { title: candidate.title } : {}),
            ...(candidate.detail ? { detail: candidate.detail } : {}),
            ...(candidate.url ? { url: candidate.url } : {}),
            ...(candidate.snapshot_id ? { snapshotId: candidate.snapshot_id } : {}),
            ...(candidate.section ? {
              section: {
                snapshotId: candidate.section.snapshot_id,
                ...(candidate.section.start_line !== undefined ? { startLine: candidate.section.start_line } : {}),
                ...(candidate.section.end_line !== undefined ? { endLine: candidate.section.end_line } : {}),
                ...(candidate.section.label ? { label: candidate.section.label } : {}),
              },
            } : {}),
            ...(candidate.paper ? {
              paper: {
                providerId: candidate.paper.provider_id,
                providerRecordId: candidate.paper.provider_record_id,
                ...(candidate.paper.doi ? { doi: candidate.paper.doi } : {}),
              },
            } : {}),
          })),
        }, signal ? { signal } : undefined) as ResearchDecideResult;

        const lines = result.ranked.map((item) => {
          const marker = [
            item.selected ? "SELECTED" : "",
            item.score !== undefined ? `score=${item.score}` : "",
          ].filter(Boolean).join(" ");
          return `  ${item.id}${marker ? `  ${marker}` : ""}`;
        });
        const extra = [
          result.missing.length ? `Unevaluated: ${result.missing.join(", ")}` : "",
          result.rejected.length ? `Rejected: ${result.rejected.map((item) => `${item.id} (${item.reason})`).join(", ")}` : "",
          result.status !== "ok"
            ? `Fast decision ${result.status}${result.message ? `: ${encode(result.message)}` : ""}; ranked keeps your original order.`
            : "",
          result.providerId ? `Provider: ${result.providerId} ${result.servedModelId ?? result.modelId ?? ""}` : "",
        ].filter(Boolean).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `research_decide ${result.status} (${result.kind}, ${result.purpose}):\n${lines.join("\n")}${extra ? `\n${extra}` : ""}`,
          }],
          details: {
            kind: "research_decide",
            status: result.status,
            decideKind: result.kind,
            purpose: result.purpose,
            ranked: result.ranked,
            missing: result.missing,
            rejected: result.rejected,
            ...(result.providerId ? { provider: result.providerId } : {}),
            ...(result.configurationId ? { configurationId: result.configurationId } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            sources: params.candidates.flatMap((candidate) => {
              const url = candidate.url;
              if (!url) return [];
              const rank = result.ranked.find((item) => item.id === candidate.id);
              return [{
                url,
                title: candidate.title ?? url,
                ...(candidate.snapshot_id ? { snapshotId: candidate.snapshot_id } : {}),
                ...(candidate.paper?.provider_id ? { provider: candidate.paper.provider_id } : {}),
                ...(candidate.paper?.provider_record_id ? { paperId: candidate.paper.provider_record_id } : {}),
                ...(rank?.score !== undefined ? { relation: `decide:${rank.score}` } : {}),
              }];
            }),
          },
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `research_decide failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { kind: "research_decide", status: "failed" },
          isError: !(error instanceof HarnessRequestError && error.code === "unavailable"),
        };
      }
    },
  });
}
