import type { WorkingBranchReadProvenance } from "@varin/protocol";
import type { SurfaceSnapshotOverlayEntry } from "../../documents/surface-snapshot-store.js";
import type { ExploreFileSnapshot } from "../explore-file-reader.js";
import type { HarnessDocumentPathOverlayLookup, HarnessDocumentReadLookup } from "../service-host.js";
import { readBranchFile, resolveReadableBranchPath } from "./branch-view.js";
import { readContentPage } from '../read-page.js';
import type { ThreadExecutionViewRegistry } from "./execution-view.js";
import type { WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./types.js";

import { createWorkingBranchQuery, type WorkingBranchPinOptions, type WorkingBranchQuerySnapshot } from "./working-branch-query.js";
export type { WorkingBranchPinOptions, WorkingBranchQuerySnapshot } from "./working-branch-query.js";

export interface WorkingBranchLookups {
  readSource(sessionId: string, resourceId: string, workspaceId: string,
    options?: { page: import('@varin/protocol').DocumentReadPageRequest; signal?: AbortSignal }): Promise<HarnessDocumentReadLookup | null>;
  pathOverlay(sessionId: string, resourceId: string, workspaceId: string): Promise<HarnessDocumentPathOverlayLookup | null>;
  exploreFile(sessionId: string, resourceId: string, workspaceId: string): Promise<ExploreFileSnapshot | null>;
  pinQuery(sessionId: string, options?: WorkingBranchPinOptions): Promise<WorkingBranchQuerySnapshot | null>;
}

const provenanceFor = (
  view: { branchId: string; writeRevision: number },
  origin: WorkingBranchReadProvenance["origin"],
): WorkingBranchReadProvenance => ({
  branchId: view.branchId,
  revision: view.writeRevision,
  origin,
});

export function createWorkingBranchLookups(options: {
  views: ThreadExecutionViewRegistry;
  workingStates: WorkspaceWorkingStateRootAccess;
}): WorkingBranchLookups {
  const withView = async <T>(
    sessionId: string,
    read: (view: NonNullable<ReturnType<ThreadExecutionViewRegistry["get"]>>, store: WorkingStateRootStore) => Promise<T> | T,
  ): Promise<T | null> => {
    const bound = options.views.get(sessionId);
    if (!bound || bound.mode === "materialized") return null;
    return options.workingStates.withBranchStore(
      bound.workspaceId,
      "working-branch-view",
      async (store): Promise<T | null> => {
        const view = options.views.get(sessionId);
        if (!view || view.mode === "materialized") return null;
        return read(view, store);
      },
      "shared",
      { sessionId: bound.sessionId, threadId: bound.threadId, runId: bound.runId },
    );
  };

  return {
    async readSource(sessionId, resourceId, workspaceId, readOptions) {
      if (options.views.get(sessionId)?.workspaceId !== workspaceId) return null;
      return withView(sessionId, async (view, store) => {
        if (view.workspaceId !== workspaceId) return null;
        if (readOptions) {
          const signalOptions = readOptions.signal ? { signal: readOptions.signal } : {};
          const pin = await store.pinBranch(view.branchId, signalOptions);
          try {
            const resolved = await resolveReadableBranchPath(store, view.branchId, resourceId, undefined,
              { read: { pin, ...signalOptions } });
            if ('unavailable' in resolved) return { status: 'unavailable', message: resolved.unavailable };
            const provenance = provenanceFor({ ...view, writeRevision: resolved.viewRevision }, resolved.origin);
            if ('missing' in resolved) return { status: 'working-branch', revision: resolved.revision, provenance, missing: true };
            if (resolved.state.kind !== 'regular-file') return { status: 'unavailable', message: 'Branch source is not a regular file' };
            const page = await readContentPage(async (offset, length) => {
              const bytes = await store.readContent(resolved.entry, { offset, length, ...signalOptions });
              if (!bytes) throw new Error(`Working-state object is missing for ${resolved.path}`);
              return bytes;
            }, resolved.state.byteLength, readOptions.page, readOptions.signal);
            return { status: 'working-branch', revision: resolved.revision, provenance, page };
          } finally { await pin.release(); }
        }
        const result = await readBranchFile(store, view.branchId, resourceId);
        if ("unavailable" in result) {
          return {
            status: "working-branch" as const,
            revision: `working-branch:${view.branchId}@${view.writeRevision}:base`,
            provenance: provenanceFor(view, "base"),
            message: result.unavailable,
          };
        }
        if ("missing" in result) {
          return {
            status: "working-branch" as const,
            revision: result.revision,
            provenance: provenanceFor({ ...view, writeRevision: result.viewRevision }, result.origin),
            missing: true as const,
          };
        }
        return {
          status: "working-branch" as const,
          revision: result.revision,
          provenance: provenanceFor({ ...view, writeRevision: result.viewRevision }, result.origin),
          base64: result.bytes.toString("base64"),
        };
      });
    },

    async pathOverlay(sessionId, resourceId, workspaceId) {
      if (options.views.get(sessionId)?.workspaceId !== workspaceId) return null;
      return withView(sessionId, async (view, store) => {
        if (view.workspaceId !== workspaceId) return null;
        const pin = await store.pinBranch(view.branchId);
        try {
          const result = await store.queryFiles(pin, { lane: "foreground", operation: "list", paths: [resourceId], includeHidden: true });
          if (result.status === "failed" || result.status === "partial" || result.status === "cancelled") {
            return { status: "unavailable" as const, message: result.message ?? "Working-branch path query did not complete" };
          }
          const root = resourceId.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
          const entries: SurfaceSnapshotOverlayEntry[] = result.records.filter(record => record.kind === "entry").map(record => ({
            path: record.path === root || !record.path ? "." : root ? record.path.slice(root.length + 1) : record.path,
            kind: (record.data as {kind:string}).kind === "directory" ? "directory" : "file",
            revision: "working-branch:" + pin.branchId + "@" + pin.writeRevision + ":" + (record.revision || pin.root),
          }));
          entries.sort((left,right) => left.path.localeCompare(right.path));
        return { status: "ready" as const, authority: "working-branch" as const, entries };
        } finally { await pin.release(); }
      });
    },

    async exploreFile(sessionId, resourceId, workspaceId) {
      if (options.views.get(sessionId)?.workspaceId !== workspaceId) return null;
      return withView(sessionId, async (view, store) => {
        if (view.workspaceId !== workspaceId) return null;
        const result = await readBranchFile(store, view.branchId, resourceId);
        if ("unavailable" in result) {
          return { status: "unavailable" as const, message: result.unavailable };
        }
        if ("missing" in result) {
          return { status: "unavailable" as const, message: `${result.path} is not present in this working branch` };
        }
        if (result.bytes.includes(0)) {
          return { status: "unavailable" as const, message: `${result.path} is not a text file in this working branch` };
        }
        return {
          status: "ready" as const,
          content: result.bytes.toString("utf8"),
          revision: result.revision,
          source: "working-branch" as const,
        };
      });
    },

    async pinQuery(sessionId, options) {
      return withView(sessionId, async (view, store) => {
        options?.signal?.throwIfAborted();
        if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          throw new DOMException("Explore query deadline exceeded", "AbortError");
        }
        const pin = await store.pinBranch(view.branchId, options?.signal ? { signal: options.signal } : undefined);
        try { return createWorkingBranchQuery(store, pin, sessionId, options); }
        catch (error) { await pin.release(); throw error; }

      });
    },
  };
}

export async function exploreFileFromSnapshot(
  snapshot: WorkingBranchQuerySnapshot,
  resourceId: string,
): Promise<ExploreFileSnapshot> {
  return snapshot.readFile(resourceId);
}
