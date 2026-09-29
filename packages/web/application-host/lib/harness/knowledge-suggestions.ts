/**
 * Knowledge review-tray helpers — supersedes candidates plus accept/dismiss.
 *
 * Design: design/harness-knowledge.md §7.2.2
 * Plan: plan/agent-harness-plan.md §2.7
 *
 * The user-message automatic producer is gone (BC1–BC2): automatic memory
 * formation runs exclusively through the background organizer's durable
 * coverage transaction. These helpers remain for the review tray — rows a
 * caller explicitly wrote with `suggested` status.
 */

import type { KnowledgeStore, KnowledgeScope, NodeId } from "../knowledge/store.js";

export interface SuggestionDeps {
  store: KnowledgeStore;
}

export async function suggestSupersedes(
  newId: NodeId,
  trigger: string,
  deps: SuggestionDeps,
  scope: KnowledgeScope = "workspace",
): Promise<NodeId[]> {
  if (!trigger) return [];

  const existing = await deps.store.listKnowledge({
    scope,
    status: "accepted",
    activeOnly: true,
  });

  // Simple BM25-like: find entries with similar trigger words
  const newTerms = new Set(trigger.toLowerCase().split(/\s+/).filter(Boolean));
  const suggestions: Array<{ id: NodeId; score: number }> = [];

  for (const k of existing) {
    if (k.id === newId) continue;
    const existingTerms = new Set(k.trigger.toLowerCase().split(/\s+/).filter(Boolean));
    let overlap = 0;
    for (const term of newTerms) {
      if (existingTerms.has(term)) overlap++;
    }
    const score = overlap / Math.max(newTerms.size, 1);
    if (score > 0) {
      suggestions.push({ id: k.id, score });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).map((s) => s.id);
}

export async function acceptSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
  options: {
    supersedes?: NodeId[] | undefined;
    scope?: KnowledgeScope;
    expected?: { content: string; trigger: string; status?: "suggested" | "accepted" | "dismissed"; invalidAt?: number | null };
    edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string; expectedStatus?: "suggested" | "accepted" | "dismissed"; expectedInvalidAt?: number | null };
  },
): Promise<void> {
  await deps.store.acceptKnowledge(id, {
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    ...(options.scope === undefined ? {} : { expectedScope: options.scope }),
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(options.edit === undefined ? {} : { edit: options.edit }),
  });
}

export async function dismissSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
  scope?: KnowledgeScope,
  expected?: { content: string; trigger: string; status?: "suggested" | "accepted" | "dismissed"; invalidAt?: number | null },
): Promise<void> {
  await deps.store.dismissKnowledge(id, scope, expected);
}
