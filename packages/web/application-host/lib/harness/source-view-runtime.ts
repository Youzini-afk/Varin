import type { AgentInputContext } from "@varin/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import { encodeDocumentText } from "../documents/inspect.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import type { HarnessDocumentReadLookup, HarnessServiceHost } from "./service-host.js";
import { sourceViewIdFromContext, type createSourceViewStore } from "./source-view-store.js";
import type { createThreadRegistry } from "./thread-registry.js";
import type { ThreadWorktreeRuntime } from "./thread-worktree.js";
import type { ThreadExecutionViewRegistry } from "./working-state/execution-view.js";
import type { WorkingBranchLookups } from "./working-state/working-branch-lookups.js";
import type { createWorkingBranchWriteServices } from "./working-state/working-branch-writes.js";

type SourceViewStore = ReturnType<typeof createSourceViewStore>;
type BranchWrites = ReturnType<typeof createWorkingBranchWriteServices>;

/** One source-selection contract shared by native reads, search, LSP and writes. */
export function createSourceViewRuntime(options: {
  documents: DocumentAuthority;
  registry: ReturnType<typeof createThreadRegistry>;
  views: ThreadExecutionViewRegistry;
  branchLookups: WorkingBranchLookups;
  branchWrites: Pick<BranchWrites, "branchWrite">;
  worktrees: Pick<ThreadWorktreeRuntime, "assertOwnership">;
  sourceViews: SourceViewStore;
}) {
  const { documents, registry, views, branchLookups, branchWrites, worktrees, sourceViews } = options;

  const viewForSession = async (sessionId: string, context: AgentInputContext): Promise<string | null> => {
    const viewId = sourceViewIdFromContext(context);
    if (!viewId) return null;
    const binding = await registry.getSessionBinding(sessionId);
    const thread = binding && await registry.getThreadById(binding.owningScopeId, binding.threadId);
    if (!thread || thread.manifest.sourceViewId !== viewId) throw new Error("The fixed source view does not belong to this thread");
    const fixed = await sourceViews.contextFor(viewId);
    if (!fixed || fixed.source !== "surface" || context.source !== "surface"
      || JSON.stringify(fixed.roots) !== JSON.stringify(context.roots)) {
      throw new Error("The fixed source view no longer matches this thread input");
    }
    return viewId;
  };

  const contextForSession = async (sessionId: string): Promise<AgentInputContext | undefined> => {
    const binding = await registry.getSessionBinding(sessionId);
    const thread = binding && await registry.getThreadById(binding.owningScopeId, binding.threadId);
    const viewId = thread?.manifest.sourceViewId;
    if (!viewId) return undefined;
    const context = await sourceViews.contextFor(viewId);
    if (!context) throw new Error(`The fixed source view for thread ${thread.id} is unavailable`);
    return context;
  };

  const aliasFor = async (viewId: string, workspaceId: string, resourceId: string) => {
    const identity = await documents.resolveResourceIdentity({ workspaceId, resourceId }).catch(() => null);
    return sourceViews.targetAlias(viewId, workspaceId, resourceId, identity?.coordinationId ?? null);
  };

  const materializedThreadRoot = async (sessionId: string) => {
    const binding = await registry.getSessionBinding(sessionId);
    const thread = binding && await registry.getThreadById(binding.owningScopeId, binding.threadId);
    if (!thread?.worktree?.path || thread.worktree.materialized === false) return null;
    await worktrees.assertOwnership(thread.worktree, "access materialized source alias");
    return documents.resolveWorkspace({ path: thread.worktree.path });
  };

  const reconcilePending = async (viewId: string, workspaceId: string, resourceId: string): Promise<void> => {
    const pending = await sourceViews.pendingOperation(viewId, workspaceId, resourceId);
    if (!pending?.sessionId) return;
    const operation = await documents.confirmedAgentSurfaceOperation(
      workspaceId, pending.operationId, pending.sessionId,
    );
    if (operation.status === "missing") {
      await sourceViews.clearUnstartedMutation(viewId, pending.operationId,
        await documents.inspectDirtyBuffers(workspaceId));
      return;
    }
    if (operation.status !== "confirmed") return;
    try {
      await sourceViews.finishMutation(viewId, pending.operationId, operation.result,
        await documents.inspectDirtyBuffers(workspaceId));
    } catch (error) {
      // A concurrent writer may have advanced the same record already. Its
      // confirmed result wins; only a still-pending operation is unresolved.
      if ((await sourceViews.pendingOperation(viewId, workspaceId, resourceId))?.operationId === pending.operationId) throw error;
    }
  };

  const readSource: NonNullable<HarnessServiceHost["documentReadSource"]> = async (
    sessionId, context, resourceId, workspaceId,
  ): Promise<HarnessDocumentReadLookup> => {
    const branch = await branchLookups.readSource(sessionId, resourceId, workspaceId);
    if (branch) return branch;
    const viewId = await viewForSession(sessionId, context);
    if (!viewId) return documents.readAgentInputSnapshot(sessionId, context, resourceId, workspaceId);
    const identity = await documents.resolveResourceIdentity({ workspaceId, resourceId }).catch(() => null);
    const alias = await sourceViews.targetAlias(viewId, workspaceId, resourceId, identity?.coordinationId ?? null);
    if (!alias) {
      await reconcilePending(viewId, workspaceId, resourceId);
      return sourceViews.read(viewId, workspaceId, resourceId, identity?.coordinationId ?? null);
    }
    const aliasedBranch = await branchLookups.readSource(sessionId, alias.resourceId, alias.workspaceId);
    if (aliasedBranch) return aliasedBranch;
    const view = views.get(sessionId);
    if (view?.mode !== "materialized" || view.workspaceId !== alias.workspaceId) {
      return { status: "unavailable", message: "The aliased source has no active child execution view" };
    }
    const childRoot = await materializedThreadRoot(sessionId);
    if (!childRoot) return { status: "unavailable", message: "The materialized child directory is unavailable" };
    const snapshot = await documents.read({ workspaceId: childRoot.workspaceId, resourceId: alias.resourceId });
    const provenance = { branchId: view.branchId, revision: view.writeRevision, origin: "materialized" as const };
    if (snapshot.status === "missing") return {
      status: "working-branch", revision: `materialized:${view.branchId}:missing`, provenance, missing: true,
    };
    if (snapshot.status !== "ready") return {
      status: "unavailable", message: `The materialized child source cannot be read (${snapshot.status})`,
    };
    return {
      status: "working-branch", revision: `materialized:${view.branchId}:${snapshot.revision}`,
      provenance, base64: encodeDocumentText(snapshot).toString("base64"),
    };
  };

  const readExploreSource = async (
    sessionId: string, context: AgentInputContext, resourceId: string, workspaceId: string,
  ): Promise<ExploreFileSnapshot | null> => {
    if (!sourceViewIdFromContext(context)) return null;
    const source = await readSource(sessionId, context, resourceId, workspaceId);
    if (source.status === "disk") return null;
    if (source.status === "unavailable") return source;
    if (source.status === "working-branch") {
      if (source.message || source.missing || source.base64 === undefined) {
        return { status: "unavailable", message: source.message ?? "The working-branch source is missing" };
      }
      return { status: "ready", content: Buffer.from(source.base64, "base64").toString("utf8"),
        revision: source.revision, source: "working-branch" };
    }
    return { status: "ready", content: source.content, revision: source.revision, source: source.source };
  };

  const pathOverlay: NonNullable<HarnessServiceHost["documentPathOverlay"]> = async (
    sessionId, context, resourceId, workspaceId,
  ) => {
    const branch = await branchLookups.pathOverlay(sessionId, resourceId, workspaceId);
    if (branch) return branch;
    const viewId = await viewForSession(sessionId, context);
    if (!viewId) return documents.overlayAgentInputSnapshot(sessionId, context, resourceId, workspaceId);
    const dirtyPaths = context.source === "surface"
      ? context.roots.find((root) => root.workspaceId === workspaceId)?.dirtyPaths ?? []
      : [];
    for (const path of dirtyPaths) {
      if (!resourceId || path === resourceId || path.startsWith(`${resourceId.replace(/\/$/, "")}/`)) {
        await reconcilePending(viewId, workspaceId, path);
      }
    }
    return sourceViews.overlay(viewId, workspaceId, resourceId, async (alias) => {
      const source = await readSource(sessionId, context, alias.resourceId, alias.workspaceId);
      if (source.status === "working-branch") {
        if (source.message) return { status: "unavailable", message: source.message };
        if (source.missing) return { status: "missing" };
        return { status: "ready", revision: source.revision };
      }
      if (source.status === "ready") return { status: "ready", revision: source.revision };
      return { status: "unavailable", message: source.status === "unavailable" ? source.message : "The aliased child source is unavailable" };
    });
  };

  const writeGuard: NonNullable<HarnessServiceHost["documentWriteGuard"]> = async (
    sessionId, context, resourceId, workspaceId,
  ) => {
    if (!sourceViewIdFromContext(context)) return documents.inspectAgentWriteTarget(sessionId, context, resourceId, workspaceId);
    const source = await readSource(sessionId, context, resourceId, workspaceId);
    return source.status === "unavailable" ? { status: "unavailable", message: source.message } : { status: "allow" };
  };

  const surfaceWrite: NonNullable<HarnessServiceHost["documentSurfaceWrite"]> = async (
    sessionId, workspaceId, context, changes, signal,
  ) => {
    const viewId = await viewForSession(sessionId, context);
    if (!viewId) return documents.applyAgentSurfaceWrite(sessionId, workspaceId, context, changes, signal);
    const aliases = await Promise.all(changes.map((change) => aliasFor(viewId, workspaceId, change.resourceId)));
    if (aliases.some(Boolean)) {
      if (aliases.some((alias) => !alias)) return {
        status: "unavailable", results: changes.map((change) => ({ path: change.resourceId, target: "disk", status: "unavailable",
          message: "This patch combines a child-branch alias with an independent external file. Apply them as separate resource changes." })),
      };
      if (views.get(sessionId)?.mode !== "materialized") return {
        status: "unavailable", results: changes.map((change) => ({ path: change.resourceId, target: "disk", status: "unavailable",
          message: "The child branch alias is not materialized for a disk write." })),
      };
      const childRoot = await materializedThreadRoot(sessionId);
      if (!childRoot) return {
        status: "unavailable", results: changes.map((change) => ({ path: change.resourceId, target: "disk", status: "unavailable",
          message: "The materialized child directory is unavailable." })),
      };
      const mapped = changes.map((change, index) => ({ ...change, resourceId: aliases[index]!.resourceId }));
      const result = await documents.applyAgentSurfaceWrite(sessionId, childRoot.workspaceId, { source: "disk" }, mapped, signal);
      return result.status === "disk" ? result : {
        ...result, results: result.results.map((entry, index) => ({ ...entry, path: changes[index]!.resourceId })),
      };
    }
    // Reads and writes must resolve the same canonical resource identity. A
    // retargeted path alias cannot inherit the draft captured for its old target.
    for (const change of changes) {
      const source = await readSource(sessionId, context, change.resourceId, workspaceId);
      if (source.status === "unavailable") return {
        status: "unavailable",
        results: changes.map((item) => ({ path: item.resourceId, target: "surface", status: "unavailable",
          message: source.message })),
      };
    }
    const prepared = await sourceViews.prepareMutation(viewId, sessionId, workspaceId, changes);
    if (!prepared) return documents.applyAgentSurfaceWrite(sessionId, workspaceId, context, changes, signal);
    const result = await documents.applyAgentSurfaceWrite(sessionId, workspaceId, context, changes, signal, prepared.fixedView);
    if (result.status === "disk" || result.operationId !== prepared.fixedView.operationId) return {
      status: "unavailable", results: changes.map((change) => ({ path: change.resourceId, target: "surface", status: "needs-attention",
        message: "The editor write outcome did not match its fixed source operation; do not repeat the write." })),
    };
    try {
      await sourceViews.finishMutation(viewId, prepared.fixedView.operationId, result,
        await documents.inspectDirtyBuffers(workspaceId));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "partial", operationId: prepared.fixedView.operationId,
        results: result.results.map((entry) => prepared.fixedPaths.includes(entry.path)
          ? { ...entry, status: "needs-attention" as const,
              message: `${entry.path} editor outcome was recorded, but its child source view could not advance: ${message}. Do not repeat this write.` }
          : entry),
      };
    }
  };

  const branchWrite: NonNullable<HarnessServiceHost["documentBranchWrite"]> = async (
    sessionId, changes, expectedRevision, signal,
  ) => {
    const context = await contextForSession(sessionId);
    const viewId = context && sourceViewIdFromContext(context);
    const mapped = viewId ? await Promise.all(changes.map(async (change) => {
      const alias = await aliasFor(viewId, change.workspaceId, change.resourceId);
      return alias ? { ...change, ...alias } : change;
    })) : changes;
    return branchWrites.branchWrite(sessionId, mapped, expectedRevision, signal);
  };

  const commitContext: NonNullable<HarnessServiceHost["commitAgentInputContext"]> = async (sessionId, context) => sourceViewIdFromContext(context)
    ? { committed: Boolean(await viewForSession(sessionId, context)) }
    : documents.commitAgentInputSnapshot(sessionId, context);
  const releaseContext: NonNullable<HarnessServiceHost["releaseAgentInputContext"]> = async (sessionId, context) => sourceViewIdFromContext(context)
    ? { released: Boolean(await viewForSession(sessionId, context)) }
    : documents.releaseAgentInputSnapshot(sessionId, context);

  return {
    contextForSession, readSource, readExploreSource, pathOverlay, writeGuard, surfaceWrite, branchWrite,
    commitContext, releaseContext,
  };
}
