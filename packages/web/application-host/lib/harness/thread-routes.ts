import type { Express, Request, RequestHandler, Response } from "express";
import type { ThreadConflictResolution } from "@varin/protocol";
import type { ThreadResultHistoryReleaseParams } from "@varin/application-client";
import type { ThreadRegistry } from "./thread-registry.js";
import { ThreadRuntimeError, type ThreadRuntime } from "./thread-runtime.js";
import { HarnessServiceError } from "./service-error.js";

export interface HarnessThreadRoutesOptions {
  registry: ThreadRegistry;
  runtime: Pick<ThreadRuntime, "createDiscussion" | "convertDiscussion" | "scopeForSession" | "previewIntegration" | "merge" | "undoIntegration" | "archiveUser" | "deleteUser" | "restoreUser" | "inspectSpace" | "reclaimUser" | "inspectResultHistory" | "releaseResultHistory">
    & Partial<Pick<ThreadRuntime, "rootScopeForSession">>;
  /**
   * Delivers a directed message through the same `thread.send` routing the Pi
   * tools use; the UI acts as the parent session, never a forged Thread peer.
   */
  sendToThread?: (input: {
    parentSessionId: string;
    threadId: string;
    message: string;
    kind?: "inform" | "request";
    context?: "continue" | "fresh";
    requestId?: string;
    replyTo?: string;
    capability?: string;
    resources?: Record<string, boolean>;
    model?: { providerId: string; modelId: string } | "inherit";
    wait?: number;
    signal: AbortSignal;
  }) => Promise<unknown>;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const threadIdOf = (request: Request): string => String(request.params.threadId ?? "").trim();

const requestAbort = (request: Request, response: Response): { signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Thread integration request was disconnected"));
  const close = () => { if (!response.writableEnded) abort(); };
  request.once("aborted", abort);
  response.once("close", close);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      response.off("close", close);
    },
  };
};

const parseIntegrationBody = (value: unknown): {
  resultRevision?: number;
  sourceOwner?: { ownerId: string; generation: number };
  expectedBindingFingerprint?: string;
  resolutions?: ThreadConflictResolution[];
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ThreadRuntimeError("invalid-request", "Integration request body is malformed");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["resultRevision", "sourceOwner", "expectedBindingFingerprint", "resolutions"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new ThreadRuntimeError("invalid-request", "Integration request contains unsupported fields");
  if (body.resultRevision !== undefined && (!Number.isSafeInteger(body.resultRevision) || Number(body.resultRevision) < 1)) {
    throw new ThreadRuntimeError("invalid-request", "resultRevision must be a positive integer");
  }
  let sourceOwner: { ownerId: string; generation: number } | undefined;
  if (body.sourceOwner !== undefined) {
    if (!body.sourceOwner || typeof body.sourceOwner !== "object" || Array.isArray(body.sourceOwner)) {
      throw new ThreadRuntimeError("invalid-request", "sourceOwner is malformed");
    }
    const candidate = body.sourceOwner as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== "ownerId" && key !== "generation")
      || typeof candidate.ownerId !== "string" || !candidate.ownerId
      || !Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 0) {
      throw new ThreadRuntimeError("invalid-request", "sourceOwner is malformed");
    }
    sourceOwner = { ownerId: candidate.ownerId, generation: Number(candidate.generation) };
  }
  if (body.expectedBindingFingerprint !== undefined
    && (typeof body.expectedBindingFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(body.expectedBindingFingerprint))) {
    throw new ThreadRuntimeError("invalid-request", "expectedBindingFingerprint is malformed");
  }
  let resolutions: ThreadConflictResolution[] | undefined;
  if (body.resolutions !== undefined) {
    if (!Array.isArray(body.resolutions)) throw new ThreadRuntimeError("invalid-request", "resolutions must be an array");
    const seen = new Set<string>();
    resolutions = body.resolutions.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ThreadRuntimeError("invalid-request", "Conflict resolution is malformed");
      const resolution = entry as Record<string, unknown>;
      const resolutionAllowed = new Set(["path", "choice", "text", "expectedParentRevision", "expectedLocalEditRevision"]);
      if (Object.keys(resolution).some((key) => !resolutionAllowed.has(key))
        || typeof resolution.path !== "string" || !resolution.path || seen.has(resolution.path)
        || !["parent", "child", "base", "text"].includes(String(resolution.choice))
        || typeof resolution.expectedParentRevision !== "string" || !resolution.expectedParentRevision
        || (resolution.expectedLocalEditRevision !== undefined
          && (!Number.isSafeInteger(resolution.expectedLocalEditRevision) || Number(resolution.expectedLocalEditRevision) < 0))
        || (resolution.choice === "text" && typeof resolution.text !== "string")
        || (resolution.choice !== "text" && resolution.text !== undefined)) {
        throw new ThreadRuntimeError("invalid-request", "Conflict resolution is malformed or stale-binding fields are missing");
      }
      seen.add(resolution.path);
      return resolution as unknown as ThreadConflictResolution;
    });
  }
  return {
    ...(body.resultRevision === undefined ? {} : { resultRevision: Number(body.resultRevision) }),
    ...(sourceOwner ? { sourceOwner } : {}),
    ...(typeof body.expectedBindingFingerprint === "string" ? { expectedBindingFingerprint: body.expectedBindingFingerprint } : {}),
    ...(resolutions ? { resolutions } : {}),
  };
};

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

