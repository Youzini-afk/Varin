/**
 * Four-column team status projection (7E/D-300): thread / task / state /
 * progress. Progress is a deterministic excerpt of the thread's last
 * completed visible output — never hidden reasoning, never a summary model.
 * Every excerpt names its source (Thread/Run/entry/time) so read_thread can
 * expand the original passage even after the thread keeps writing.
 *
 * Consumers: the `threads` tool default view and the per-request Zone 2
 * status injection. Observers keep independent cursors; a cursor commits
 * only after the rows were actually delivered.
 */

import {
  encodeHarnessObservationText,
  type PiSessionEntry,
  type SessionEntriesResult,
  type Thread,
  type ThreadMessagePeer,
  type ThreadParent,
  type ThreadRun,
} from "@varin/protocol";
import type { ThreadRegistry } from "./thread-registry.js";

/** ~20 visible characters is a preview budget, not a content limit. */
const PROGRESS_VISIBLE_CHARS = 20;

export interface ThreadStatusProgress {
  /** Whitespace-collapsed excerpt, ≤ PROGRESS_VISIBLE_CHARS plus an ellipsis. */
  text: string;
  /** The Run this output belongs to — an older Run is marked, not disguised. */
  runId: string;
  /** Session entry holding the original passage; empty when reportRevision is set. */
  entryId: string;
  /** Present when the visible fallback is a durable Run report, not a transcript entry. */
  reportRevision?: number;
  at: string;
  /** True when the current Run produced no visible output yet. */
  fromEarlierRun: boolean;
}

export interface ThreadStatusMarker {
  kind: "message" | "result";
  text: string;
  id?: string;
  at: string;
}

export interface ThreadStatusRow {
  threadId: string;
  preset: string | null;
  /** The thread's own brief, whitespace-collapsed. */
  task: string;
  state: string;
  progress: ThreadStatusProgress | null;
  /** Kept for callers which render their own markers; status snapshots leave it empty. */
  markers: ThreadStatusMarker[];
}

export interface ThreadStatusCursor {
  /** threadId → rendered cell content that was actually presented. */
  cells: Record<string, string>;
  /** threadId → inbound message ids already surfaced as markers. */
  inboundSeen: Record<string, string[]>;
  /** threadId → result revision already surfaced as a marker. */
  resultSeen: Record<string, number>;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const excerptText = (text: string): string => {
  const collapsed = collapse(text);
  const chars = [...collapsed];
  return chars.length <= PROGRESS_VISIBLE_CHARS ? collapsed : `${chars.slice(0, PROGRESS_VISIBLE_CHARS).join("")}…`;
};

const latestVisibleText = (entry: PiSessionEntry): string => {
  if (entry.type !== "message" || entry.message.role !== "assistant") return "";
  return entry.message.content
    .filter((part) => part.type === "text")
    .flatMap((part) => part.text.trim().split(/\r?\n\s*\r?\n/u))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .at(-1) ?? "";
};

/**
 * The last completed assistant text of a session branch. Streaming parts land
 * in the session file only once committed, so this never reads a half-written
 * message and never wakes the observed agent.
 */
export const lastVisibleOutput = (
  entries: readonly PiSessionEntry[],
  afterEntryId?: string | null,
): { text: string; entryId: string; at: string } | null => {
  const start = entries.length - 1;
  if (afterEntryId) {
    const boundary = entries.findIndex((entry) => entry.id === afterEntryId);
    if (boundary < 0) return null;
    // The scan below skips every entry at or before the previous Run's leaf.
    for (let index = start; index > boundary; index -= 1) {
      const entry = entries[index]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      if (entry.message.stopReason === "pending") continue;
      const text = collapse(latestVisibleText(entry));
      if (text) return { text: excerptText(text), entryId: entry.id, at: entry.timestamp };
    }
    return null;
  }
  for (let index = start; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.stopReason === "pending") continue;
    const text = collapse(latestVisibleText(entry));
    if (text) return { text: excerptText(text), entryId: entry.id, at: entry.timestamp };
  }
  return null;
};

export const statusPeerLabel = (peer: ThreadMessagePeer): string => (
  peer.kind === "thread" ? `thread ${peer.id}`
    : peer.kind === "session" ? `session ${peer.id}`
      : `user ${peer.id}`
);

