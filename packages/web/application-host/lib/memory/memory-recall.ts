/**
 * memory-recall — the shared selection service behind automatic Zone 2 recall
 * and the active `recall`/`memory` reads (BC3).
 *
 * Real retrieval always runs through `recallSources`: work-associated rows are
 * pinned ahead of generic text/vector hits, every row is re-read through its
 * authority store, and bot/session scopes carry their own labels. When the
 * `memory-recall` fast-decision purpose resolves to a ready binding, a judge
 * pass then drops candidates that do not contribute to the session's goal —
 * a missing, disabled, or failed binding never blocks retrieval.
 */

import type {
  FastDecisionMaterial,
  FastDecisionQuestion,
  HarnessFastDecisionPurposeStatus,
  HarnessFastDecisionResult,
  HarnessResolvedFastDecisionBinding,
} from "@varin/protocol";
import type { RecallResult } from "../knowledge/store.js";
import {
  recallSources,
  type KnowledgeRecallDetails,
  type KnowledgeVectorRuntime,
  type MemoryRecallAssociation,
  type MemoryRecallSource,
} from "../knowledge/vectors/index.js";

export interface MemoryRecallFastDecision {
  status: (workspaceId: string, purpose: "memory-recall") => Promise<HarnessFastDecisionPurposeStatus>;
  decide: (input: {
    workspaceId: string;
    purpose: "memory-recall";
    settings: HarnessResolvedFastDecisionBinding;
    goal: string;
    materials: FastDecisionMaterial[];
    questions: FastDecisionQuestion[];
    signal?: AbortSignal;
  }) => Promise<HarnessFastDecisionResult>;
}

export interface MemoryRecallInput {
  sources: readonly MemoryRecallSource[];
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  /** The owning scope id — keys vector search (indexes are built per scope). */
  workspaceId?: string;
  /**
   * The caller's execution workspace id — resolves the fast-decision binding.
   * A bot-root session without a workspace simply skips judging.
   */
  judgeWorkspaceId?: string;
  associated?: MemoryRecallAssociation;
  /** The goal the recalled memories must contribute to (owning work brief). */
  goal?: string;
  /**
   * Fast-decision judging for automatic recall. Callers whose reads are
   * explicit (`recall` tool) omit this — an explicit read is never filtered.
   */
  fastDecision?: MemoryRecallFastDecision;
  signal?: AbortSignal;
}

export interface MemoryRecallOutput {
  results: RecallResult[];
  details: KnowledgeRecallDetails;
  judge?: "used" | "unavailable";
}

const MAX_JUDGED_CANDIDATES = 12;
const MAX_MATERIAL_CHARS = 1600;

const clip = (text: string, max: number): string => (
  text.length <= max ? text : `${text.slice(0, max)}…`
);

export async function recallMemories(input: MemoryRecallInput): Promise<MemoryRecallOutput> {
  input.signal?.throwIfAborted();
  const recalled = await recallSources({
    sources: input.sources,
    query: input.query,
    k: input.k,
    ...(input.vectors ? { vectors: input.vectors } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.associated ? { associated: input.associated } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const judged = await judgeCandidates(input, recalled.results);
  return { results: judged.results, details: recalled.details, ...(judged.judge ? { judge: judged.judge } : {}) };
}

const judgeCandidates = async (
  input: MemoryRecallInput,
  results: RecallResult[],
): Promise<{ results: RecallResult[]; judge?: "used" | "unavailable" }> => {
  const fastDecision = input.fastDecision;
  if (!fastDecision || results.length === 0 || input.judgeWorkspaceId === undefined) {
    return { results };
  }
  let status: HarnessFastDecisionPurposeStatus;
  try {
    status = await fastDecision.status(input.judgeWorkspaceId, "memory-recall");
  } catch {
    return { results, judge: "unavailable" };
  }
  if (status.status !== "ready") return { results, judge: "unavailable" };
  const candidates = results.slice(0, MAX_JUDGED_CANDIDATES);
  const materials: FastDecisionMaterial[] = candidates.map((result, index) => {
    const payload = result.node.payload;
    return {
      id: `m${index}`,
      label: `[${payload.scope ?? "workspace"}] #${result.node.id}`,
      text: clip(`${payload.content}\ntrigger: ${payload.trigger}`, MAX_MATERIAL_CHARS),
    };
  });
  const questions: FastDecisionQuestion[] = candidates.map((_result, index) => ({
    id: `m${index}`,
    kind: "judge" as const,
    instructions: `Material m${index} is a durable memory recalled for the current request. Does it contribute to the goal: a decision, requirement, preference, judgment, commitment, or outcome the answer must respect?`,
    criteria: {
      yes: "The memory changes what a correct answer or next step looks like",
      no: "Unrelated, stale, or already covered by the visible conversation",
    },
  }));
  let decided: HarnessFastDecisionResult;
  try {
    decided = await fastDecision.decide({
      workspaceId: input.judgeWorkspaceId,
      purpose: "memory-recall",
      settings: status.binding,
      goal: input.goal ?? input.query,
      materials,
      questions,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    // Judging is advisory: a provider failure must not hide real recall hits.
    return { results, judge: "unavailable" };
  }
  const keep = new Set<string>();
  for (const answer of decided.answers) {
    if (answer.kind === "judge" && answer.value >= 0.5) keep.add(answer.id);
  }
  for (const id of decided.missing) keep.add(id);
  return {
    results: results.filter((_result, index) => index >= candidates.length || keep.has(`m${index}`)),
    judge: "used",
  };
};
