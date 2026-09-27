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
  host: Pick<HarnessServiceHost, "graphRecall" | "relationCollector">,
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
      // HR2: a path anchor resolved to a resource root outside the actor
      // workspace cannot be re-read as a workspace-relative resource id.
      if (pathAnchor && ctx.authorizedPaths[0]!.workspaceId !== ctx.actor.workspaceId) {
        throw new HarnessServiceError(
          "unavailable",
          "Related symbol lookup is bound to the actor workspace's graph. Use content search for external resources.",
        );
      }
      const anchor = pathAnchor ? (ctx.authorizedPaths[0]!.resourceId || ".") : requestedAnchor;
      const defaultRoots = sessionDefaultRoot(ctx.actor) === undefined
        ? undefined
        : [sessionDefaultRoot(ctx.actor)!];
      const requestedRoots = [
        ...(defaultRoots ?? []),
        ...(pathAnchor ? [anchor] : []),
      ];
      const scope = intersectRetrievalScope(requestedRoots.length > 0 ? requestedRoots : undefined, ctx.actor.workspaceScope);
      if (scope.empty) {
        throw new HarnessServiceError("forbidden", "Related scope does not overlap the actor's authorized workspace scope.");
      }
      const workspaceId = ctx.actor.workspaceId;
      if (!workspaceId || !host.graphRecall) {
        return unavailable(anchor, "related unavailable: the symbol graph is not wired.");
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
          "related unavailable: the symbol graph is not open for this workspace. related does not open a database on the read path.",
        );
      }
      const hasUnsavedFixedView = ctx.inputContext?.source === "surface"
        && ctx.inputContext.dirtyPaths.length > 0;
      if (!graph.directFactsCompatible || hasUnsavedFixedView) {
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
