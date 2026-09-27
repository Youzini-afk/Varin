/**
 * todo tool — plan block management for the main agent.
 *
 * Design: design/harness-tools.md §5.6
 * Plan: plan/agent-harness-plan.md §2.5
 *
 * Schema: { items: Array<{ text; status: 'open'|'done'|'blocked' }>; confidence?: number }
 * Replaces the entire `plan` block (updatedBy: 'agent').
 * Content rendered as `- [ ] text` / `- [x] text` / `- [!] text`.
 * Returns: `plan updated: ${done}/${total} done${blocked ? `, ${blocked} blocked` : ''}`
 *
 * Confidence is informational. Plan updates are ordinary session state; any
 * explicit approval belongs to the existing plan/permission flow before the
 * tool call. Version conflicts stay on the knowledge store.
 */

import type { KnowledgeStore } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export type TodoItemStatus = "open" | "done" | "blocked";

export interface TodoItem {
  text: string;
  status: TodoItemStatus;
}

export interface TodoToolInput {
  items: TodoItem[];
  confidence?: number;
}

export interface TodoToolDeps {
  store: KnowledgeStore;
  sessionId: string;
}

// ── Rendering ──────────────────────────────────────────────────────

export function renderPlanContent(items: TodoItem[]): string {
  return items.map((item) => {
    const marker = item.status === "done" ? "[x]" : item.status === "blocked" ? "[!]" : "[ ]";
    return `- ${marker} ${item.text}`;
  }).join("\n");
}

export function parsePlanContent(content: string): TodoItem[] {
  const lines = content.split("\n");
  const items: TodoItem[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*\[([ x!])\]\s*(.+)$/);
    if (match) {
      const status: TodoItemStatus = match[1] === "x" ? "done" : match[1] === "!" ? "blocked" : "open";
      items.push({ text: match[2]!, status });
    }
  }
  return items;
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
  const content = renderPlanContent(items);

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

  const done = items.filter((i) => i.status === "done").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  const total = items.length;
  let text = `plan updated: ${done}/${total} done`;
  if (blocked > 0) text += `, ${blocked} blocked`;

  return { text, content };
}

// ── Prompt guidelines ──────────────────────────────────────────────

export const TODO_PROMPT_GUIDELINES = [
  "For non-trivial tasks, write a short plan with todo before acting, and state your confidence.",
];
