import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThreadFactsSetResult } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";

const FactSource = Type.Object({
  kind: Type.Union([Type.Literal("local"), Type.Literal("url"), Type.Literal("output")]),
  path: Type.Optional(Type.String()),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  endLine: Type.Optional(Type.Integer({ minimum: 1 })),
  url: Type.Optional(Type.String()),
  receiptId: Type.Optional(Type.String()),
  outputRef: Type.Optional(Type.Object({
    durability: Type.Literal("ephemeral"),
    generation: Type.String(),
    handle: Type.String(),
  })),
});

const SubmitFactsParams = Type.Object({
  question: Type.String(),
  facts: Type.Array(Type.Object({
    claim: Type.String(),
    sources: Type.Array(FactSource),
  })),
  unknowns: Type.Optional(Type.Array(Type.String())),
  attempted: Type.Optional(Type.Array(Type.Object({
    action: Type.String(),
    outcome: Type.Union([
      Type.Literal("rejected"),
      Type.Literal("unavailable"),
      Type.Literal("empty"),
      Type.Literal("failed"),
    ]),
    detail: Type.Optional(Type.String()),
  }))),
});

export function createSubmitFactsTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "submit_facts",
    label: "Submit Facts",
    description: "Optionally attach structured facts to this retrieval thread's natural-language report. The Host checks local paths, ranges, and URL receipts, then marks valid sources source-checked. It cannot prove a claim is true.",
    promptSnippet: "submit_facts: optionally attach Host-validated facts, sources, and unknowns to a retrieval report",
    promptGuidelines: [
      "Structured facts use question, facts[].claim/sources, unknowns, and attempted. Source checking verifies addresses and access, not the truth of a claim.",
    ],
    parameters: SubmitFactsParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.facts.set">("thread.facts.set", {
          question: params.question,
          facts: params.facts,
          ...(params.unknowns !== undefined ? { unknowns: params.unknowns } : {}),
          ...(params.attempted !== undefined ? { attempted: params.attempted } : {}),
        }, signal ? { signal } : undefined);
        const typed = result as ThreadFactsSetResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: { completion: typed.evidence.completion, facts: typed.evidence.facts.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof HarnessRequestError ? error.code : "failed";
        return {
          content: [{ type: "text", text: `submit_facts failed (${code}): ${message}` }],
          isError: true,
          details: { code },
        };
      }
    },
  });
}
