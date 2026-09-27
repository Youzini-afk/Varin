import fs from "node:fs/promises";
import path from "node:path";
import {
  createFindToolDefinition,
  type FindOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DocumentPathOverlayResult } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

const DEFAULT_FIND_LIMIT = 1000;
const NO_FILES_TEXT = "No files found matching pattern";

const resolveToCwd = (value: string | undefined, cwd: string): string => (
  path.resolve(cwd, value || ".")
);

const pathKey = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return process.platform === "win32" ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
};

interface FindPath {
  path: string;
  kind: "file" | "directory";
}

const overlayResultPaths = (
  overlay: Extract<DocumentPathOverlayResult, { status: "ready" }>,
): FindPath[] => {
  const paths = new Map<string, FindPath>();
  for (const entry of overlay.entries) {
    const relative = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relative || relative === ".") continue;
    const value = entry.kind === "directory" && !relative.endsWith("/") ? `${relative}/` : relative;
    // A fixed snapshot entry wins over a disk result with the same identity.
    paths.set(pathKey(value), { path: value, kind: entry.kind });
  }
  return [...paths.values()];
};

const hasVirtualRoot = (
  overlay: Extract<DocumentPathOverlayResult, { status: "ready" }>,
): boolean => overlay.entries.some((entry) => entry.kind === "directory" && entry.path === ".");

const diskPathExists = async (absolutePath: string): Promise<boolean> => {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
};

interface NativeFindResult {
  content: Array<{ type: string; text?: string }>;
  details?: { resultLimitReached?: number; truncation?: { truncated?: boolean } };
}

/**
 * Parse only the trailing notices emitted by Pi's native definition. A file
 * named `[name].ts` remains a valid result; notice recognition is anchored to
 * the exact native format instead of treating every bracketed line as prose.
 */
export const parseNativeFindResultPaths = (result: NativeFindResult): FindPath[] => {
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  const details = result.details;
  const lines = text.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === NO_FILES_TEXT) return [];
  // Pi appends one bracketed notice block after a blank line. Details tell us
  // whether such a block exists, including the combined limit+byte variant;
  // the block text itself is intentionally opaque here.
  if (details?.resultLimitReached !== undefined || details?.truncation?.truncated === true) {
    const noticeStart = text.lastIndexOf("\n\n[");
    if (noticeStart >= 0 && text.endsWith("]")) {
      const withoutNotice = text.slice(0, noticeStart).trim();
      lines.splice(0, lines.length, ...withoutNotice.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    }
  }
  return lines.map((value) => ({
    path: value.endsWith("/") ? value : value.replace(/\/$/u, ""),
    kind: value.endsWith("/") ? "directory" as const : "file" as const,
  }));
};

const sortPaths = (paths: readonly FindPath[]): FindPath[] => [...paths].sort((left, right) => (
  left.path.toLowerCase().localeCompare(right.path.toLowerCase()) || left.path.localeCompare(right.path)
));

const createFormattingOperations = (combined: readonly FindPath[]): FindOperations => ({
  exists: () => true,
  glob: (_pattern, _cwd, options) => combined.slice(0, Math.max(0, options.limit)).map((entry) => entry.path),
});

/** Keep Pi's fd implementation and rendering while merging fixed paths. */
export function createSurfaceAwareFindTool(
  bridge: HostServicesBridge,
  cwd: string,
): ToolDefinition {
  const native = createFindToolDefinition(cwd);
  const wrapped: ReturnType<typeof createFindToolDefinition> = {
    ...native,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      signal?.throwIfAborted();
      const rootPath = resolveToCwd(params.path, cwd);
      const anchoredParams = { ...params, path: rootPath };
      const overlay = await bridge.request(
        "document.pathOverlay",
        { path: rootPath, pattern: params.pattern },
        signal === undefined ? {} : { signal },
      );
      signal?.throwIfAborted();
      if (overlay.status === "disk") {
        return native.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
      }
      const limit = params.limit ?? DEFAULT_FIND_LIMIT;
      const fixedPaths = overlayResultPaths(overlay);
      const exclusive = overlay.authority === "working-branch";
      const rootOnDisk = exclusive ? false : await diskPathExists(rootPath);
      let diskPaths: FindPath[] = [];
      let diskResult: Awaited<ReturnType<typeof native.execute>> | undefined;
      if (!exclusive && (rootOnDisk || !hasVirtualRoot(overlay))) {
        try {
          // Over-fetch by the complete fixed entry count so disk results do not
          // occupy the user's final limit before the merge.
          const nativeLimit = fixedPaths.length > 0 ? limit + fixedPaths.length : limit;
          diskResult = await native.execute(
            toolCallId,
            { ...anchoredParams, limit: nativeLimit },
            signal,
            onUpdate,
            ctx,
          );
          signal?.throwIfAborted();
          diskPaths = parseNativeFindResultPaths(diskResult as NativeFindResult);
        } catch (error) {
          signal?.throwIfAborted();
          if (fixedPaths.length === 0) throw error;
        }
      }

      const merged = new Map<string, FindPath>();
      for (const candidate of diskPaths) {
        const normalized = candidate.path.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normalized) merged.set(pathKey(normalized), { path: normalized, kind: candidate.kind });
      }
      for (const candidate of fixedPaths) merged.set(pathKey(candidate.path), candidate);
      for (const removed of overlay.removedPaths ?? []) merged.delete(pathKey(removed));
      const sorted = sortPaths([...merged.values()]);
      if (sorted.length === 0) {
        return {
          content: [{ type: "text", text: NO_FILES_TEXT }],
          details: diskResult?.details,
        };
      }

      // Re-enter Pi's own definition with a bounded custom operation. It
      // performs the canonical entry limit, notice, and 50KB byte truncation.
      const formatter = createFindToolDefinition(cwd, { operations: createFormattingOperations(sorted) });
      return formatter.execute(toolCallId, { ...anchoredParams, limit }, signal, onUpdate, ctx);
    },
  };
  return wrapped as unknown as ToolDefinition;
}
