import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { trySurfaceWrite, type WorkspaceMutationJournalBridge } from "../workspace-mutation-journal.js";

const editorBufferHash = (text: string): string => (
  `sha256-${createHash("sha256").update(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8").digest("hex")}`
);

const diskContentHash = (text: string): string => (
  `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`
);

const ApplyPatchParams = Type.Object({
  patch: Type.String({
    description: "Codex-format patch: *** Begin Patch / *** Update File: path / *** Add File: path / *** Delete File: path / @@ context / *** End Patch",
  }),
});

// ── Codex patch parser ─────────────────────────────────────────────

type PatchOperation =
  | { kind: "update"; path: string; hunks: CodexHunk[] }
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string };

interface CodexHunk {
  anchor?: string;
  endOfFile?: boolean;
  lines: Array<{ type: "context" | "add" | "remove"; line: string }>;
}

function parseCodexPatch(patchText: string): { operations: PatchOperation[] } | { error: string } {
  const lines = patchText.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const operations: PatchOperation[] = [];
  let i = 0;

  // Expect *** Begin Patch
  if (lines[i]?.trim() !== "*** Begin Patch") {
    return { error: "Patch must start with *** Begin Patch" };
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") return { error: "Patch must end with *** End Patch" };
  i++;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") break;

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;
      const hunks: CodexHunk[] = [];
      let currentHunk: CodexHunk | null = null;

      while (i < lines.length && (!lines[i]!.startsWith("*** ") || lines[i] === "*** End of File")) {
        const hunkLine = lines[i]!;
        if (hunkLine === "*** End of File") {
          if (!currentHunk) return { error: "End of File outside hunk" };
          currentHunk.endOfFile = true;
          i++;
          break;
        }
        if (hunkLine.startsWith("@@")) {
          if (currentHunk) hunks.push(currentHunk);
          // @@ marker: the rest of the line after "@@ " is context
          const ctxAfterMarker = hunkLine.slice(2);
          // Strip leading space (the separator between @@ and context)
          const ctx = ctxAfterMarker.startsWith(" ") ? ctxAfterMarker.slice(1) : ctxAfterMarker;
          currentHunk = {
            ...(ctx.length > 0 ? { anchor: ctx } : {}),
            lines: [],
          };
        } else if (hunkLine.startsWith("+")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.lines.push({ type: "add", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("-")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.lines.push({ type: "remove", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith(" ")) {
          if (!currentHunk) return { error: "Context line outside hunk" };
          currentHunk.lines.push({ type: "context", line: hunkLine.slice(1) });
        } else if (hunkLine === "") {
          // Empty line is context
          if (currentHunk) currentHunk.lines.push({ type: "context", line: "" });
        } else {
          return { error: `Invalid hunk line: ${hunkLine}` };
        }
        i++;
      }
      if (currentHunk) hunks.push(currentHunk);
      operations.push({ kind: "update", path, hunks });
    } else if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        if (!lines[i]!.startsWith("+")) return { error: "Add File lines must start with +" };
        contentLines.push(lines[i]!.slice(1));
        i++;
      }
      operations.push({ kind: "add", path, content: contentLines.length ? contentLines.join("\n") + "\n" : "" });
    } else if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      operations.push({ kind: "delete", path });
      i++;
    } else {
      if (line.trim() !== "") return { error: `Unsupported patch directive: ${line}` };
      i++;
    }
  }

  if (operations.length === 0) {
    return { error: "No file operations found in patch" };
  }

  return { operations };
}

/** Resource preflight uses the exact parser that execution consumes. */
export function parseCodexPatchPaths(patchText: string): { paths: string[] } | { error: string } {
  const parsed = parseCodexPatch(patchText);
  if ("error" in parsed) return parsed;
  return { paths: parsed.operations.map((operation) => operation.path) };
}

// ── Apply a single update hunk ──────────────────────────────────────

function applyCodexHunks(content: string, hunks: CodexHunk[]): { result: string; applied: number } | { error: string } {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const contentLines = normalized ? normalized.split("\n") : [];
  if (trailingNewline) contentLines.pop();
  const result: string[] = [];
  let contentIdx = 0;
  let applied = 0;

  for (const hunk of hunks) {
    // Match the complete old span, preserving context interleaved with edits.
    // @@ text is a search anchor, not a line to move to the front of the hunk.
    let searchFrom = contentIdx;
    if (hunk.anchor !== undefined) {
      const anchorIndex = contentLines.indexOf(hunk.anchor, searchFrom);
      if (anchorIndex < 0) return { error: `Context not found for anchor: ${hunk.anchor}` };
      searchFrom = anchorIndex + 1;
    }
    const before = hunk.lines.filter(line => line.type !== "add").map(line => line.line);
    let foundIdx = -1;
    if (before.length === 0) {
      foundIdx = hunk.anchor === undefined || hunk.endOfFile ? contentLines.length : searchFrom;
    } else {
      for (let j = searchFrom; j <= contentLines.length - before.length; j++) {
        if (hunk.endOfFile && j + before.length !== contentLines.length) continue;
        if (before.every((line, index) => contentLines[j + index] === line)) {
          foundIdx = j;
          break;
        }
      }
    }

    if (foundIdx === -1) {
      return { error: `Context not found for hunk: ${before.slice(0, 3).join(" | ")}` };
    }

    // Copy the untouched prefix and replace the matched span in order.
    while (contentIdx < foundIdx) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    for (const line of hunk.lines) {
      if (line.type !== "remove") result.push(line.line);
    }
    contentIdx += before.length;
    applied++;
  }

  // Copy remaining lines
  while (contentIdx < contentLines.length) {
    result.push(contentLines[contentIdx]!);
    contentIdx++;
  }

  return { result: result.join(newline) + (trailingNewline && result.length ? newline : ""), applied };
}

