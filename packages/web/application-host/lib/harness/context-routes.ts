import type { Express, Request, RequestHandler, Response } from "express";
import {
  KnowledgeBlockConflictError,
  KnowledgeMutationError,
  type KnowledgeScope,
  type KnowledgeStore,
} from "../knowledge/store.js";
import {
  acceptSuggestion,
  dismissSuggestion,
  suggestSupersedes,
} from "./knowledge-suggestions.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { MemoryNature } from "@varin/protocol";
export interface HarnessContextRoutesOptions {
  getStore(sessionId: string): Promise<KnowledgeStore | null>;
  getBranchEntryIds(sessionId: string): Promise<string[]>;
  getUserStore?: () => Promise<KnowledgeStore>;
  /** BC1: unified memory writer for direct user remember actions. */
  memoryService?: MemoryService;
  memoryOwnerForSession?: (sessionId: string) => Promise<import("../memory/memory-service.js").MemoryOwner>;
  onKnowledgeChanged?: (sessionId: string, scope: KnowledgeScope) => void;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();

const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const labelOf = (request: Request): string => String(request.params.label ?? "").trim();
const scopeOf = (value: unknown): KnowledgeScope | null => value === "workspace" || value === "user" ? value : null;
const statusOf = (value: unknown) => value === "suggested" || value === "accepted" || value === "dismissed" ? value : null;
const idOf = (value: unknown): number | null => {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export function registerHarnessContextRoutes(
  app: Express,
  {
    getStore,
    getBranchEntryIds,
    getUserStore,
    memoryService,
    memoryOwnerForSession,
    onKnowledgeChanged,
    requireAuth = noAuth,
  }: HarnessContextRoutesOptions,
): void {
  const suggestionStore = async (sessionId: string, scope: KnowledgeScope): Promise<KnowledgeStore | null> => {
    const workspaceStore = await getStore(sessionId);
    if (!workspaceStore) return null;
    return scope === "user" ? await getUserStore?.() ?? null : workspaceStore;
  };
  const sendKnowledgeError = (response: Response, error: unknown): void => {
    if (error instanceof KnowledgeMutationError) {
      response.status(error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400).json({ error: error.message, code: error.code });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "Knowledge operation failed" });
  };
  app.get("/api/harness/sessions/:sessionId/blocks", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const store = await getStore(sessionId);
      if (!store) {
        response.status(404).json({ error: "Session knowledge store is unavailable" });
        return;
      }
      const branchEntryIds = await getBranchEntryIds(sessionId);
      response.json({
        sessionId,
        branchLeafId: branchEntryIds[branchEntryIds.length - 1] ?? null,
        blocks: await store.getBlocks(sessionId, branchEntryIds),
      });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Unable to read session blocks" });
    }
  });

  app.put("/api/harness/sessions/:sessionId/blocks/:label", requireAuth, async (request: Request, response: Response) => {
    const sessionId = sessionIdOf(request);
    const label = labelOf(request);
    const content = request.body?.content;
    const expectedUpdatedAt = request.body?.expectedUpdatedAt;
    const expectedBranchLeafId = request.body?.expectedBranchLeafId;
    if (
      !sessionId
      || !label
      || typeof content !== "string"
      || (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "number")
      || (typeof expectedUpdatedAt === "number" && !Number.isFinite(expectedUpdatedAt))
      || (expectedBranchLeafId !== null && typeof expectedBranchLeafId !== "string")
    ) {
      response.status(400).json({ error: "sessionId, label, content, expectedUpdatedAt, and expectedBranchLeafId are required" });
      return;
    }
    try {
      const store = await getStore(sessionId);
      if (!store) {
        response.status(404).json({ error: "Session knowledge store is unavailable" });
        return;
      }
      const branchEntryIds = await getBranchEntryIds(sessionId);
      const branchLeafId = branchEntryIds[branchEntryIds.length - 1] ?? null;
      if (branchLeafId !== expectedBranchLeafId) {
        response.status(409).json({ error: "Session branch changed while the block was being edited", code: "branch-conflict" });
        return;
      }
      const block = await store.upsertBlock({
        sessionId,
        label,
        content,
        updatedBy: "user",
        expectedUpdatedAt,
        branchEntryIds,
        sourceLeafId: branchLeafId,
      });
      response.json({
        sessionId,
        block,
      });
    } catch (error) {
      if (error instanceof KnowledgeBlockConflictError) {
        response.status(409).json({ error: error.message, current: error.current });
        return;
      }
      const message = error instanceof Error ? error.message : "Unable to update session block";
      response.status(message.startsWith("Invalid block name:") ? 400 : 500).json({ error: message });
    }
  });

  app.get("/api/harness/sessions/:sessionId/knowledge/suggestions", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const workspaceStore = await getStore(sessionId);
      if (!workspaceStore) {
        response.status(404).json({ error: "Session knowledge store is unavailable" });
        return;
      }
      const userStore = getUserStore ? await getUserStore() : null;
      const stores = [
        { scope: "workspace" as const, store: workspaceStore },
        ...(userStore ? [{ scope: "user" as const, store: userStore }] : []),
      ];
      const suggestions = (await Promise.all(stores.map(async ({ scope, store }) => {
        const [pending, accepted] = await Promise.all([
          store.listKnowledge({ scope, status: "suggested", activeOnly: true }),
          store.listKnowledge({ scope, status: "accepted", activeOnly: true }),
        ]);
        return Promise.all(pending.map(async (suggestion) => {
          const candidateIds = await suggestSupersedes(suggestion.id, suggestion.trigger, { store }, scope);
          return {
            ...suggestion,
            supersedesCandidates: accepted.filter((candidate) => candidateIds.includes(candidate.id)),
          };
        }));
      }))).flat().sort((left, right) => right.createdAt - left.createdAt);
      response.json({ sessionId, suggestions });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  // BC1: an explicit user "remember this" commits immediately through the
  // unified memory service — no per-row review gate. `scope` selects the
  // user store; omitting it writes the session's owning scope (Bot memory for
  // Bot-owned entry chats, workspace memory for bound sessions).
  app.post("/api/harness/sessions/:sessionId/knowledge/remember", requireAuth, async (request: Request, response: Response) => {
    const sessionId = sessionIdOf(request);
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    const trigger = typeof request.body?.trigger === "string" ? request.body.trigger.trim() : "";
    const nature = typeof request.body?.nature === "string" ? request.body.nature : undefined;
    const scope = request.body?.scope === "user" ? "user" as const : null;
    const kind = typeof request.body?.kind === "string" && request.body.kind.trim()
      ? request.body.kind.trim() : "user-mark";
    if (!sessionId || !content || !memoryService || !memoryOwnerForSession) {
      response.status(!memoryService ? 503 : 400).json({ error: "sessionId, content, and the memory service are required" });
      return;
    }
    try {
      const owner = scope === "user"
        ? { scope: "user" as const, ownerId: null }
        : await memoryOwnerForSession(sessionId);
      const result = await memoryService.remember(owner, {
        content,
        ...(trigger ? { trigger } : {}),
        ...(nature === "experience" || nature === "decision" || nature === "preference" || nature === "judgment" || nature === "instruction"
          ? { nature: nature as MemoryNature } : {}),
        source: { kind, sessionId },
        ...(typeof request.body?.sourceText === "string" ? { sourceText: request.body.sourceText } : {}),
        ...(typeof request.body?.sourceEntryId === "string" ? { sourceEntryId: request.body.sourceEntryId } : {}),
      });
      onKnowledgeChanged?.(sessionId, owner.scope);
      response.status(result.created ? 201 : 200).json({
        sessionId,
        created: result.created,
        duplicate: result.duplicate,
        item: result.item,
      });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });



  app.put("/api/harness/sessions/:sessionId/knowledge/suggestions/:scope/:id", requireAuth, async (request: Request, response: Response) => {
    const sessionId = sessionIdOf(request);
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    const trigger = typeof request.body?.trigger === "string" ? request.body.trigger.trim() : "";
    const expectedContent = request.body?.expectedContent;
    const expectedTrigger = request.body?.expectedTrigger;
    const expectedStatus = statusOf(request.body?.expectedStatus);
    const expectedInvalidAt = request.body?.expectedInvalidAt;
    if (!sessionId || !scope || id === null || !content || typeof expectedContent !== "string" || typeof expectedTrigger !== "string"
      || !expectedStatus || (expectedInvalidAt !== null && typeof expectedInvalidAt !== "number")) {
      response.status(400).json({ error: "sessionId, scope, id, content, and the complete opened suggestion revision are required" });
      return;
    }
    try {
      const store = await suggestionStore(sessionId, scope);
      if (!store) {
        response.status(404).json({ error: `${scope} knowledge store is unavailable` });
        return;
      }
      await store.updateSuggestedKnowledge(id, { content, trigger }, scope, {
        content: expectedContent,
        trigger: expectedTrigger,
        status: expectedStatus,
        invalidAt: expectedInvalidAt,
      });
      onKnowledgeChanged?.(sessionId, scope);
      response.json({ updated: true });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });

  app.post("/api/harness/sessions/:sessionId/knowledge/suggestions/:scope/:id/:action", requireAuth, async (request: Request, response: Response) => {
    const sessionId = sessionIdOf(request);
    const scope = scopeOf(request.params.scope);
    const id = idOf(request.params.id);
    const action = request.params.action;
    if (!sessionId || !scope || id === null || (action !== "accept" && action !== "dismiss")) {
      response.status(400).json({ error: "A valid sessionId, scope, id, and action are required" });
      return;
    }
    const supersedes = Array.isArray(request.body?.supersedes)
      ? request.body.supersedes.map(idOf).filter((candidate: number | null): candidate is number => candidate !== null)
      : [];
    if (Array.isArray(request.body?.supersedes) && supersedes.length !== request.body.supersedes.length) {
      response.status(400).json({ error: "supersedes must contain positive integer ids" });
      return;
    }
    const hasEdit = request.body?.content !== undefined || request.body?.trigger !== undefined;
    if (hasEdit && (typeof request.body?.content !== "string" || typeof request.body?.trigger !== "string")) {
      response.status(400).json({ error: "content and trigger must be provided together" });
      return;
    }
    const expectedContent = request.body?.expectedContent;
    const expectedTrigger = request.body?.expectedTrigger;
    const expectedStatus = statusOf(request.body?.expectedStatus);
    const expectedInvalidAt = request.body?.expectedInvalidAt;
    if (typeof expectedContent !== "string" || typeof expectedTrigger !== "string" || !expectedStatus
      || (expectedInvalidAt !== null && typeof expectedInvalidAt !== "number")) {
      response.status(400).json({ error: "The complete opened suggestion revision is required" });
      return;
    }
    try {
      const store = await suggestionStore(sessionId, scope);
      if (!store) {
        response.status(404).json({ error: `${scope} knowledge store is unavailable` });
        return;
      }
      const deps = { store };
      if (action === "accept") await acceptSuggestion(id, deps, {
        supersedes,
        scope,
        expected: {
          content: expectedContent,
          trigger: expectedTrigger,
          status: expectedStatus,
          invalidAt: expectedInvalidAt,
        },
        ...(hasEdit ? { edit: {
          content: String(request.body.content),
          trigger: String(request.body.trigger),
          expectedContent,
          expectedTrigger,
          expectedStatus,
          expectedInvalidAt,
        } } : {}),
      });
      else await dismissSuggestion(id, deps, scope, {
        content: expectedContent,
        trigger: expectedTrigger,
        status: expectedStatus,
        invalidAt: expectedInvalidAt,
      });
      onKnowledgeChanged?.(sessionId, scope);
      response.json({ action, completed: true });
    } catch (error) {
      sendKnowledgeError(response, error);
    }
  });
}
