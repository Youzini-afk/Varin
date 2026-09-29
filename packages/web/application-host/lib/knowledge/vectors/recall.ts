import type { Knowledge, KnowledgeScope, KnowledgeStore, RecallResult } from "../store.js";
import type {
  KnowledgeVectorRuntime,
  KnowledgeVectorScopeSearch,
  KnowledgeVectorStatus,
} from "./runtime.js";

const RRF_K = 60;

export type KnowledgeRecallDetails = {
  vector: KnowledgeVectorStatus;
  spaceId?: string;
};

type Candidate = {
  key: string;
  item: Knowledge;
  authority: KnowledgeStore;
};

const candidateKey = (scope: KnowledgeScope, id: number): string => `${scope}:${id}`;

const textScore = (query: string, item: Knowledge): number => {
  const haystack = `${item.content} ${item.trigger}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
};

const rankText = (candidates: readonly Candidate[], query: string): Map<string, number> => {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: textScore(query, candidate.item) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.key.localeCompare(right.candidate.key));
  return new Map(ranked.map((row, index) => [row.candidate.key, index + 1]));
};

const nodeOf = (current: Knowledge): RecallResult["node"] => ({
  id: current.id,
  type: "knowledge",
  payload: {
    type: "knowledge",
    scope: current.scope,
    status: current.status,
    content: current.content,
    trigger: current.trigger,
    ...(current.nature ? { nature: current.nature } : {}),
    createdAt: current.createdAt,
    recallCount: current.recallCount,
    ...(current.source ? { source: current.source } : {}),
    ...(current.invalidAt !== undefined ? { invalidAt: current.invalidAt } : {}),
    ...(current.recalledAt !== undefined ? { recalledAt: current.recalledAt } : {}),
  },
});

const combineStatus = (statuses: readonly KnowledgeVectorStatus[]): KnowledgeVectorStatus => {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("used")) return "used";
  if (statuses.includes("empty")) return "empty";
  return "unconfigured";
};

/**
 * One authority store queried at its real scope (BC3): the owner store may be
 * a workspace, bot, or session store; rows keep their own scope label.
 */
export interface MemoryRecallSource {
  authority: KnowledgeStore;
  scope: KnowledgeScope;
  scopeId: string;
}

/**
 * Durable keys of the work issuing a recall (BC3): memories whose provenance
 * intersects these keys are bound to the current work item and are delivered
 * ahead of generic text/vector hits.
 */
export interface MemoryRecallAssociation {
  sessionIds?: readonly string[];
  threadIds?: readonly string[];
  runIds?: readonly string[];
}

const isAssociated = (candidate: Candidate, associated: MemoryRecallAssociation | undefined): boolean => {
  const source = candidate.item.source;
  if (!associated || !source) return false;
  return (source.sessionId !== undefined && associated.sessionIds?.includes(source.sessionId) === true)
    || (source.threadId !== undefined && associated.threadIds?.includes(source.threadId) === true)
    || (source.runId !== undefined && associated.runIds?.includes(source.runId) === true);
};

const acceptedCandidates = async (
  authority: KnowledgeStore,
  scope: KnowledgeScope,
): Promise<Candidate[]> => (await authority.listKnowledge({ status: "accepted", activeOnly: true }))
  .filter((item) => item.scope === scope)
  .map((item) => ({ key: candidateKey(scope, item.id), item, authority }));

/** Re-read a candidate through its authority so stale list snapshots never deliver dropped rows. */
const revalidate = async (candidate: Candidate, signal?: AbortSignal): Promise<Knowledge | null> => {
  signal?.throwIfAborted();
  const current = await candidate.authority.getKnowledge(candidate.item.id);
  if (!current || current.scope !== candidate.item.scope
    || current.status !== "accepted" || current.invalidAt !== undefined
    || current.content !== candidate.item.content || current.trigger !== candidate.item.trigger) {
    return null;
  }
  return current;
};

async function recallCandidates(input: {
  candidates: Candidate[];
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  vectorScopes?: readonly KnowledgeVectorScopeSearch[];
  workspaceId?: string;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  input.signal?.throwIfAborted();
  if (input.k <= 0) return { results: [], details: { vector: "unconfigured" } };
  const textRanks = rankText(input.candidates, input.query);
  const vectorRanks = new Map<string, number>();
  let vectorStatus: KnowledgeVectorStatus = input.vectors ? "unavailable" : "unconfigured";
  let spaceId: string | undefined;

  if (input.vectors && input.workspaceId && input.vectorScopes && input.vectorScopes.length > 0) {
    const vectorResults = await input.vectors.searchScopes({
      scopes: input.vectorScopes,
      workspaceId: input.workspaceId,
      query: input.query,
      // Runtime aggregates blocks before applying this limit, so this covers
      // every valid knowledge candidate before RRF truncates the final list.
      limit: Math.max(input.k, input.candidates.length),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    vectorStatus = combineStatus(vectorResults.map((row) => row.result.status));
    spaceId = vectorResults.find((row) => row.result.spaceId !== undefined)?.result.spaceId;
    const vectorRows = vectorResults.flatMap((row) => row.result.hits.map((hit) => ({
      key: candidateKey(row.scope, hit.knowledgeId),
      similarity: hit.similarity,
    })));
    vectorRows.sort((left, right) => right.similarity - left.similarity || left.key.localeCompare(right.key));
    for (const [index, row] of vectorRows.entries()) {
      if (!vectorRanks.has(row.key)) vectorRanks.set(row.key, index + 1);
    }
  }

  const merged = input.candidates
    .map((candidate) => {
      const text = textRanks.get(candidate.key);
      const vector = vectorRanks.get(candidate.key);
      return {
        candidate,
        score: (text === undefined ? 0 : 1 / (RRF_K + text))
          + (vector === undefined ? 0 : 1 / (RRF_K + vector)),
        via: vector === undefined ? "text" as const : "vector" as const,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.key.localeCompare(right.candidate.key));

  const results: RecallResult[] = [];
  for (const row of merged) {
    const current = await revalidate(row.candidate, input.signal);
    if (!current) continue;
    results.push({ node: nodeOf(current), score: row.score, via: row.via });
    if (results.length >= input.k) break;
  }

  // Record only final, authority-checked results. Intermediate per-scope
  // rankings must not inflate recall counts for entries dropped by RRF.
  const byAuthority = new Map<KnowledgeStore, number[]>();
  for (const result of results) {
    const candidate = input.candidates.find((row) => row.item.id === result.node.id
      && row.item.scope === (result.node.payload as Record<string, unknown>)["scope"]);
    if (!candidate) continue;
    const ids = byAuthority.get(candidate.authority) ?? [];
    ids.push(result.node.id);
    byAuthority.set(candidate.authority, ids);
  }
  await Promise.all([...byAuthority.entries()].map(([authority, ids]) => authority.recordRecall(ids)));
  return {
    results,
    details: spaceId === undefined ? { vector: vectorStatus } : { vector: vectorStatus, spaceId },
  };
}

/**
 * The shared memory-selection service for automatic Zone 2 recall and active
 * `recall` reads (BC3): one candidate set across the calling scope's own store
 * plus the user store, work-associated rows pinned ahead of ranked hits, and
 * every delivered row re-read through its authority before it leaves.
 */
export async function recallSources(input: {
  sources: readonly MemoryRecallSource[];
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  /** Vector search is keyed by the caller's execution workspace when present. */
  workspaceId?: string;
  associated?: MemoryRecallAssociation;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  const candidates = (await Promise.all(input.sources.map((source) => (
    acceptedCandidates(source.authority, source.scope)
  )))).flat();
  const pinned = candidates
    .filter((candidate) => isAssociated(candidate, input.associated))
    .sort((left, right) => right.item.createdAt - left.item.createdAt || left.key.localeCompare(right.key));
  const pinnedKeys = new Set(pinned.map((candidate) => candidate.key));
  const pinnedResults: RecallResult[] = [];
  const pinnedByAuthority = new Map<KnowledgeStore, number[]>();
  for (const candidate of pinned) {
    const current = await revalidate(candidate, input.signal);
    if (!current || pinnedResults.length >= input.k) continue;
    pinnedResults.push({ node: nodeOf(current), score: 0, via: "associated" });
    const ids = pinnedByAuthority.get(candidate.authority) ?? [];
    ids.push(current.id);
    pinnedByAuthority.set(candidate.authority, ids);
  }
  await Promise.all([...pinnedByAuthority.entries()].map(([authority, ids]) => authority.recordRecall(ids)));
  const ranked = await recallCandidates({
    candidates: candidates.filter((candidate) => !pinnedKeys.has(candidate.key)),
    query: input.query,
    k: Math.max(input.k - pinnedResults.length, 0),
    ...(input.vectors ? { vectors: input.vectors } : {}),
    ...(input.vectors && input.workspaceId ? {
      vectorScopes: input.sources.map((source) => ({
        authority: source.authority,
        scope: source.scope,
        scopeId: source.scopeId,
      })),
      workspaceId: input.workspaceId,
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { results: [...pinnedResults, ...ranked.results], details: ranked.details };
}