// ── Tool factory ────────────────────────────────────────────────────

export function createApplyPatchTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  cwd: string,
  _mutationJournal?: WorkspaceMutationJournalBridge,
  options: { surfaceWrite?: boolean } = {},
): ToolDefinition {
  return defineTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a Codex-format multi-file patch. Supports *** Update File / *** Add File / *** Delete File with @@ context hunks.",
    promptSnippet: "apply_patch: apply Codex-format multi-file patches (Update/Add/Delete File)",
    promptGuidelines: [
      "Patch syntax: *** Begin Patch / *** Update File: path / @@ context / +added / -removed / *** End Patch.",
    ],
    parameters: ApplyPatchParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      const parsed = parseCodexPatch(params.patch);
      if ("error" in parsed) {
        return {
          content: [{ type: "text", text: `patch parse error: ${parsed.error}` }],
          details: { applied: false, error: parsed.error },
        };
      }

      const filePaths = parsed.operations.map((operation) => resolve(cwd, operation.path));

      const decodeSource = (source: { source: string; base64?: string }): string | null => {
        if ((source.source !== "disk" && source.source !== "working-branch" && source.source !== "surface-draft")
          || typeof source.base64 !== "string") {
          return null;
        }
        const bytes = Buffer.from(source.base64, "base64");
        return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? bytes.subarray(3).toString("utf8")
          : bytes.toString("utf8");
      };
      const requestOptions = signal === undefined ? {} : { signal };
      const readPatchBase = async (opPath: string): Promise<{
        content: string | null;
        revision?: string;
        hash?: string;
        error?: string;
      }> => {
        let source: Awaited<ReturnType<HostServicesBridge["request"]>>;
        try {
          source = await bridge.request("document.readSource", { path: opPath }, requestOptions);
        } catch (error) {
          return {
            content: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const content = decodeSource(source);
        if (content === null) {
          return { content: null, error: "document.readSource did not return readable " + source.source + " bytes" };
        }
        if (source.source === "disk") {
          // Carry the exact Host-read source identity into Documents' write plan.
          return { content, hash: diskContentHash(content) };
        }
        return {
          content,
          hash: editorBufferHash(content),
          ...("revision" in source && typeof source.revision === "string" ? { revision: source.revision } : {}),
        };
      };
      const patchResult = await (async () => {
        const prepared: Array<{
          op: (typeof parsed.operations)[number];
          filePath: string;
          action: "write" | "delete";
          content?: string;
          hunks?: number;
          error?: string;
          expectedRevision?: string;
          expectedHash?: string;
        }> = [];
        for (const [index, op] of parsed.operations.entries()) {
          const filePath = filePaths[index]!;
          if (op.kind === "add") {
            prepared.push({ op, filePath, action: "write", content: op.content });
            continue;
          }
          if (op.kind === "delete") {
            prepared.push({ op, filePath, action: "delete" });
            continue;
          }
          const base = await readPatchBase(op.path);
          if (base.error) {
            prepared.push({ op, filePath, action: "write", error: base.error });
            continue;
          }
          if (base.content === null) {
            prepared.push({ op, filePath, action: "write", error: `file not found: ${op.path}` });
            continue;
          }
          const applyResult = applyCodexHunks(base.content, op.hunks);
          if ("error" in applyResult) {
            prepared.push({ op, filePath, action: "write", error: `patch error in ${op.path}: ${applyResult.error}` });
            continue;
          }
          prepared.push({
            op,
            filePath,
            action: "write",
            content: applyResult.result,
            hunks: applyResult.applied,
            ...(base.revision === undefined ? {} : { expectedRevision: base.revision }),
            ...(base.hash === undefined ? {} : { expectedHash: base.hash }),
          });
        }
        const prepareError = prepared.find((row) => row.error);
        if (prepareError?.error) {
          return {
            content: [{ type: "text" as const, text: prepareError.error }],
            details: { applied: false, error: prepareError.error },
          };
        }
        const virtual = await bridge.request("document.branchWrite", {
          changes: prepared.map((row) => ({
            path: row.op.path,
            action: row.action,
            ...(row.content === undefined ? {} : { content: row.content }),
          })),
        }, requestOptions);
        if (virtual.status === "committed") {
          const hunks = prepared.reduce((sum, row) => sum + (row.hunks ?? 0), 0);
          return {
            content: [{ type: "text" as const, text: `patch applied successfully (${parsed.operations.length} file(s), ${hunks} hunk(s))` }],
            details: { applied: true, operations: parsed.operations.length, hunks, mutation: { status: "committed" } },
          };
        }
        if (virtual.status !== "disk") {
          return {
            content: [{ type: "text" as const, text: virtual.message }],
            details: { applied: false, error: virtual.message },
          };
        }
        if (options.surfaceWrite === true) {
          const planned = await trySurfaceWrite(bridge, {
            changes: prepared.map((row) => ({
              path: row.op.path,
              action: row.action,
              ...(row.content === undefined ? {} : { content: row.content }),
              ...(row.expectedRevision === undefined ? {} : { expectedRevision: row.expectedRevision }),
              ...(row.expectedHash === undefined ? {} : { expectedHash: row.expectedHash }),
            })),
          }, signal, "apply_patch");
          if (planned !== "disk") {
            return {
              content: [{ type: "text" as const, text: planned.text }],
              details: { applied: planned.status === "applied", operations: parsed.operations.length,
                mutation: { status: planned.status, results: planned.results } },
            };
          }
        }
        const message = "Host document mutation backend is unavailable; refusing a parallel pi-host disk apply";
        return {
          content: [{ type: "text" as const, text: message }],
          details: { applied: false, error: message, operations: parsed.operations.length },
        };
      })();
      return patchResult;
    },
  });
}
