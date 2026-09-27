/**
 * Tool card compact rendering — one-line summaries and grouping.
 *
 * Summaries are derived from `details` (not `content`), per
 * docs/design/harness-tools.md section 5.1 principle 2: details are for rendering,
 * content is for the model.
 *
 * Grouping: consecutive read-only calls (grep, read, find, ls, diagnostics,
 * webfetch, websearch) in the same assistant step are folded into a group
 * with a header "first summary + and N other queries". Write tools and bash
 * never enter groups.
 */

export interface ToolSummaryInput {
  toolName: string;
  details?: unknown;
  arguments?: unknown;
}

export interface ToolSummary {
  /** One-line summary text */
  text: string;
  /** Whether this tool is read-only (can be grouped) */
  readOnly: boolean;
}

/** Tool names that are read-only and can be grouped */
const READ_ONLY_TOOLS = new Set([
  "grep", "read", "find", "glob", "ls", "diagnostics", "symbols", "definition", "references", "hover", "webfetch", "websearch",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Generate a one-line summary for a tool call from its details.
 * Returns empty text if no summary can be generated.
 */
export function getToolSummary(input: ToolSummaryInput): ToolSummary {
  const name = input.toolName.toLowerCase().replace(/:\d+$/, "");
  const details = asRecord(input.details);
  const args = asRecord(input.arguments);
  const readOnly = READ_ONLY_TOOLS.has(name);

  switch (name) {
    case "grep": {
      const pattern = asString(args?.pattern) ?? "";
      const path = asString(args?.path) ?? "workspace";
      const hits = asNumber(details?.hitCount) ?? asNumber(details?.count);
      const files = asNumber(details?.fileCount);
      const hitStr = hits !== undefined ? `${hits} hits` : "";
      const fileStr = files !== undefined ? ` in ${files} files` : "";
      return {
        text: `Searched ${pattern} in ${path}${hitStr ? ` · ${hitStr}${fileStr}` : ""}`,
        readOnly,
      };
    }
    case "read": {
      const path = asString(args?.file_path) ?? asString(args?.path) ?? "";
      const start = asNumber(args?.offset);
      const end = asNumber(args?.limit) !== undefined
        ? (start ?? 0) + (asNumber(args?.limit) ?? 0)
        : undefined;
      const range = start !== undefined && end !== undefined ? `:${start}-${end}` : "";
      return { text: `Read ${path}${range}`, readOnly };
    }
    case "find":
    case "glob": {
      const pattern = asString(args?.pattern) ?? asString(args?.glob) ?? "";
      const count = asNumber(details?.count);
      const countStr = count !== undefined ? `${count} files` : "files";
      return { text: `Found ${countStr} for ${pattern}`, readOnly };
    }
    case "ls": {
      const path = asString(args?.path) ?? asString(args?.directory) ?? ".";
      return { text: `Listed ${path}`, readOnly };
    }
    case "bash": {
      const command = asString(args?.command) ?? "";
      const firstLine = command.split("\n")[0] ?? "";
      const exitCode = asNumber(details?.exitCode);
      const durationMs = asNumber(details?.durationMs);
      const exitStr = exitCode !== undefined ? ` · exit ${exitCode}` : "";
      const durStr = durationMs !== undefined ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
      const shellId = asString(details?.shellId) ?? (details?.kind === "background" ? asString(details?.id) : undefined);
      const preparing = details?.kind === "preparing";
      const bgStr = preparing
        ? ` · preparing · execution ${asString(details?.executionId) ?? asString(details?.id) ?? "unknown"}`
        : shellId !== undefined ? ` · running · shell ${shellId}` : "";
      return {
        text: `${firstLine.slice(0, 80)}${exitStr}${durStr}${bgStr}`,
        readOnly: false,
      };
    }
    case "edit":
    case "write":
    case "apply_patch":
    case "multiedit": {
      const path = asString(args?.file_path) ?? asString(args?.path) ?? "";
      const added = asNumber(details?.added) ?? asNumber(details?.linesAdded);
      const removed = asNumber(details?.removed) ?? asNumber(details?.linesRemoved);
      const diffStr = added !== undefined || removed !== undefined
        ? ` (+${added ?? 0} −${removed ?? 0})`
        : "";
      return { text: `Edited ${path}${diffStr}`, readOnly: false };
    }
    case "diagnostics": {
      const path = asString(args?.path) ?? "";
      const newCount = asNumber(details?.newCount) ?? asNumber(details?.count);
      const newStr = newCount !== undefined ? ` · ${newCount} new` : "";
      return { text: `Diagnostics ${path}${newStr}`, readOnly };
    }
    case "symbols": {
      const query = asString(args?.query) ?? "";
      const path = asString(args?.path) ?? "";
      return { text: `Symbols ${query}${path ? ` · ${path}` : ""}`, readOnly };
    }
    case "definition":
    case "references":
    case "hover": {
      const path = asString(args?.path) ?? "";
      const line = asNumber(args?.line);
      const character = asNumber(args?.character);
      const position = line === undefined ? "" : `:${line}${character === undefined ? "" : `:${character}`}`;
      return { text: `${name[0]!.toUpperCase()}${name.slice(1)} ${path}${position}`, readOnly };
    }
    case "webfetch": {
      const url = asString(args?.url) ?? "";
      const status = asString(details?.status) ?? "";
      const shortUrl = url.length > 60 ? url.slice(0, 57) + "..." : url;
      return { text: `Fetched ${shortUrl}${status ? ` · ${status}` : ""}`, readOnly };
    }
    case "websearch": {
      const query = asString(args?.query) ?? "";
      const count = asNumber(details?.count);
      const countStr = count !== undefined ? ` · ${count} results` : "";
      return { text: `Searched "${query}"${countStr}`, readOnly };
    }
    default: {
      // Unknown tools have no declared mutation metadata on the renderer side;
      // keeping them separate is the only honest default.
      return { text: name, readOnly: false };
    }
  }
}

export interface ToolGroupEntry {
  toolName: string;
  details?: unknown;
  arguments?: unknown;
  toolCallId: string;
}

export interface ToolGroup {
  /** Single tool — not grouped */
  type: "single";
  entry: ToolGroupEntry;
  summary: ToolSummary;
}

export interface ToolGroupFolded {
  /** Multiple consecutive read-only tools folded into one group */
  type: "group";
  entries: ToolGroupEntry[];
  summaries: ToolSummary[];
  headerSummary: string;
}

export type ToolGroupResult = ToolGroup | ToolGroupFolded;

/**
 * Group consecutive read-only tool calls.
 * - 2+ consecutive read-only calls → folded group
 * - Write tools and bash break groups (never grouped themselves)
 * - Single read-only call stays as single
 */
export function groupToolCalls(entries: ToolGroupEntry[]): ToolGroupResult[] {
  const results: ToolGroupResult[] = [];
  let currentGroup: { entries: ToolGroupEntry[]; summaries: ToolSummary[] } = { entries: [], summaries: [] };

  const flushGroup = () => {
    if (currentGroup.entries.length === 0) return;
    if (currentGroup.entries.length === 1) {
      results.push({
        type: "single",
        entry: currentGroup.entries[0]!,
        summary: currentGroup.summaries[0]!,
      });
    } else {
      const firstSummary = currentGroup.summaries[0]!.text;
      const restCount = currentGroup.entries.length - 1;
      results.push({
        type: "group",
        entries: currentGroup.entries,
        summaries: currentGroup.summaries,
        headerSummary: `${firstSummary} and ${restCount} other ${restCount === 1 ? "query" : "queries"}`,
      });
    }
    currentGroup = { entries: [], summaries: [] };
  };

  for (const entry of entries) {
    const summary = getToolSummary(entry);
    if (summary.readOnly) {
      currentGroup.entries.push(entry);
      currentGroup.summaries.push(summary);
    } else {
      flushGroup();
      results.push({ type: "single", entry, summary });
    }
  }
  flushGroup();

  return results;
}
