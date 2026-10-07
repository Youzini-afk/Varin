import type { Express, Request, RequestHandler, Response } from "express";
import type { FollowUpService } from "./followups.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import { ThreadRuntimeError } from "./thread-runtime.js";
import { HarnessServiceError } from "./service-error.js";
import type { ThreadRegistry } from "./thread-registry.js";
import { resolveResearchCaller } from "./research-access.js";
import type { FollowUpSource } from "@varin/protocol";

/**
 * UI-facing follow-up routes (W3, D-307): the session surface reads and steers
 * the same durable registrations the `follow_up` tool manages. Program-side
 * "check" evaluates the source; "fire" invokes the agent — the two are
 * deliberately separate endpoints.
 */
export interface HarnessFollowUpRoutesOptions {
  runtime: Pick<ThreadRuntime, "scopeForSession">;
  registry: Pick<ThreadRegistry, "getSessionBinding" | "resolveSessionOwner" | "getThreadById" | "listThreads">;
  followUps: FollowUpService;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const followUpIdOf = (request: Request): string => String(request.params.followUpId ?? "").trim();

const sendError = (response: Response, error: unknown, fallback: string): void => {
  if (error instanceof HarnessServiceError) {
    const status = error.harnessCode === "invalid-params" ? 400
      : error.harnessCode === "not-found" ? 404
        : error.harnessCode === "denied" || error.harnessCode === "forbidden" ? 403
          : error.harnessCode === "unavailable" || error.harnessCode === "timeout" || error.harnessCode === "expired" ? 503
            : 500;
    response.status(status).json({ code: error.harnessCode, error: error.message });
    return;
  }
  if (error instanceof ThreadRuntimeError) {
    const status = error.code === "invalid-request" ? 400
      : error.code === "not-found" ? 404
        : error.code === "conflict" ? 409
          : 503;
    response.status(status).json({ code: error.code, error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : fallback });
};

export function registerHarnessFollowUpRoutes(
  app: Express,
  { runtime, registry, followUps, requireAuth = noAuth }: HarnessFollowUpRoutesOptions,
): void {
  const callerFor = async (sessionId: string) => {
    const owner = await registry.resolveSessionOwner(sessionId);
    const scope = owner ? { scopeId: owner.owningScopeId } : await runtime.scopeForSession(sessionId);
    const caller = await resolveResearchCaller(registry, {
      workspaceId: scope.scopeId,
      executionWorkspaceId: scope.scopeId,
      sessionId,
      user: true,
    });
    return {
      workspaceId: caller.workspaceId,
      executionWorkspaceId: caller.executionWorkspaceId,
      sessionId: caller.sessionId ?? sessionId,
      ...(caller.threadId ? { threadId: caller.threadId } : {}),
      rootSessionId: caller.rootSessionId ?? sessionId,
      ...(caller.workspaceScope ? { workspaceScope: caller.workspaceScope } : {}),
      allowedThreadIds: caller.allowedThreadIds ?? [],
    };
  };

  // Same authenticated Host user who manages the session catalog. Actions below
  // remain session-scoped and re-resolve ownership; this endpoint is read-only.
  app.get("/api/harness/follow-ups", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await followUps.listForHost({ includeInactive: request.query.includeInactive === "true" }));
    } catch (error) {
      sendError(response, error, "Unable to list follow-ups");
    }
  });

  app.get("/api/harness/sessions/:sessionId/follow-ups", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const caller = await callerFor(sessionIdOf(request));
      response.json(await followUps.list(caller, {
        includeInactive: request.query.includeInactive === "true",
      }));
    } catch (error) {
      sendError(response, error, "Unable to list follow-ups");
    }
  });

  app.post("/api/harness/sessions/:sessionId/follow-ups", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (typeof request.body?.instruction !== "string" || !request.body.instruction.trim()) {
        throw new HarnessServiceError("invalid-params", "instruction must be a non-empty string");
      }
      if (request.body.pause !== undefined && typeof request.body.pause !== "boolean") {
        throw new HarnessServiceError("invalid-params", "pause must be a boolean");
      }
      response.status(201).json(await followUps.register(await callerFor(sessionIdOf(request)), {
        instruction: request.body.instruction.trim(),
        // The shared service validates the untrusted source and its resource scope.
        source: request.body.source as FollowUpSource,
        pause: request.body.pause === true,
      }));
    } catch (error) {
      sendError(response, error, "Unable to create follow-up");
    }
  });

  app.get("/api/harness/sessions/:sessionId/follow-ups/:followUpId", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await followUps.get(await callerFor(sessionIdOf(request)), { id: followUpIdOf(request) }));
    } catch (error) {
      sendError(response, error, "Unable to read follow-up");
    }
  });

  app.post("/api/harness/sessions/:sessionId/follow-ups/:followUpId/cancel", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await followUps.cancel(await callerFor(sessionIdOf(request)), {
        id: followUpIdOf(request),
        ...(typeof request.body?.expectedRevision === "string" ? { expectedRevision: request.body.expectedRevision } : {}),
      }));
    } catch (error) {
      sendError(response, error, "Unable to cancel follow-up");
    }
  });

  app.post("/api/harness/sessions/:sessionId/follow-ups/:followUpId/check", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await followUps.check(await callerFor(sessionIdOf(request)), { id: followUpIdOf(request) }));
    } catch (error) {
      sendError(response, error, "Unable to check follow-up");
    }
  });

  app.post("/api/harness/sessions/:sessionId/follow-ups/:followUpId/fire", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await followUps.fire(await callerFor(sessionIdOf(request)), {
        id: followUpIdOf(request),
        ...(typeof request.body?.reason === "string" && request.body.reason.trim()
          ? { reason: request.body.reason.trim() }
          : { reason: "invoked-from-ui" }),
        ...(typeof request.body?.expectedRevision === "string" ? { expectedRevision: request.body.expectedRevision } : {}),
      }));
    } catch (error) {
      sendError(response, error, "Unable to invoke follow-up");
    }
  });

  app.post("/api/harness/sessions/:sessionId/follow-ups/:followUpId/update", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const instruction = request.body?.instruction;
      if (instruction !== undefined && (typeof instruction !== "string" || !instruction.trim())) {
        throw new HarnessServiceError("invalid-params", "instruction must be a non-empty string");
      }
      response.json(await followUps.update(await callerFor(sessionIdOf(request)), {
        id: followUpIdOf(request),
        ...(typeof instruction === "string" ? { instruction: instruction.trim() } : {}),
        ...(request.body?.source === undefined ? {} : { source: request.body.source as FollowUpSource }),
        ...(typeof request.body?.expectedRevision === "string" ? { expectedRevision: request.body.expectedRevision } : {}),
      }));
    } catch (error) {
      sendError(response, error, "Unable to update follow-up");
    }
  });
}