const parseSendBody = (value: unknown): {
  message: string;
  kind?: "inform" | "request";
  context?: "continue" | "fresh";
  requestId?: string;
  replyTo?: string;
  capability?: string;
  resources?: Record<string, boolean>;
  model?: { providerId: string; modelId: string } | "inherit";
  wait?: number;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ThreadRuntimeError("invalid-request", "Send request body is malformed");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["message", "kind", "context", "requestId", "replyTo", "capability", "resources", "model", "wait"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new ThreadRuntimeError("invalid-request", "Send request contains unsupported fields");
  if (typeof body.message !== "string" || !body.message.trim()) throw new ThreadRuntimeError("invalid-request", "message is required");
  if (body.kind !== undefined && body.kind !== "inform" && body.kind !== "request") throw new ThreadRuntimeError("invalid-request", "kind must be inform or request");
  if (body.context !== undefined && body.context !== "continue" && body.context !== "fresh") throw new ThreadRuntimeError("invalid-request", "context must be continue or fresh");
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim())) throw new ThreadRuntimeError("invalid-request", "requestId must be a non-empty string");
  if (body.replyTo !== undefined && (typeof body.replyTo !== "string" || !body.replyTo.trim())) throw new ThreadRuntimeError("invalid-request", "replyTo must be a non-empty string");
  if (body.capability !== undefined && (typeof body.capability !== "string" || !body.capability.trim())) throw new ThreadRuntimeError("invalid-request", "capability must be a non-empty string");
  if (body.resources !== undefined && (typeof body.resources !== "object" || body.resources === null || Array.isArray(body.resources))) throw new ThreadRuntimeError("invalid-request", "resources must be an object");
  if (body.model !== undefined && body.model !== "inherit" && (typeof body.model !== "object" || body.model === null)) throw new ThreadRuntimeError("invalid-request", "model must be a selection object or \"inherit\"");
  if (body.wait !== undefined && (typeof body.wait !== "number" || !Number.isFinite(body.wait) || body.wait < 0)) throw new ThreadRuntimeError("invalid-request", "wait must be a non-negative number of seconds");
  return {
    message: body.message,
    ...(body.kind === undefined ? {} : { kind: body.kind as "inform" | "request" }),
    ...(body.context === undefined ? {} : { context: body.context as "continue" | "fresh" }),
    ...(body.requestId === undefined ? {} : { requestId: body.requestId as string }),
    ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo as string }),
    ...(body.capability === undefined ? {} : { capability: body.capability as string }),
    ...(body.resources === undefined ? {} : { resources: body.resources as Record<string, boolean> }),
    ...(body.model === undefined ? {} : { model: body.model as { providerId: string; modelId: string } | "inherit" }),
    ...(body.wait === undefined ? {} : { wait: body.wait as number }),
  };
};

