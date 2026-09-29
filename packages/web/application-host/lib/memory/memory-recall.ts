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
   * The scope id the fast-decision binding resolves under — the caller's
   * execution workspace when present, else its owning scope. Bot/session/user
   * scopes share the global inference binding, so judging is never skipped
   * merely because no document workspace exists.
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
  // A human can correct/forget while the advisory model is in flight.
  const results: RecallResult[] = [];
  for (const result of judged.results) {
    input.signal?.throwIfAborted();
    const source = input.sources.find((candidate) => candidate.scope === result.node.payload.scope);
    const current = await source?.authority.getKnowledge(result.node.id);
    if (current?.status === "accepted" && current.invalidAt === undefined
      && current.content === result.node.payload.content && current.trigger === result.node.payload.trigger) results.push(result);
  }
  return { results, details: recalled.details, ...(judged.judge ? { judge: judged.judge } : {}) };
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
  // Explicit work associations are obligations, not similarity candidates for
  // an advisory judge to discard. Index answers against this exact subset.
  const candidates = results.filter((result) => result.via !== "associated");
  if (candidates.length === 0) return { results };
  const materials: FastDecisionMaterial[] = candidates.map((result, index) => {
    const payload = result.node.payload;
    return {
      id: `m${index}`,
      label: `[${payload.scope ?? "workspace"}] #${result.node.id}`,
      text: `${payload.content}\ntrigger: ${payload.trigger}`,
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
  const keep = new Set(candidates.map((_candidate, index) => `m${index}`));
  for (const answer of decided.answers) {
    if (answer.kind === "judge" && answer.value < 0.5) keep.delete(answer.id);
  }
  for (const id of decided.missing) keep.add(id);
  return {
    results: results.filter((result) => result.via === "associated" || keep.has(`m${candidates.indexOf(result)}`)),
    judge: "used",
  };
};
