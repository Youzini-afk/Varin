/**
 * fresh-input assembly — shared section structure for a `fresh` Run's seed
 * input (plan/agent-harness-plan.md §2.6A, consumed by §3.18B).
 *
 * A fresh continuation is not a summary of the old transcript. The new input
 * carries: the current task and still-valid user requirements (verbatim
 * excerpts, not a model re-derivation), selected results, open items, and
 * source-transcript provenance. Old entry ids do not become entries in the
 * new session; current-session `history` cannot resolve them. Pi history and WorkingState stay
 * untouched; stale verification is not replayed as if it passed on the new
 * revision. Callers publish the new generation only after this input is
 * fully built — no forced re-summarization of the old history.
 *
 * The Application Host consumes this assembler using protocol PiSessionEntry
 * values. Tests exercise that same path instead of a parallel SDK-only helper.
 */

import type { PiSessionEntry, PiUserContent } from "./session.js";

export interface FreshInputCarriedMessage {
  entryId: string;
  text: string;
}

export interface FreshInputSeed {
  /** The current task statement, if the caller has one. */
  task?: string;
  /** Authorized old Run of the same Thread; resolves through history(run: ...). */
  sourceRunId?: string;
  /** Session goal/assist state still in force (verbatim). */
  goal?: string;
  /** Selected results/artifacts to carry (thread results, delta references). */
  results?: readonly string[];
  /** Open items: unfinished plan steps, todos, unresolved questions. */
  openItems?: readonly string[];
  /** Selected prior user statements, not automatically certified as still valid. */
  carriedUserMessages?: readonly FreshInputCarriedMessage[];
  /** Compaction boundary entry ids (readback anchors). */
  boundaryEntryIds?: readonly string[];
}

export interface FreshInput {
  /** Structured markdown text for the new run's seed input. */
  text: string;
  /** Entry ids of the carried user messages (history anchors). */
  userMessageEntryIds: string[];
  /** Compaction boundary entry ids (readback anchors). */
  boundaryEntryIds: string[];
}

export function assembleFreshInput(seed: FreshInputSeed): FreshInput {
  const carried = seed.carriedUserMessages ?? [];
  const boundaryEntryIds = [...(seed.boundaryEntryIds ?? [])];

  const sections: string[] = [];
  const task = seed.task?.trim() || seed.goal?.trim();
  if (task) sections.push(`## Task\n${task}`);
  if (carried.length > 0) {
    sections.push(
      `## Selected prior user statements\n`
      + `These are verbatim source statements; apply current instructions and explicit later corrections first.\n`
      + carried.map((entry) => `- [source entry ${entry.entryId}] ${entry.text}`).join("\n"),
    );
  }
  if (seed.results?.length) {
    sections.push(`## Selected results\n${seed.results.map((item) => `- ${item}`).join("\n")}`);
  }
  if (seed.openItems?.length) {
    sections.push(`## Open items\n${seed.openItems.map((item) => `- ${item}`).join("\n")}`);
  }
  const anchors = [...carried.map((entry) => entry.entryId), ...boundaryEntryIds];
  if (anchors.length > 0 || seed.sourceRunId) {
    sections.push(
      `## History anchors\n`
      + `These ids identify the preserved source transcript, not entries in this new session. `
      + (seed.sourceRunId
        ? `Read original entries with history({ run: ${JSON.stringify(seed.sourceRunId)}, entry: "<entry id>" }); query/path/offset pagination works on that same retained Run. Known source anchors:\n`
        : `The current-session history tool cannot resolve them; source-transcript access is required. Known source anchors:\n`)
      + anchors.map((id) => `- ${id}`).join("\n"),
    );
  }
  return {
    text: sections.join("\n\n"),
    userMessageEntryIds: carried.map((entry) => entry.entryId),
    boundaryEntryIds,
  };
}

// ── Protocol-entry mining ──────────────────────────────────────────

function userContentText(content: string | PiUserContent[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Mine protocol `PiSessionEntry`s (Host `session.entries` shape) for the
 * most recent user messages and compaction boundary ids.
 */
export function minePiBranchEntries(
  entries: readonly PiSessionEntry[],
  recentUserMessages = 3,
): { carriedUserMessages: FreshInputCarriedMessage[]; boundaryEntryIds: string[] } {
  const boundaryEntryIds: string[] = [];
  const userEntries: FreshInputCarriedMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      if (entry.id) boundaryEntryIds.push(entry.id);
      continue;
    }
    if (entry.type !== "message" || !entry.id || entry.message.role !== "user") continue;
    const text = userContentText(entry.message.content).trim();
    if (text.length > 0) userEntries.push({ entryId: entry.id, text });
  }
  return {
    carriedUserMessages: recentUserMessages >= 1 ? userEntries.slice(-Math.trunc(recentUserMessages)) : [],
    boundaryEntryIds,
  };
}
