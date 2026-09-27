import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { fetchDiagnostics, trySurfaceWrite, type WorkspaceMutationJournalBridge } from "../workspace-mutation-journal.js";

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
  context: string[];   // lines starting with space or @@ (unchanged context)
  changes: Array<{ type: "add" | "remove"; line: string }>;
}

function parseCodexPatch(patchText: string): { operations: PatchOperation[] } | { error: string } {
  const lines = patchText.split("\n");
  const operations: PatchOperation[] = [];
  let i = 0;

  // Expect *** Begin Patch
  if (lines[i]?.trim() !== "*** Begin Patch") {
    return { error: "Patch must start with *** Begin Patch" };
  }
  i++;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") break;

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;
      const hunks: CodexHunk[] = [];
      let currentHunk: CodexHunk | null = null;

      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const hunkLine = lines[i]!;
        if (hunkLine.startsWith("@@")) {
          if (currentHunk) hunks.push(currentHunk);
          // @@ marker: the rest of the line after "@@ " is context
          const ctxAfterMarker = hunkLine.slice(2);
          // Strip leading space (the separator between @@ and context)
          const ctx = ctxAfterMarker.startsWith(" ") ? ctxAfterMarker.slice(1) : ctxAfterMarker;
          currentHunk = {
            context: ctx.length > 0 ? [ctx] : [],
            changes: [],
          };
        } else if (hunkLine.startsWith("+")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.changes.push({ type: "add", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("-")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.changes.push({ type: "remove", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith(" ")) {
          if (!currentHunk) return { error: "Context line outside hunk" };
          currentHunk.context.push(hunkLine.slice(1));
        } else if (hunkLine === "") {
          // Empty line is context
          if (currentHunk) currentHunk.context.push("");
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
        contentLines.push(lines[i]!);
        i++;
      }
      operations.push({ kind: "add", path, content: contentLines.join("\n") });
    } else if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      operations.push({ kind: "delete", path });
      i++;
    } else {
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
  const contentLines = content.split("\n");
  const result: string[] = [];
  let contentIdx = 0;
  let applied = 0;

  for (const hunk of hunks) {
    // Context lines are the search anchor — used to find position but
    // NOT output to result (they remain in the file, copied from content).
    const plainContext = hunk.context;

    // Find the context block in remaining content
    let foundIdx = -1;
    if (plainContext.length === 0 && hunk.changes.length > 0) {
      // No context — search for the first remove line as anchor
      const firstRemove = hunk.changes.find((c) => c.type === "remove");
      if (firstRemove) {
        for (let j = contentIdx; j < contentLines.length; j++) {
          if (contentLines[j] === firstRemove.line) {
            foundIdx = j;
            break;
          }
        }
        if (foundIdx === -1) {
          return { error: `Line not found for removal: ${firstRemove.line}` };
        }
      } else {
        // Only additions — apply at current position
        foundIdx = contentIdx;
      }
    } else {
      for (let j = contentIdx; j <= contentLines.length - plainContext.length; j++) {
        let match = true;
        for (let k = 0; k < plainContext.length; k++) {
          if (contentLines[j + k] !== plainContext[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundIdx = j;
          break;
        }
      }
    }

    if (foundIdx === -1) {
      const ctxPreview = plainContext.slice(0, 3).join(" | ");
      return { error: `Context not found for hunk: ${ctxPreview}` };
    }

    // Copy lines before context (or before the found remove position)
    while (contentIdx < foundIdx) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    // Copy context lines from content (they stay in the file)
    for (let k = 0; k < plainContext.length; k++) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    // Apply changes after context
    for (const change of hunk.changes) {
      if (change.type === "remove") {
        // Verify the line matches
        if (contentLines[contentIdx] !== change.line) {
          return { error: `Remove mismatch: expected "${change.line}", got "${contentLines[contentIdx] ?? "<EOF>"}"` };
        }
        contentIdx++;
      } else {
        result.push(change.line);
      }
    }
    applied++;
  }

  // Copy remaining lines
  while (contentIdx < contentLines.length) {
    result.push(contentLines[contentIdx]!);
    contentIdx++;
  }

  return { result: result.join("\n"), applied };
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
      "Use apply_patch for multi-file edits with Codex patch syntax.",
      "Format: *** Begin Patch / *** Update File: path / @@ context / +added / -removed / *** End Patch",
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
            details: { applied: true, operations: parsed.operations.length, hunks },
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
            let text = planned.text;
            const diagnostics: string[] = [];
            for (const row of prepared) {
              if (row.action !== "write") continue;
              const appliedOnDisk = planned.results.some((entry) => (
                entry.path === row.op.path && entry.target === "disk" && entry.status === "applied"
              ));
              if (!appliedOnDisk) continue;
              const diagnostic = await fetchDiagnostics(bridge, row.op.path, 500);
              if (diagnostic?.status === "ready" && diagnostic.summary !== "clean") {
                diagnostics.push(`${row.op.path}: ${diagnostic.summary}`);
              }
            }
            if (diagnostics.length > 0) text += `\n\n[diagnostics: ${diagnostics.join("; ")}]`;
            return {
              content: [{ type: "text" as const, text }],
              details: { applied: planned.status === "applied", operations: parsed.operations.length },
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