export const threadStatusState = (thread: Thread, activeRun: ThreadRun | null): string => {
  if (thread.lifecycle === "archived") return "archived";
  if (thread.integration === "merged") return "merged";
  if (thread.integration === "conflict") return "conflict";
  if (thread.lifecycle === "preparing") return "preparing";
  if (thread.lifecycle === "queued") return "queued";
  if (thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread" || thread.attention === "experiment") return "waiting";
  if (thread.attention === "stalled" || thread.attention === "looping") return thread.attention;
  if (thread.lifecycle === "settled") return activeRun?.outcome ?? "settled";
  if (activeRun?.workerState === "lost") return "lost";
  if (activeRun?.workerState === "starting" || activeRun?.workerState === "running") return "working";
  return "idle";
};

export interface ThreadStatusProjectorOptions {
  /** Resolved per build — the registry is not fixed at projector creation. */
  registry: () => ThreadRegistry | null;
  /** Read-only session entries access; never wakes the observed agent. */
  readEntries: ((sessionId: string) => Promise<SessionEntriesResult>) | null;
}

/**
 * Rebuildable projection over real Thread/Run/session facts. The excerpt
 * cache keys on the session's committed leaf so unchanged sessions cost no
 * re-read and a new completed output produces a fresh excerpt.
 */
export function createThreadStatusProjector(options: ThreadStatusProjectorOptions) {
  const excerptCache = new Map<string, { stamp: string; excerpt: { text: string; entryId: string; at: string } | null }>();

  const entriesForRun = (
    entries: readonly PiSessionEntry[],
    run: ThreadRun,
    runs: readonly ThreadRun[],
  ): PiSessionEntry[] | null => {
    const ref = run.report?.transcriptRef;
    let fromId: string | null = null;
    let toId: string | null = null;
    if (ref) {
      if (ref.fromEntryId === null && ref.toEntryId === null) return [];
      fromId = ref.fromEntryId;
      toId = ref.toEntryId;
    } else {
      const previous = runs
        .filter((candidate) => candidate.id !== run.id && candidate.attempt < run.attempt && candidate.sessionId === run.sessionId)
        .toSorted((left, right) => left.attempt - right.attempt)
        .at(-1);
      if (previous) {
        const previousTo = previous.report?.transcriptRef.toEntryId;
        if (!previousTo) return null;
        fromId = previousTo;
      }
    }
    const fromEntryIndex = fromId === null ? -1 : entries.findIndex((entry) => entry.id === fromId);
    const toEntryIndex = toId === null ? entries.length : entries.findIndex((entry) => entry.id === toId);
    if ((fromId !== null && fromEntryIndex < 0) || (toId !== null && toEntryIndex < 0)) return null;
    const start = fromId === null ? 0 : fromEntryIndex + (ref ? 0 : 1);
    return entries.slice(start, toEntryIndex === entries.length ? entries.length : toEntryIndex + 1);
  };

  const excerptFor = async (run: ThreadRun | null, runs: readonly ThreadRun[]): Promise<{ text: string; entryId: string; at: string } | null> => {
    if (!run?.sessionId || !options.readEntries) return null;
    // lastActivityAt is the registry-maintained commit signal: unchanged runs
    // reuse the cached excerpt, new committed output invalidates it.
    const stamp = run.lastActivityAt;
    const key = `${run.id}\0${run.sessionId}`;
    const cached = excerptCache.get(key);
    if (cached?.stamp === stamp) return cached.excerpt;
    let excerpt: { text: string; entryId: string; at: string } | null = null;
    try {
      const entries = entriesForRun((await options.readEntries(run.sessionId)).entries, run, runs);
      excerpt = entries === null ? null : lastVisibleOutput(entries);
    } catch {
      excerpt = null;
    }
    excerptCache.set(key, { stamp, excerpt });
    return excerpt;
  };

  const progressFor = async (
    thread: Thread,
    activeRun: ThreadRun | null,
    runs: readonly ThreadRun[],
  ): Promise<ThreadStatusProgress | null> => {
    const candidates = activeRun
      ? [activeRun, ...runs.toSorted((left, right) => right.attempt - left.attempt).filter((run) => run.id !== activeRun.id)]
      : runs.toSorted((left, right) => right.attempt - left.attempt);
    for (const candidate of candidates) {
      const excerpt = await excerptFor(candidate, runs);
      if (excerpt) {
        return {
          ...excerpt,
          runId: candidate.id,
          fromEarlierRun: activeRun !== null && candidate.id !== activeRun.id,
        };
      }
      // A durable report is historical result material. If there is no
      // transcript excerpt available, leave progress empty rather than copying
      // the result body into this transient status table.
    }
    return null;
  };

  // Message/result bodies are delivered by zone2.assemble. The status table
  // only keeps the mechanical progress excerpt above and never acknowledges
  // or consumes directed message/result records.
  const markersFor = (_thread: Thread, _seenInbound: readonly string[], _seenResult: number | undefined): ThreadStatusMarker[] => [];

  const renderCell = (progress: ThreadStatusProgress | null, markers: readonly ThreadStatusMarker[]): string => {
    // The progress excerpt is a real retained transcript entry. Keep its
    // run/entry locator so read_thread can expand it; status markers stay
    // empty because messages/results are delivered by zone2.assemble.
    const base = progress
      ? `${encodeHarnessObservationText(progress.text)} [${encodeHarnessObservationText(progress.runId)}:${encodeHarnessObservationText(progress.reportRevision !== undefined ? `report:r${progress.reportRevision}` : progress.entryId)}]${progress.fromEarlierRun ? ` (earlier run · ${encodeHarnessObservationText(progress.at)})` : ""}`
      : "—";
    const suffix = markers.map((marker) => encodeHarnessObservationText(marker.text)).join(" · ");
    return suffix ? `${base} · ${suffix}` : base;
  };

  return {
    /**
     * Full table: every in-scope row. `cursor` supplies the inbound-message
     * baseline so markers reflect what this observer has not yet seen.
     */
    async build(
      workspaceId: string,
      parent: ThreadParent,
      cursor: ThreadStatusCursor | null,
      threadIds?: readonly string[],
      currentOnly = false,
    ): Promise<{ rows: ThreadStatusRow[]; cursor: ThreadStatusCursor; removed: string[] }> {
      const registry = options.registry();
      if (!registry) throw new Error("Thread registry not configured");
      const snapshots = threadIds === undefined
        ? await registry.listThreadSnapshots(workspaceId, parent)
        : (await Promise.all([...new Set(threadIds)].map((threadId) => registry.getThreadSnapshot(workspaceId, threadId))))
          .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
      const next: ThreadStatusCursor = { cells: {}, inboundSeen: {}, resultSeen: {} };
      const rows: ThreadStatusRow[] = [];
      for (const { thread, activeRun } of snapshots) {
        if (currentOnly && (thread.lifecycle === "settled" || thread.lifecycle === "archived")
          && thread.attention === "none" && !["dirty", "merge-ready", "conflict"].includes(thread.integration)) continue;
        const runs = await registry.listRuns(workspaceId, thread.id);
        const seenInbound = cursor?.inboundSeen[thread.id] ?? [];
        const seenResult = cursor?.resultSeen[thread.id];
        const progress = await progressFor(thread, activeRun, runs);
        const markers = markersFor(thread, seenInbound, seenResult);
        const row: ThreadStatusRow = {
          threadId: thread.id,
          preset: thread.preset,
          task: collapse(thread.brief),
          state: threadStatusState(thread, activeRun),
          progress,
          markers,
        };
        rows.push(row);
        // The cursor records the marker-free baseline: an inbound/result
        // marker is transient and its disappearance is not a change.
        next.cells[thread.id] = `${row.state}|${renderCell(progress, [])}`;
        next.inboundSeen[thread.id] = (thread.messages ?? [])
          .filter((message) => message.direction === "in" && (message.status === "delivered" || message.status === "resolved"))
          .map((message) => message.id);
        if (thread.resultRevision !== undefined) next.resultSeen[thread.id] = thread.resultRevision;
      }
      const removed = Object.keys(cursor?.cells ?? {}).filter((id) => next.cells[id] === undefined);
      return { rows, cursor: next, removed };
    },

    /** One row of the four-column table: thread · task · state · progress. */
    formatRow(row: ThreadStatusRow): string {
      return `${encodeHarnessObservationText(row.threadId)}${row.preset ? ` [${encodeHarnessObservationText(row.preset)}]` : ""} · ${encodeHarnessObservationText(row.task)} · ${encodeHarnessObservationText(row.state)} · ${renderCell(row.progress, row.markers)}`;
    },
  };
}

export type ThreadStatusProjector = ReturnType<typeof createThreadStatusProjector>;
