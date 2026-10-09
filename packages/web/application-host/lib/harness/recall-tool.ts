/**
 * recall tool — search workspace + user memory of past sessions and decisions.
 *
 * Design: design/harness-knowledge.md §7.2
 * Plan: plan/agent-harness-plan.md §2.10
 *
 * recall(query, k=5): text `${n} memories for "${query}"\n` + each
 * `- [${scope}] ${title or first line} (${via}, #${id})`
 *
 * Workspace store + user store merged by score. User store only allows
 * knowledge nodes. Promotion = a new suggestion with scope: 'user'.
 */

import type { KnowledgeStore, RecallResult } from "../knowledge/store.js";
import { scopeOfScopeId } from "./owner-scope.js";
import {
  recallSources,
  type KnowledgeRecallDetails,
  type KnowledgeVectorRuntime,
  type MemoryRecallAssociation,
  type MemoryRecallSource,
} from "../knowledge/vectors/index.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RecallToolResult {
  text: string;
  results: RecallResult[];
  details: KnowledgeRecallDetails;
}

export interface RecallToolDeps {
  /** The session's owning-scope store — workspace, bot, or session (BC3). */
  workspaceStore: KnowledgeStore;
  userStore: KnowledgeStore | null;
  /** The session's own session-scope store, when one exists. */
  sessionStore?: KnowledgeStore | null;
  workspaceId?: string;
  sessionId?: string;
  /** Durable work keys whose produced memories are delivered first. */
  associated?: MemoryRecallAssociation;
  vectors?: KnowledgeVectorRuntime;
}

// ── Tool execution ─────────────────────────────────────────────────

export async function executeRecall(
  query: string,
  k: number,
  deps: RecallToolDeps,
  signal?: AbortSignal,
): Promise<RecallToolResult> {
  signal?.throwIfAborted();
  const sources: MemoryRecallSource[] = [{
    authority: deps.workspaceStore,
    scope: deps.workspaceId === undefined ? "workspace" : scopeOfScopeId(deps.workspaceId),
    scopeId: deps.workspaceId ?? "workspace",
  }];
  if (deps.sessionStore && deps.sessionId) {
    sources.push({ authority: deps.sessionStore, scope: "session", scopeId: `session:${deps.sessionId}` });
  }
  if (deps.userStore) sources.push({ authority: deps.userStore, scope: "user", scopeId: "user" });
  const recalled = await recallSources({
    sources,
    query,
    k,
    ...(deps.workspaceId === undefined ? {} : { workspaceId: deps.workspaceId }),
    ...(deps.associated ? { associated: deps.associated } : {}),
    ...(deps.vectors ? { vectors: deps.vectors } : {}),
    ...(signal ? { signal } : {}),
  });
  const all = recalled.results;

  const lines = all.map((r) => {
    const payload = r.node.payload as Record<string, unknown>;
    const scope = (payload["scope"] as string) ?? "workspace";
    const content = (payload["content"] as string) ?? "";
    const title = content.split("\n")[0] ?? content;
    return `- [${scope}] ${title} (${r.via}, #${r.node.id})`;
  });

  const text = `${all.length} memories for "${query}"\n${lines.join("\n")}`;
  return { text, results: all, details: recalled.details };
}

// ── Prompt ─────────────────────────────────────────────────────────

export const RECALL_PROMPT_SNIPPET =
  "recall: search this workspace's memory of past sessions and decisions";

// ── User store ─────────────────────────────────────────────────────

/**
 * Open the user-level knowledge store at
 * {dataDir}/knowledge/{hostId}/user.tdb.
 * Knowledge nodes and explicitly scoped native plans share this physical owner.
 * Legacy session events/blocks remain prohibited; native plans are excluded from recall.
 */
export async function openUserKnowledgeStore(
  deps: {
    dataDir: string;
    hostId: string;
    embedding: import("../knowledge/store.js").EmbeddingProvider | null;
    onKnowledgeChanged?: (ids: readonly number[]) => void;
    onNativePlanChanged?: (change: import("@varin/protocol").NativePlanChanged) => void;
  },
): Promise<KnowledgeStore> {
  // Reuse openWorkspaceKnowledge with a special workspaceId "user"
  const { openWorkspaceKnowledge } = await import("../knowledge/store.js");
  const store = await openWorkspaceKnowledge({
    dataDir: deps.dataDir,
    hostId: deps.hostId,
    workspaceId: "user",
    embedding: deps.embedding,
    ...(deps.onKnowledgeChanged ? { onKnowledgeChanged: deps.onKnowledgeChanged } : {}),
    ...(deps.onNativePlanChanged ? { onNativePlanChanged: deps.onNativePlanChanged } : {}),
  });

  // Wrap to reject non-knowledge writes
  const origPutEvent = store.putEvent.bind(store);
  const origPutSession = store.putSession.bind(store);
  const origUpsertBlock = store.upsertBlock.bind(store);
  const origPutKnowledge = store.putKnowledge.bind(store);

  return {
    ...store,
    async putEvent() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async putSession() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async upsertBlock() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async putKnowledge(input) {
      if (input.scope !== "user") throw new Error("user.tdb only allows user-scoped knowledge");
      return origPutKnowledge(input);
    },
    async touchFile() {
      throw new Error("user.tdb does not allow file graph nodes");
    },
    async replaceFileSymbols() {
      throw new Error("user.tdb does not allow symbol graph nodes");
    },
    async removeFileSymbols() {
      throw new Error("user.tdb does not allow file graph nodes");
    },
  };
  // Suppress unused var warnings
  void origPutEvent; void origPutSession; void origUpsertBlock;
}
