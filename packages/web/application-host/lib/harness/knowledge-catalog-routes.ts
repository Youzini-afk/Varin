import type { Express, Request, RequestHandler, Response } from "express";
import {
  KnowledgeMutationError,
  type Knowledge,
  type KnowledgeScope,
  type KnowledgeStatus,
  type KnowledgeStore,
} from "../knowledge/store.js";
import {
  acceptSuggestion,
  dismissSuggestion,
} from "./knowledge-suggestions.js";
import { botScopeId, isBotScopeId } from "./owner-scope.js";
import type { MemoryOrganizer } from "../memory/memory-organizer.js";

export interface KnowledgeCatalogRoutesOptions {
  resolveWorkspace(input: { workspaceId: string }): Promise<{ workspaceId: string }>;
  getWorkspaceStore(workspaceId: string): Promise<KnowledgeStore>;
  getUserStore(): Promise<KnowledgeStore>;
  onKnowledgeChanged?: (change: { scope: KnowledgeScope; workspaceId?: string }) => void;
  /** Background organizer — powers the progress surface and manual retry. */
  organizer?: Pick<MemoryOrganizer, "describe" | "noteScope">;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const scopeOf = (value: unknown): KnowledgeScope | null => (
  value === "workspace" || value === "user" || value === "bot" ? value : null
);
const idOf = (value: unknown): number | null => {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const statusOf = (value: unknown): KnowledgeStatus | null => (
  value === "suggested" || value === "accepted" || value === "dismissed" ? value : null
);

const sortCatalog = (items: Knowledge[]): Knowledge[] => items.toSorted((left, right) => {
  const leftRetired = left.invalidAt === undefined ? 0 : 1;
  const rightRetired = right.invalidAt === undefined ? 0 : 1;
  if (leftRetired !== rightRetired) return leftRetired - rightRetired;
  const leftRecalled = left.recalledAt ?? 0;
  const rightRecalled = right.recalledAt ?? 0;
  if (leftRecalled !== rightRecalled) return rightRecalled - leftRecalled;
  if (left.recallCount !== right.recallCount) return right.recallCount - left.recallCount;
  return right.createdAt - left.createdAt || right.id - left.id;
});

export function registerHarnessKnowledgeCatalogRoutes(
  app: Express,
  {
    resolveWorkspace,
    getWorkspaceStore,
    getUserStore,
    onKnowledgeChanged,
    organizer,
    requireAuth = noAuth,
  }: KnowledgeCatalogRoutesOptions,
): void {
  const sendKnowledgeError = (response: Response, error: unknown): void => {
    if (error instanceof KnowledgeMutationError) {
      response.status(error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400).json({ error: error.message, code: error.code });
      return;
    }
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    response.status(statusCode === 404 || statusCode === 400 ? statusCode : 500).json({
      error: error instanceof Error ? error.message : "Knowledge operation failed",
    });
  };
  const catalogStore = async (request: Request, scope: KnowledgeScope): Promise<{ store: KnowledgeStore; workspaceId?: string }> => {
    if (scope === "user") return { store: await getUserStore() };
    if (scope === "bot") {
      // A Bot's memory lives in its own `bot:<id>` store; `botId` selects it.
      // `workspaceId=bot:<id>` is also accepted for internal callers.
      const rawId = typeof request.query.botId === "string" ? request.query.botId.trim()
        : typeof request.body?.botId === "string" ? request.body.botId.trim()
          : "";
      const scopeId = isBotScopeId(request.query.workspaceId ?? request.body?.workspaceId)
        ? String(request.query.workspaceId ?? request.body?.workspaceId)
        : rawId ? botScopeId(rawId) : "";
      if (!scopeId) {
        const error = new Error("botId is required for bot knowledge");
        (error as { statusCode?: number }).statusCode = 400;
        throw error;
      }
      return { store: await getWorkspaceStore(scopeId), workspaceId: scopeId };
    }
    const workspaceId = typeof request.query.workspaceId === "string"
      ? request.query.workspaceId.trim()
      : typeof request.body?.workspaceId === "string"
        ? request.body.workspaceId.trim()
        : "";
    if (!workspaceId) {
      const error = new Error("workspaceId is required for workspace knowledge");
      (error as { statusCode?: number }).statusCode = 400;
      throw error;
    }
    const resolved = await resolveWorkspace({ workspaceId });
    return { store: await getWorkspaceStore(resolved.workspaceId), workspaceId: resolved.workspaceId };
  };

  /**
   * Organizer progress for a source scope (`workspace` or `bot`). Rows carry
   * pending/prepared/failed state with errors; `enabled`/`model` report
   * whether organizing can actually run so the UI can show "not configured"
   * instead of silently empty coverage.
   */
  const organizerScopeId = async (request: Request): Promise<string | null> => {
    const scope = scopeOf(request.query.scope ?? request.body?.scope);
    if (scope === "bot") {
      const rawId = typeof request.query.botId === "string" ? request.query.botId.trim()
        : typeof request.body?.botId === "string" ? request.body.botId.trim() : "";
      const candidate = isBotScopeId(request.query.workspaceId ?? request.body?.workspaceId)
        ? String(request.query.workspaceId ?? request.body?.workspaceId)
        : rawId ? botScopeId(rawId) : "";
      return candidate || null;
    }
    if (scope !== "workspace") return null;
    const workspaceId = typeof request.query.workspaceId === "string"
      ? request.query.workspaceId.trim()
      : typeof request.body?.workspaceId === "string" ? request.body.workspaceId.trim() : "";
    if (!workspaceId) return null;
    return (await resolveWorkspace({ workspaceId })).workspaceId;
  };

  app.get("/api/harness/knowledge/organizer", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!organizer) {
      response.status(503).json({ error: "Memory organizer is not configured" });
      return;
    }
    try {
      const scopeId = await organizerScopeId(request);
      if (!scopeId) {
        response.status(400).json({ error: "scope must be workspace or bot with workspaceId/botId" });
        return;
      }
      response.json({ scopeId, ...(await organizer.describe(scopeId)) });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.post("/api/harness/knowledge/organizer/retry", requireAuth, async (request: Request, response: Response) => {
    if (!organizer) {
      response.status(503).json({ error: "Memory organizer is not configured" });
      return;
    }
    try {
      const scopeId = await organizerScopeId(request);
      if (!scopeId) {
        response.status(400).json({ error: "scope must be workspace or bot with workspaceId/botId" });
        return;
      }
      organizer.noteScope(scopeId);
      response.json({ scopeId, scheduled: true });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.get("/api/harness/knowledge", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const scope = scopeOf(request.query.scope);
    if (!scope) {
      response.status(400).json({ error: "scope must be workspace, user, or bot" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      const items = sortCatalog(await store.listKnowledge({ scope }));
      response.json({ scope, ...(workspaceId ? { workspaceId } : {}), items });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.get("/api/harness/knowledge/:scope/:id", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    if (!scope || id === null) {
      response.status(400).json({ error: "scope and id are required" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      const item = await store.getKnowledge(id);
      if (!item || item.scope !== scope) {
        response.status(404).json({ error: "Knowledge not found" });
        return;
      }
      const chain = await store.getSupersedeChain(id, scope);
      response.json({ scope, ...(workspaceId ? { workspaceId } : {}), item, chain });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.get("/api/harness/knowledge/:scope/:id/chain", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    if (!scope || id === null) {
      response.status(400).json({ error: "scope and id are required" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      const chain = await store.getSupersedeChain(id, scope);
      if (!chain) {
        response.status(404).json({ error: "Knowledge not found" });
        return;
      }
      response.json({ scope, ...(workspaceId ? { workspaceId } : {}), chain });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.put("/api/harness/knowledge/:scope/:id", requireAuth, async (request: Request, response: Response) => {
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    const trigger = typeof request.body?.trigger === "string" ? request.body.trigger.trim() : "";
    const expectedContent = request.body?.expectedContent;
    const expectedTrigger = request.body?.expectedTrigger;
    const expectedStatus = statusOf(request.body?.expectedStatus);
    const expectedInvalidAt = request.body?.expectedInvalidAt;
    if (
      !scope
      || id === null
      || !content
      || typeof expectedContent !== "string"
      || typeof expectedTrigger !== "string"
      || !expectedStatus
      || (expectedInvalidAt !== null && typeof expectedInvalidAt !== "number")
    ) {
      response.status(400).json({ error: "scope, id, content, and the opened knowledge values are required" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      const current = await store.getKnowledge(id);
      if (!current || current.scope !== scope) {
        response.status(404).json({ error: "Knowledge not found" });
        return;
      }
      const expected = { content: expectedContent, trigger: expectedTrigger, status: expectedStatus, invalidAt: expectedInvalidAt };
      if (current.status === "suggested") {
        await store.updateSuggestedKnowledge(id, { content, trigger }, scope, expected);
      } else if (current.status === "accepted") {
        await store.updateAcceptedKnowledge(id, { content, trigger }, scope, expected);
      } else {
        response.status(409).json({ error: `Knowledge ${id} cannot be edited in its current status`, code: "conflict" });
        return;
      }
      onKnowledgeChanged?.({ scope, ...(workspaceId ? { workspaceId } : {}) });
      response.json({ updated: true, item: await store.getKnowledge(id) });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.delete("/api/harness/knowledge/:scope/:id", requireAuth, async (request: Request, response: Response) => {
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    const expectedContent = request.body?.expectedContent;
    const expectedTrigger = request.body?.expectedTrigger;
    const expectedStatus = statusOf(request.body?.expectedStatus);
    const expectedInvalidAt = request.body?.expectedInvalidAt;
    if (
      !scope
      || id === null
      || typeof expectedContent !== "string"
      || typeof expectedTrigger !== "string"
      || !expectedStatus
      || (expectedInvalidAt !== null && typeof expectedInvalidAt !== "number")
    ) {
      response.status(400).json({ error: "scope, id, and the opened knowledge revision are required" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      await store.retireKnowledge(id, scope, {
        content: expectedContent,
        trigger: expectedTrigger,
        status: expectedStatus,
        invalidAt: expectedInvalidAt,
      });
      onKnowledgeChanged?.({ scope, ...(workspaceId ? { workspaceId } : {}) });
      response.json({ retired: true, item: await store.getKnowledge(id) });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.post("/api/harness/knowledge/:scope/:id/:action", requireAuth, async (request: Request, response: Response) => {
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    const action = request.params.action;
    if (!scope || id === null || (action !== "accept" && action !== "dismiss")) {
      response.status(400).json({ error: "A valid scope, id, and action are required" });
      return;
    }
    const supersedes = Array.isArray(request.body?.supersedes)
      ? request.body.supersedes.map(idOf).filter((candidate: number | null): candidate is number => candidate !== null)
      : [];
    if (Array.isArray(request.body?.supersedes) && supersedes.length !== request.body.supersedes.length) {
      response.status(400).json({ error: "supersedes must contain positive integer ids" });
      return;
    }
    const editValues = [request.body?.content, request.body?.trigger, request.body?.expectedContent, request.body?.expectedTrigger];
    // Opened revision fields are required for every Settings action, but only
    // content/trigger indicate the optional accept-and-edit operation.
    const hasEdit = request.body?.content !== undefined || request.body?.trigger !== undefined;
    if (hasEdit && editValues.some((value) => typeof value !== "string")) {
      response.status(400).json({ error: "content, trigger, expectedContent, and expectedTrigger must be provided together" });
      return;
    }
    const expectedContent = request.body?.expectedContent;
    const expectedTrigger = request.body?.expectedTrigger;
    const expectedStatus = statusOf(request.body?.expectedStatus);
    const expectedInvalidAt = request.body?.expectedInvalidAt;
    if (
      typeof expectedContent !== "string"
      || typeof expectedTrigger !== "string"
      || !expectedStatus
      || (expectedInvalidAt !== null && typeof expectedInvalidAt !== "number")
    ) {
      response.status(400).json({ error: "opened content, trigger, status, and invalidAt are required" });
      return;
    }
    try {
      const { store, workspaceId } = await catalogStore(request, scope);
      const deps = { store };
      if (action === "accept") {
        await acceptSuggestion(id, deps, {
          supersedes,
          scope,
          expected: { content: expectedContent, trigger: expectedTrigger, status: expectedStatus, invalidAt: expectedInvalidAt },
          ...(hasEdit ? {
            edit: {
              content: String(request.body.content),
              trigger: String(request.body.trigger),
              expectedContent: String(request.body.expectedContent),
              expectedTrigger: String(request.body.expectedTrigger),
            },
          } : {}),
        });
      } else {
        await dismissSuggestion(id, deps, scope, {
          content: expectedContent,
          trigger: expectedTrigger,
          status: expectedStatus,
          invalidAt: expectedInvalidAt,
        });
      }
      onKnowledgeChanged?.({ scope, ...(workspaceId ? { workspaceId } : {}) });
      response.json({ action, completed: true, item: await store.getKnowledge(id) });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });
}
