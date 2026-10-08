/**
 * todo tool — plan block management for the main agent.
 *
 * Design: design/harness-tools.md §5.6
 * Plan: plan/agent-harness-plan.md §2.5
 *
 * Replaces the entire `plan` block (updatedBy: 'agent').
 * Plan updates are ordinary session state; any
 * explicit approval belongs to the existing plan/permission flow before the
 * tool call. Version conflicts stay on the knowledge store.
 */

import { renderTodoPlan, type TodoItem } from "@varin/protocol";
import type { KnowledgeStore } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface TodoToolInput {
  items: TodoItem[];
}

export interface TodoToolDeps {
  store: KnowledgeStore;
  sessionId: string;
}

// ── Tool execution ─────────────────────────────────────────────────

export interface TodoToolResult {
  text: string;
  content: string;
}

export async function executeTodoTool(
  input: TodoToolInput,
  deps: TodoToolDeps,
  branchEntryIds?: readonly string[],
): Promise<TodoToolResult> {
  const { store, sessionId } = deps;
  const items = input.items;
  const content = renderTodoPlan(items);

  await store.upsertBlock({
    sessionId,
    label: "plan",
    content,
    updatedBy: "agent",
    ...(branchEntryIds === undefined ? {} : {
      branchEntryIds,
      sourceLeafId: branchEntryIds[branchEntryIds.length - 1] ?? null,
    }),
  });

  const done = items.filter((i) => i.status === "completed").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  const total = items.length;
  let text = `plan updated: ${done}/${total} done`;
  if (blocked > 0) text += `, ${blocked} blocked`;

  return { text, content };
}
