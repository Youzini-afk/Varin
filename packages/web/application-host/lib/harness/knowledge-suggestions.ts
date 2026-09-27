/**
 * Knowledge suggestions — three triggers, review tray, dual-temporal supersedes.
 *
 * Design: design/harness-knowledge.md §7.2.2
 * Plan: plan/agent-harness-plan.md §2.7
 *
 * Triggers (only these two, no heuristics):
 * 1. User "remember this" action on message/tool result/block entry
 * 2. User message explicit pattern (only when models.knowledgeSuggestions configured)
 */

import {
  mergeHarnessSettings,
  type HarnessSettingsInput,
  type PiSettingsSnapshot,
} from "@varin/protocol";
import type { Knowledge, KnowledgeStore, KnowledgeInput, KnowledgeScope, NodeId } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export type SuggestionTrigger = "user-mark" | "user-message";

export interface SuggestionInput {
  trigger: SuggestionTrigger;
  content: string;
  sessionId: string;
  kind: string;
  scope?: KnowledgeScope;
  recallTrigger?: string;
  /** Optional model to draft content/trigger */
  draftWithModel?: (prompt: string) => Promise<{ content: string; trigger: string }>;
}

export interface SuggestionResult {
  id: NodeId;
  content: string;
  trigger: string;
  status: "suggested" | "accepted";
  scope: KnowledgeScope;
}

export interface KnowledgeSuggestionsSettings {
  autoAcceptSuggestions: {
    workspace: boolean;
    user: boolean;
    session: boolean;
  };
}

export const DEFAULT_SUGGESTIONS_SETTINGS: KnowledgeSuggestionsSettings = {
  autoAcceptSuggestions: { workspace: false, user: false, session: false },
};

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/** Resolve the same trusted global/project harness layers used by the session. */
export const suggestionSettingsFromSnapshot = (snapshot: PiSettingsSnapshot): KnowledgeSuggestionsSettings => {
  const globalHarness = record(record(snapshot.global).harness) as HarnessSettingsInput;
  const projectHarness = snapshot.projectTrusted
    ? record(record(snapshot.project).harness) as HarnessSettingsInput
    : {};
  const resolved = mergeHarnessSettings(globalHarness, projectHarness).knowledge.autoAcceptSuggestions;
  return {
    autoAcceptSuggestions: {
      workspace: resolved.workspace === true,
      user: resolved.user === true,
      session: false,
    },
  };
};

export const normalizeKnowledgeIdentity = (value: string): string => (
  value.replace(/\s+/g, " ").trim().toLowerCase()
);

export async function findDuplicateKnowledge(
  store: KnowledgeStore,
  scope: KnowledgeScope,
  content: string,
): Promise<Knowledge | null> {
  const identity = normalizeKnowledgeIdentity(content);
  if (!identity) return null;
  const existing = await store.listKnowledge({ scope });
  return existing.find((item) => normalizeKnowledgeIdentity(item.content) === identity) ?? null;
}

export async function proposeUserMessageSuggestion(
  input: SuggestionInput,
  deps: SuggestionDeps,
): Promise<{ created: boolean; skippedReason?: "empty" | "duplicate"; suggestion?: SuggestionResult }> {
  const drafted = input.draftWithModel
    ? await input.draftWithModel(`${SUGGESTION_PROMPT}\n\nUser message: ${input.content}`)
    : { content: input.content, trigger: input.recallTrigger ?? "" };
  const content = drafted.content.trim();
  if (!content) return { created: false, skippedReason: "empty" };
  const scope = input.scope ?? "workspace";
  // The identity check and insert must share KnowledgeStore's writer queue.
  // A read followed by putKnowledge allows two simultaneous user messages to
  // pass the check and create duplicate rows.
  const created = await deps.store.createKnowledgeIfAbsent({
    scope,
    status: "suggested",
    content,
    trigger: drafted.trigger,
    source: { sessionId: input.sessionId, kind: input.kind },
  });
  if (!created.created) return { created: false, skippedReason: "duplicate" };
  const autoAccepted = deps.settings.autoAcceptSuggestions[scope];
  if (autoAccepted) await deps.store.acceptKnowledge(created.knowledge.id, {});
  return {
    created: true,
    suggestion: {
      id: created.knowledge.id,
      content: created.knowledge.content,
      trigger: created.knowledge.trigger,
      scope: created.knowledge.scope,
      status: autoAccepted ? "accepted" : "suggested",
    },
  };
}

// ── Suggestion creation ────────────────────────────────────────────

export interface SuggestionDeps {
  store: KnowledgeStore;
  settings: KnowledgeSuggestionsSettings;
}

const SUGGESTION_PROMPT = `Does this user message state a durable preference or correction that should apply to future sessions? Answer with a JSON suggestion or null`;

export async function createSuggestion(
  input: SuggestionInput,
  deps: SuggestionDeps,
): Promise<SuggestionResult> {
  let content = input.content;
  let trigger = input.recallTrigger ?? "";
  const scope = input.scope ?? "workspace";

  // If model is configured, use it to draft content and trigger
  if (input.draftWithModel) {
    const drafted = await input.draftWithModel(
      `${SUGGESTION_PROMPT}\n\nUser message: ${input.content}`,
    );
    content = drafted.content;
    trigger = drafted.trigger;
  }

  const knowledgeInput: KnowledgeInput = {
    scope,
    status: "suggested",
    content,
    trigger,
    source: { sessionId: input.sessionId, kind: input.kind },
  };

  const id = await deps.store.putKnowledge(knowledgeInput);

  // Auto-accept if configured
  const autoAccepted = deps.settings.autoAcceptSuggestions[scope];
  if (autoAccepted) {
    await deps.store.acceptKnowledge(id, {});
  }

  return { id, content, trigger, scope, status: autoAccepted ? "accepted" : "suggested" };
}

// ── Supersedes suggestion ──────────────────────────────────────────

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

// ── Review tray actions ────────────────────────────────────────────

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
