import type { PiSessionEntry, PiMessage, PiUserContent } from "./session.js";
import type { JsonValue } from "./types.js";

export interface HistoryReadParams {
  start?: number;
  end?: number;
  tail?: boolean;
  afterEntry?: string;
  query?: string;
  path?: string;
  entry?: string;
  before?: number;
  after?: number;
  offset?: number;
  limit?: number;
}
export interface HistoryReadResult {
  content: PiUserContent[];
  details: { [key: string]: JsonValue };
}

/** One paging contract for native current history and authorized previous Runs. */
function messageText(message: PiMessage): string {
  if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
  if (message.role === "bashExecution") return `[command: ${message.command}; exit ${message.exitCode ?? "unknown"}]\n${message.output}`;
  if (message.role === "unknown") return JSON.stringify(message.data);
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return part.thinking;
    if (part.type === "toolCall") return `[toolCall ${part.name} ${JSON.stringify(part.arguments)}]`;
    return `[image ${part.mimeType}; attached unchanged]`;
  }).join("\n");
}
function entryText(entry: PiSessionEntry): { role: string; text: string } {
  if (entry.type === "compaction") return { role: "compaction", text: `[summary boundary · firstKept=${entry.firstKeptEntryId}]\n${entry.summary}` };
  if (entry.type === "message") return { role: entry.message.role, text: messageText(entry.message) };
  if (entry.type === "custom_message") return { role: "custom", text: typeof entry.content === "string"
    ? entry.content : entry.content.map((part) => part.type === "text" ? part.text : `[image ${part.mimeType}; attached unchanged]`).join("\n") };
  if (entry.type === "branch_summary") return { role: "branchSummary", text: entry.summary };
  const { id: _id, parentId: _parent, timestamp: _timestamp, type: _type, ...metadata } = entry;
  return { role: entry.type, text: JSON.stringify(metadata) };
}
function formatEntry(entry: PiSessionEntry, marker?: string): string {
  const { role, text } = entryText(entry);
  const head = `[entry ${entry.id} · ${entry.type}${role !== entry.type ? `/${role}` : ""} · ${entry.timestamp}${marker ? ` · ${marker}` : ""}]`;
  return text.length ? `${head}\n${text}` : head;
}
function result(text: string, details: HistoryReadResult["details"], selected: readonly PiSessionEntry[] = []): HistoryReadResult {
  const content: PiUserContent[] = [{ type: "text", text }];
  for (const entry of selected) {
    const blocks = entry.type === "custom_message" ? entry.content
      : entry.type === "message" && "content" in entry.message ? entry.message.content : undefined;
    if (Array.isArray(blocks)) {
      for (const part of blocks) if (part.type === "image") content.push({ ...part });
    }
  }
  return { content, details };
}

export function readHistoryPage(entries: readonly PiSessionEntry[], params: HistoryReadParams): HistoryReadResult {
  for (const name of ["before", "after", "offset", "limit", "start", "end"] as const) {
    const value = params[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (["limit", "start", "end"].includes(name) ? 1 : 0))) {
      throw new Error(`Invalid history ${name}`);
    }
  }
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 8;
  if (params.end !== undefined && params.start !== undefined && params.end < params.start) throw new Error("History end precedes start");
  if (params.start !== undefined || params.end !== undefined || params.tail || params.afterEntry !== undefined) {
    const anchor = params.afterEntry === undefined ? undefined : entries.findIndex(entry => entry.id === params.afterEntry);
    if (anchor === -1) return result(`history: no entry ${params.afterEntry} in this branch`, { found: false });
    const from = anchor !== undefined ? anchor + 1 : params.tail ? Math.max(0, entries.length - limit) : (params.start ?? 1) - 1;
    const to = Math.min(entries.length, params.end ?? from + limit);
    const selected = entries.slice(from, to);
    return result(selected.length ? selected.map((entry, index) => formatEntry(entry, `record ${from + index + 1}`)).join("\n\n") : "history: no records in this range", {
      from: from + 1, to, total: entries.length, ...(selected.length ? { afterEntry: selected[selected.length - 1]!.id } : {}),
      more: to < entries.length,
    }, selected);
  }
  if (params.entry !== undefined) {
    const index = entries.findIndex((entry) => entry.id === params.entry);
    if (index < 0) return result(`history: no entry ${params.entry} in this branch`, { found: false, entry: params.entry });
    const from = Math.max(0, index - (params.before ?? 0));
    const to = Math.min(entries.length - 1, index + (params.after ?? 0));
    const selected = entries.slice(from, to + 1);
    return result(selected.map((entry, i) => formatEntry(entry, from + i === index ? "target" : undefined)).join("\n\n"),
      { found: true, entry: params.entry, from, to, total: entries.length }, selected);
  }
  if (params.query === undefined && params.path === undefined && params.offset === undefined) {
    const boundaries = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "compaction");
    const lines = [`branch: ${entries.length} entries, ${boundaries.length} compaction boundary(ies)`];
    for (const { entry, index } of boundaries) if (entry.type === "compaction") {
      lines.push(`[compaction ${entry.id} at #${index} · firstKept=${entry.firstKeptEntryId}] ${(entry.summary.split("\n")[0] ?? "").slice(0, 160)}`);
    }
    lines.push("Search with query/path, or read one entry id with before/after.");
    return result(lines.join("\n"), { total: entries.length, compactions: boundaries.length });
  }
  const query = params.query?.toLowerCase();
  const path = params.path?.toLowerCase();
  const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
    const text = entryText(entry).text.toLowerCase();
    return (query === undefined || text.includes(query)) && (path === undefined || text.includes(path));
  });
  if (matches.length === 0) return result("history: no matching entries", { matches: 0, total: entries.length });
  const shown = matches.slice(offset, offset + limit);
  const nextOffset = offset + shown.length < matches.length ? offset + shown.length : undefined;
  const lines = shown.map(({ entry, index }) => formatEntry(entry, `#${index}`));
  if (nextOffset !== undefined) lines.push(`[${matches.length - nextOffset} more match(es) — continue with offset: ${nextOffset} and the same query/path, or narrow the query]`);
  if (!shown.length) lines.push("history: end of matching entries");
  return result(lines.join("\n\n"), { matches: matches.length, shown: shown.length, offset, total: entries.length,
    ...(nextOffset === undefined ? {} : { nextOffset }) }, shown.map(({ entry }) => entry));
}
