import type { HarnessServiceMap, RelatedQueryResult } from "@varin/protocol";
import type { HarnessService } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { executeRelated } from "./related-tool.js";
import { looksLikePathObject } from "./explore-query.js";
import { intersectRetrievalScope, sessionDefaultRoot } from "./explore-service.js";

type RelatedParams = HarnessServiceMap["related.query"]["params"];

const unavailable = (anchor: string, message: string): RelatedQueryResult => ({
  text: message,
  status: "unavailable",
  anchor: { kind: looksLikePathObject(anchor) ? "path" : "name", value: anchor },
  roles: [],
  definitions: [],
  imports: { items: [], unresolved: [], incomplete: false },
  importers: { items: [], incomplete: false },
  connections: { items: [], incomplete: false },
  references: { status: "unavailable", items: [], incomplete: false },
  calls: { status: "unavailable", callers: [], callees: [], incomplete: false },
});

export function createRelatedQueryService(
  host: Pick<HarnessServiceHost, "graphRecall" | "relationCollector" | "outputStore">,
): HarnessService<"related.query"> {
  return {
    handle: async (params: RelatedParams, ctx) => {
      if (typeof params.anchor !== "string" || !params.anchor.trim()) {
        throw new HarnessServiceError("invalid-params", "Provide a path or symbol name.");
      }
      const requestedAnchor = params.anchor.trim();
      const pathAnchor = looksLikePathObject(requestedAnchor);
      if (pathAnchor && ctx.authorizedPaths.length !== 1) {
        throw new HarnessServiceError("forbidden", "The related path anchor was not authorized.");
      }
      const authorizedPath = pathAnchor ? ctx.authorizedPaths[0]! : undefined;
      const workspaceId = authorizedPath?.workspaceId ?? ctx.actor.workspaceId;
      const externalRoot = Boolean(authorizedPath && authorizedPath.workspaceId !== ctx.actor.workspaceId);
      const anchor = authorizedPath ? (authorizedPath.resourceId || ".") : requestedAnchor;
      const defaultRoots = externalRoot || sessionDefaultRoot(ctx.actor) === undefined
        ? undefined
        : [sessionDefaultRoot(ctx.actor)!];
      const requestedRoots = [
        ...(defaultRoots ?? []),
        ...(pathAnchor ? [anchor] : []),
      ];
      const scope = externalRoot
        ? { roots: [anchor], empty: false }
        : intersectRetrievalScope(requestedRoots.length > 0 ? requestedRoots : undefined, ctx.actor.workspaceScope);
      if (scope.empty) {
        throw new HarnessServiceError("forbidden", "Related scope does not overlap the actor's authorized workspace scope.");
      }
      if (!workspaceId || !host.graphRecall) {
        return unavailable(anchor, "related unavailable: no symbol graph for this workspace.");
      }
      ctx.signal.throwIfAborted();
      let graph: Awaited<ReturnType<NonNullable<typeof host.graphRecall>>> | null;
      try {
        graph = await host.graphRecall(ctx.sessionId, workspaceId);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ...unavailable(anchor, "related failed: the symbol catalog could not be read."),
          status: "failed",
        };
      }
      if (!graph) {
        return unavailable(
          anchor,
          "related unavailable: no symbol graph for this workspace.",
        );
      }
      const hasUnsavedFixedView = ctx.inputContext?.source === "surface"
        && ctx.inputContext.roots.some((root) => root.workspaceId === workspaceId && root.dirtyPaths.length > 0);
      if (graph.workspaceId !== workspaceId || !graph.directFactsCompatible || (hasUnsavedFixedView && !externalRoot)) {
        return unavailable(
          anchor,
          "related unavailable: stored graph positions belong to the owning workspace and are not pinned to this isolated execution view.",
        );
      }
      try {
        // The collector resolves around the queried anchor and persists what it
        // found; the stored reads inside executeRelated then see fresh rows
        // alongside previously collected ones (D-240). The actor's effective
        // workspace scope is applied to definition candidates, collector input,
        // LSP returned locations, targetPath, persisted graph rows, and the
        // final body — out-of-scope content is neither returned nor written
        // (D-240 rework).
        return await executeRelated(
          { anchor },
          graph.store,
          {
            workspaceId,
            storeOutput: text => host.outputStore.store(ctx.sessionId, text, "related").ref.handle,
            ...(host.relationCollector ? { collector: host.relationCollector } : {}),
            // RR4: query scope and operation dir are defaults, then the pinned
            // workspace scope intersects them before any graph reads.
            ...(scope.roots !== undefined ? { roots: scope.roots } : {}),
            signal: ctx.signal,
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ...unavailable(anchor, "related failed: the symbol graph could not answer."),
          status: "failed",
        };
      }
    },
  };
}
