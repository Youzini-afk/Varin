import fs from "node:fs/promises";
import path from "node:path";
import {
  createLsToolDefinition,
  type LsOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DocumentPathOverlayResult } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

const pathKey = (value: string): string => (
  process.platform === "win32" ? value.toLowerCase() : value
);

const resolveToCwd = (value: string | undefined, cwd: string): string => (
  path.resolve(cwd, value || ".")
);

interface OverlayNode {
  absolutePath: string;
  kind: "file" | "directory";
}

const makeOperations = (
  rootPath: string,
  overlay: Extract<DocumentPathOverlayResult, { status: "ready" }>,
  signal: AbortSignal | undefined,
): LsOperations => {
  const exclusive = overlay.authority === "working-branch";
  const nodes = new Map<string, OverlayNode>();
  const removed = new Set((overlay.removedPaths ?? []).map((relative) => pathKey(path.resolve(rootPath, relative))));
  const addNode = (absolutePath: string, kind: OverlayNode["kind"]): void => {
    const normalized = path.resolve(absolutePath);
    const key = pathKey(normalized);
    const existing = nodes.get(key);
    if (existing && existing.kind !== kind) {
      throw new Error(`Surface path overlay conflict: ${normalized} is both a file and a directory`);
    }
    nodes.set(key, { absolutePath: normalized, kind });
  };

  for (const entry of overlay.entries) {
    const absolute = path.resolve(rootPath, entry.path);
    addNode(absolute, entry.kind);
    if (pathKey(absolute) === pathKey(rootPath)) continue;
    // Add the complete ancestor closure so a nested dirty-only file can make
    // each virtual directory (including the requested root) listable.
    let current = path.dirname(absolute);
    while (true) {
      addNode(current, "directory");
      if (pathKey(current) === pathKey(rootPath)) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const throwIfAborted = (): void => signal?.throwIfAborted();
  const findNode = (absolutePath: string): OverlayNode | undefined => nodes.get(pathKey(path.resolve(absolutePath)));

  const stat = async (absolutePath: string): Promise<{ isDirectory: () => boolean }> => {
    throwIfAborted();
    const normalized = path.resolve(absolutePath);
    if (removed.has(pathKey(normalized))) {
      const error = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const node = findNode(normalized);
    if (node) return { isDirectory: () => node.kind === "directory" };
    if (exclusive) {
      const error = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    // The fixed snapshot is authoritative for a covered path. A disk type
    // drift is therefore resolved in favor of the overlay rather than being
    // silently dropped by Pi's native per-entry stat loop.
    return fs.stat(normalized);
  };

  return {
    exists: async (absolutePath) => {
      throwIfAborted();
      if (removed.has(pathKey(path.resolve(absolutePath)))) return false;
      if (findNode(absolutePath)) return true;
      if (exclusive) return false;
      try {
        await fs.stat(path.resolve(absolutePath));
        return true;
      } catch {
        return false;
      }
    },
    stat,
    readdir: async (absolutePath) => {
      throwIfAborted();
      const normalized = path.resolve(absolutePath);
      const names = new Map<string, string>();
      if (!exclusive) {
        try {
          for (const name of await fs.readdir(normalized)) {
            if (!removed.has(pathKey(path.resolve(normalized, name)))) names.set(pathKey(name), name);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT"
            && (error as NodeJS.ErrnoException)?.code !== "ENOTDIR") throw error;
        }
      }
      const parentKey = pathKey(normalized);
      for (const node of nodes.values()) {
        if (pathKey(path.dirname(node.absolutePath)) !== parentKey) continue;
        const name = path.basename(node.absolutePath);
        if (!names.has(pathKey(name))) names.set(pathKey(name), name);
      }
      return [...names.values()];
    },
  };
};

/** Keep Pi's native ls rendering and limits while merging fixed path entries. */
export function createSurfaceAwareLsTool(
  bridge: HostServicesBridge,
  cwd: string,
): ToolDefinition {
  const native = createLsToolDefinition(cwd);
  const wrapped: ReturnType<typeof createLsToolDefinition> = {
    ...native,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      signal?.throwIfAborted();
      const rootPath = resolveToCwd(params.path, cwd);
      const anchoredParams = { ...params, path: rootPath };
      const overlay = await bridge.request(
        "document.pathOverlay",
        { path: rootPath },
        signal === undefined ? {} : { signal },
      );
      signal?.throwIfAborted();
      if (overlay.status === "disk") {
        return native.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
      }
      const operations = makeOperations(rootPath, overlay, signal);
      const surface = createLsToolDefinition(cwd, { operations });
      return surface.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
    },
  };
  return wrapped as unknown as ToolDefinition;
}