const parseHistoryRelease = (value: unknown): ThreadResultHistoryReleaseParams => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadRuntimeError("invalid-request", "History release body is malformed");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "branchId" && key !== "resultRevisions")
    || typeof body.branchId !== "string" || !body.branchId.trim()
    || !Array.isArray(body.resultRevisions)
    || body.resultRevisions.some((revision) => !Number.isSafeInteger(revision) || Number(revision) < 1)) {
    throw new ThreadRuntimeError("invalid-request", "A branch identity and positive result revisions are required");
  }
  return { branchId: body.branchId, resultRevisions: body.resultRevisions as number[] };
};

export function registerHarnessThreadRoutes(
  app: Express,
  { registry, runtime, sendToThread, requireAuth = noAuth }: HarnessThreadRoutesOptions,
): void {
  const rootScopeForSession = (sessionId: string) => (
    runtime.rootScopeForSession?.(sessionId) ?? runtime.scopeForSession(sessionId)
  );
  const scopeForThread = async (sessionId: string, threadId: string) => {
    const liveScope = await runtime.scopeForSession(sessionId);
    if (typeof registry.getThreadById !== "function") return liveScope;
    const candidate = await registry.getThreadById(liveScope.scopeId, threadId);
    if (candidate && candidate.purpose !== "research-root"
      && candidate.parent.kind === liveScope.parent.kind && candidate.parent.id === liveScope.parent.id) {
      return liveScope;
    }
    const rootScope = await rootScopeForSession(sessionId);
    const target = await registry.getThreadById(rootScope.scopeId, threadId);
    if (!target || target.purpose === "research-root") {
      throw new HarnessServiceError("not-found", `Thread not found: ${threadId}`);
    }
    let parent = target.parent;
    while (parent.kind === "thread") {
      const ancestor = await registry.getThreadById(rootScope.scopeId, parent.id);
      if (!ancestor) break;
      if (ancestor.purpose === "research-root"
        && ancestor.parent.kind === "session" && ancestor.parent.id === sessionId) {
        return { ...rootScope, parent: target.parent };
      }
      parent = ancestor.parent;
    }
    throw new HarnessServiceError("denied", `Thread is outside the session's research tree: ${threadId}`);
  };

  app.get("/api/harness/sessions/:sessionId/threads", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const { scopeId, parent } = await rootScopeForSession(sessionId);
      const includeArchived = request.query.archived === "1" || request.query.archived === "true";
      const threads = (await registry.listThreads(scopeId, parent))
        .filter((thread) => thread.purpose !== "research-root")
        .filter((thread) => includeArchived || thread.lifecycle !== "archived");
      const projected = await Promise.all(threads.map(async (thread) => ({
        thread,
        activeRun: await registry.getActiveRun(scopeId, thread.id),
      })));
      const researchRootThread = (await registry.listThreads(scopeId, parent, true))
        .find((thread) => thread.purpose === "research-root") ?? null;
      const researchRoot = researchRootThread
        ? { thread: researchRootThread, activeRun: await registry.getActiveRun(scopeId, researchRootThread.id) }
        : null;
      const researchBranches = researchRootThread
        ? (await registry.listThreadSnapshots(scopeId, { kind: "thread", id: researchRootThread.id }))
          .filter(({ thread }) => includeArchived || thread.lifecycle !== "archived")
        : [];
      response.json({
        workspaceId: scopeId,
        parent,
        includeArchived,
        threads: projected,
        researchRoot,
        researchBranches,
      });
    } catch (error) {
      sendError(response, error, "Unable to read harness threads");
    }
  });

  app.post("/api/harness/sessions/:sessionId/threads", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const parentSessionId = sessionIdOf(request);
    const entryId = typeof request.body?.entryId === "string" ? request.body.entryId.trim() : "";
    const carryBlocks = request.body?.carryBlocks;
    if (!parentSessionId || !entryId || (carryBlocks !== undefined && typeof carryBlocks !== "boolean")) {
      response.status(400).json({ error: "sessionId, entryId, and an optional boolean carryBlocks are required" });
      return;
    }
    try {
      const created = await runtime.createDiscussion({
        parentSessionId,
        entryId,
        ...(carryBlocks === undefined ? {} : { carryBlocks }),
      });
      response.status(201).json(created);
    } catch (error) {
      sendError(response, error, "Unable to create discussion thread");
    }
  });

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/convert",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        response.json(await runtime.convertDiscussion({ parentSessionId, threadId }));
      } catch (error) {
        sendError(response, error, "Unable to convert discussion thread");
      }
    },
  );

  app.get(
    "/api/harness/sessions/:sessionId/threads/:threadId/integration",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        const cancellation = requestAbort(request, response);
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        const resultRevision = typeof request.query.resultRevision === "string"
          ? Number(request.query.resultRevision)
          : undefined;
        const extras = {
          ...(Number.isSafeInteger(resultRevision) && resultRevision! > 0 ? { resultRevision: resultRevision as number } : {}),
          signal: cancellation.signal,
        };
        const preview = await runtime.previewIntegration(scopeId, parent, threadId, extras);
        cancellation.dispose();
        response.json({
          workspaceId: scopeId,
          parent,
          preview,
          thread: await registry.getThread(scopeId, parent, threadId),
        });
      } catch (error) {
        sendError(response, error, "Unable to preview thread integration");
      }
    },
  );

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/integration",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        const cancellation = requestAbort(request, response);
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        const preview = await runtime.previewIntegration(scopeId, parent, threadId, {
          ...parseIntegrationBody(request.body),
          signal: cancellation.signal,
        });
        cancellation.dispose();
        response.json({
          workspaceId: scopeId,
          parent,
          preview,
          thread: await registry.getThread(scopeId, parent, threadId),
        });
      } catch (error) {
        sendError(response, error, "Unable to preview thread integration");
      }
    },
  );

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/merge",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        const cancellation = requestAbort(request, response);
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        const parsed = parseIntegrationBody(request.body);
        const result = await runtime.merge(
          scopeId,
          parent,
          threadId,
          parsed.resultRevision,
          undefined,
          { ...parsed, signal: cancellation.signal },
        );
        cancellation.dispose();
        response.json({
          workspaceId: scopeId,
          parent,
          result,
          thread: await registry.getThread(scopeId, parent, threadId),
        });
      } catch (error) {
        sendError(response, error, "Unable to merge thread result");
      }
    },
  );

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/integration/undo",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      const operationId = typeof request.body?.operationId === "string" ? request.body.operationId.trim() : "";
      if (!parentSessionId || !threadId || !operationId) {
        response.status(400).json({ error: "sessionId, threadId, and operationId are required" });
        return;
      }
      try {
        const cancellation = requestAbort(request, response);
        const parsed = parseIntegrationBody({ sourceOwner: request.body?.sourceOwner });
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        const result = await runtime.undoIntegration(scopeId, parent, threadId, {
          operationId,
          ...(parsed.sourceOwner ? { sourceOwner: parsed.sourceOwner } : {}),
          signal: cancellation.signal,
        });
        cancellation.dispose();
        response.json({
          workspaceId: scopeId,
          parent,
          result,
          thread: await registry.getThread(scopeId, parent, threadId),
        });
      } catch (error) {
        sendError(response, error, "Unable to undo thread integration");
      }
    },
  );

  app.get(
    "/api/harness/sessions/:sessionId/space",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const sessionId = sessionIdOf(request);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required" });
        return;
      }
      try {
      const { scopeId, parent } = await rootScopeForSession(sessionId);
        response.json(await runtime.inspectSpace(scopeId, parent));
      } catch (error) {
        sendError(response, error, "Unable to inspect thread space");
      }
    },
  );

  const mutateThreadSpace = (
    action: "archive" | "restore" | "reclaim",
  ): RequestHandler => async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const parentSessionId = sessionIdOf(request);
    const threadId = threadIdOf(request);
    if (!parentSessionId || !threadId) {
      response.status(400).json({ error: "sessionId and threadId are required" });
      return;
    }
    try {
      const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
      if (action === "archive") {
        const keepWorktree = request.body?.keepWorktree;
        response.json(await runtime.archiveUser(
          scopeId,
          parent,
          threadId,
          typeof keepWorktree === "boolean" ? keepWorktree : undefined,
        ));
        return;
      }
      if (action === "restore") {
        response.json(await runtime.restoreUser(scopeId, parent, threadId));
        return;
      }
      response.json(await runtime.reclaimUser(scopeId, parent, threadId));
    } catch (error) {
      sendError(response, error, `Unable to ${action} thread`);
    }
  };

  app.delete(
    "/api/harness/sessions/:sessionId/threads/:threadId",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        response.json(await runtime.deleteUser(scopeId, parent, threadId));
      } catch (error) {
        sendError(response, error, "Unable to delete thread");
      }
    },
  );

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/send",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      if (!sendToThread) {
        response.status(503).json({ error: "Thread messaging is not configured" });
        return;
      }
      try {
        const cancellation = requestAbort(request, response);
        const parsed = parseSendBody(request.body);
        const result = await sendToThread({
          parentSessionId,
          threadId,
          ...parsed,
          signal: cancellation.signal,
        });
        cancellation.dispose();
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        response.json({
          workspaceId: scopeId,
          parent,
          result,
          thread: await registry.getThread(scopeId, parent, threadId),
          activeRun: await registry.getActiveRun(scopeId, threadId),
        });
      } catch (error) {
        sendError(response, error, "Unable to deliver the thread message");
      }
    },
  );

  app.post("/api/harness/sessions/:sessionId/threads/:threadId/archive", requireAuth, mutateThreadSpace("archive"));
  app.post("/api/harness/sessions/:sessionId/threads/:threadId/restore", requireAuth, mutateThreadSpace("restore"));
  app.post("/api/harness/sessions/:sessionId/threads/:threadId/reclaim", requireAuth, mutateThreadSpace("reclaim"));
  app.get("/api/harness/sessions/:sessionId/threads/:threadId/history", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const { scopeId, parent } = await scopeForThread(sessionIdOf(request), threadIdOf(request));
      response.json(await runtime.inspectResultHistory(scopeId, parent, threadIdOf(request)));
    } catch (error) {
      sendError(response, error, "Unable to read thread result history");
    }
  });
  app.post("/api/harness/sessions/:sessionId/threads/:threadId/history/release", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const input = parseHistoryRelease(request.body);
      const { scopeId, parent } = await scopeForThread(sessionIdOf(request), threadIdOf(request));
      response.json(await runtime.releaseResultHistory(scopeId, parent, threadIdOf(request), input));
    } catch (error) {
      sendError(response, error, "Unable to release thread result history");
    }
  });
  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/keep-worktree",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId || typeof request.body?.keepWorktree !== "boolean") {
        response.status(400).json({ error: "sessionId, threadId, and boolean keepWorktree are required" });
        return;
      }
      try {
        const { scopeId, parent } = await scopeForThread(parentSessionId, threadId);
        const thread = await registry.setKeepWorktree(scopeId, threadId, request.body.keepWorktree);
        if (!thread) {
          response.status(404).json({ error: `Thread not found: ${threadId}` });
          return;
        }
        response.json({
          workspaceId: scopeId,
          parent,
          thread,
          activeRun: await registry.getActiveRun(scopeId, threadId),
          space: await runtime.inspectSpace(scopeId, parent),
        });
      } catch (error) {
        sendError(response, error, "Unable to update keep_worktree");
      }
    },
  );
}
