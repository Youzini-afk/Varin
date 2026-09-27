import type { HarnessServiceHost } from "./service-host.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import type { PdfMaterialRouteOptions } from "./pdf-material-routes.js";
import type { HarnessPathAuthority } from "./path-authority.js";
import type { HarnessActorContext } from "@varin/protocol";
import { createMaterialReadService } from "./material-read-service.js";
import { isSessionScopeId } from "./owner-scope.js";

/** Authenticated UI requests resolve a path through the Host's resource authority. */
export function createUserMaterialReadAdapter(
  getHost: () => HarnessServiceHost,
  runtime: Pick<ThreadRuntime, "scopeForSession">,
  paths: Pick<HarnessPathAuthority, "resolve">,
): PdfMaterialRouteOptions["readDocument"] {
  return async ({ sessionId, request, signal }) => {
    const scope = await runtime.scopeForSession(sessionId);
    const workspace = scope.snapshot?.workspace;
    const sessionOwned = isSessionScopeId(scope.scopeId);
    const executionWorkspaceId = workspace?.kind === "workspace" ? workspace.authorityId ?? workspace.id : scope.scopeId;
    const actor: HarnessActorContext = {
      authorityInstanceId: "ui-material-reader",
      sessionId,
      workerId: "ui-material-reader",
      workerGeneration: 0,
      // A session-owned chat has no workspace identity; relative paths anchor
      // to its launch directory via `authorityRoot` instead.
      workspaceId: sessionOwned ? null : executionWorkspaceId,
      ...(sessionOwned && scope.snapshot?.cwd ? { authorityRoot: scope.snapshot.cwd } : {}),
      grantedCapabilities: [],
    };
    const authorizedPaths = [];
    if (request.path !== undefined) {
      if (typeof request.path !== "string" || !request.path.trim()) {
        return { status: "failed", url: "", reason: "A non-empty document path is required" };
      }
      const authorized = await paths.resolve(actor, request.path, { allowMissing: true });
      if (!authorized) return { status: "failed", url: "", reason: "Document path is unavailable or not permitted" };
      authorizedPaths.push(authorized);
    }
    return createMaterialReadService(getHost()).handle(request, {
      actor,
      requestSource: "user",
      sessionId,
      workspaceId: executionWorkspaceId,
      authorizedPaths,
      signal,
    });
  };
}
