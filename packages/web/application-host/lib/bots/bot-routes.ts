import type { Express, Request, RequestHandler, Response } from "express";
import { HarnessServiceError } from "../harness/service-error.js";
import type { BotModelSelection, BotService } from "./bot-service.js";
import type { ComputerService } from "../computer/computer-service.js";
import { botScopeId } from "../harness/owner-scope.js";
import { createHash } from "node:crypto";
import type { MemoryService } from "../memory/memory-service.js";
import type { Knowledge } from "../knowledge/store.js";

/**
 * Bot routes (BC0): the durable Bot catalog plus entry/work resolution. These
 * are Host-level surfaces — not session-scoped — because a Bot's identity and
 * work association intentionally outlive any one session or workspace.
 */
export interface BotRoutesOptions {
  bots: BotService;
  computers?: Pick<ComputerService, "workDesktops" | "listArtifacts">;
  memory?: MemoryService;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const botIdOf = (request: Request): string => String(request.params.botId ?? "").trim();

const parseModel = (value: unknown): BotModelSelection | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value === "object" && value !== null
    && typeof (value as { providerId?: unknown }).providerId === "string"
    && typeof (value as { modelId?: unknown }).modelId === "string"
  ) {
    return {
      providerId: (value as { providerId: string }).providerId,
      modelId: (value as { modelId: string }).modelId,
    };
  }
  throw new HarnessServiceError("invalid-params", "model must be {providerId, modelId} or null");
};

const sendError = (response: Response, error: unknown, fallback: string): void => {
  if (error instanceof HarnessServiceError) {
    const status = error.harnessCode === "invalid-params" ? 400
      : error.harnessCode === "not-found" ? 404
        : 500;
    response.status(status).json({ code: error.harnessCode, error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : fallback });
};

export function registerBotRoutes(app: Express, { bots, computers, memory, requireAuth = noAuth }: BotRoutesOptions): void {
  app.get("/api/harness/bots", requireAuth, async (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ bots: await bots.list() });
    } catch (error) {
      sendError(response, error, "Unable to list bots");
    }
  });

  app.get("/api/harness/bots/session-ids", requireAuth, async (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ sessionIds: await bots.listSessionIds() });
    } catch (error) {
      sendError(response, error, "Unable to list Bot conversations");
    }
  });

  app.post("/api/harness/bots", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const name = request.body?.name;
      if (name !== undefined && typeof name !== "string") {
        throw new HarnessServiceError("invalid-params", "name must be a string");
      }
      const instructions = request.body?.instructions;
      if (instructions !== undefined && typeof instructions !== "string") {
        throw new HarnessServiceError("invalid-params", "instructions must be a string");
      }
      const model = parseModel(request.body?.model);
      response.status(201).json({ bot: await bots.create({
        ...(typeof name === "string" ? { name } : {}),
        ...(typeof instructions === "string" ? { instructions } : {}),
        ...(model !== undefined && model !== null ? { model } : {}),
      }) });
    } catch (error) {
      sendError(response, error, "Unable to create bot");
    }
  });

  app.get("/api/harness/bots/:botId", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const bot = await bots.get(botIdOf(request));
      if (!bot) throw new HarnessServiceError("not-found", "Unknown bot");
      response.json({ bot });
    } catch (error) {
      sendError(response, error, "Unable to read bot");
    }
  });

  app.post("/api/harness/bots/:botId/update", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const body = request.body ?? {};
      if (body.name !== undefined && typeof body.name !== "string") throw new HarnessServiceError("invalid-params", "name must be a string");
      if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") throw new HarnessServiceError("invalid-params", "instructions must be a string or null");
      if (body.pinned !== undefined && typeof body.pinned !== "boolean") throw new HarnessServiceError("invalid-params", "pinned must be a boolean");
      const bot = await bots.update(botIdOf(request), {
        ...(body.pinned === undefined ? {} : { pinned: body.pinned as boolean }),
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions as string | null } : {}),
        ...(body.model !== undefined ? { model: parseModel(body.model) ?? null } : {}),
      });
      if (!bot) throw new HarnessServiceError("not-found", "Unknown or archived bot");
      response.json({ bot });
    } catch (error) {
      sendError(response, error, "Unable to update bot");
    }
  });

  app.post("/api/harness/bots/:botId/archive", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const bot = await bots.archive(botIdOf(request));
      if (!bot) throw new HarnessServiceError("not-found", "Unknown bot");
      response.json({ bot });
    } catch (error) {
      sendError(response, error, "Unable to archive bot");
    }
  });

  for (const action of ["sleep", "wake", "restore", "retry"] as const) {
    app.post(`/api/harness/bots/:botId/${action}`, requireAuth, async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const bot = await bots[action](botIdOf(request));
        if (!bot) throw new HarnessServiceError("not-found", "Unknown Bot");
        response.json({ bot });
      } catch (error) { sendError(response, error, `Unable to ${action} Bot`); }
    });
  }

  const memoryOwner = async (request: Request) => {
    const bot = await bots.get(botIdOf(request));
    if (!bot) throw new HarnessServiceError("not-found", "Unknown Bot");
    if (!memory) throw new HarnessServiceError("unavailable", "Bot memory service is unavailable");
    return { scope: "bot" as const, ownerId: bot.id };
  };
  const memoryRevision = (item: Knowledge) => createHash("sha256").update(JSON.stringify([
    item.content, item.trigger, item.status, item.invalidAt ?? null,
  ])).digest("hex");
  const memoryId = (request: Request) => {
    const id = Number(request.params.memoryId);
    if (!Number.isSafeInteger(id) || id < 0) throw new HarnessServiceError("invalid-params", "Invalid memory id");
    return id;
  };
  app.get("/api/harness/bots/:botId/memory", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const owner = await memoryOwner(request);
      const items = await memory!.list(owner, { activeOnly: true });
      response.json({ items: items.map((item) => ({ id: item.id, content: item.content, trigger: item.trigger,
        createdAt: item.createdAt, sourceKind: item.source?.kind ?? null, revision: memoryRevision(item) })) });
    } catch (error) { sendError(response, error, "Unable to read Bot memory"); }
  });
  app.get("/api/harness/bots/:botId/memory/:memoryId/source", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const owner = await memoryOwner(request);
      response.json({ sources: await memory!.readSource(owner, memoryId(request)) });
    }
    catch (error) { sendError(response, error, "Unable to read memory sources"); }
  });
  app.post("/api/harness/bots/:botId/memory/:memoryId", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const owner = await memoryOwner(request);
      const id = memoryId(request);
      const { item } = await memory!.get(owner, id);
      if (request.body?.revision !== memoryRevision(item)) {
        response.status(409).json({ error: "This memory changed. Refresh before editing it." });
        return;
      }
      const expected = { content: item.content, trigger: item.trigger, status: item.status, invalidAt: item.invalidAt ?? null };
      if (request.body?.action === "forget") await memory!.forget(owner, id, expected);
      else if (request.body?.action === "correct" && typeof request.body.content === "string" && request.body.content.trim()) {
        await memory!.correct(owner, id, { content: request.body.content.trim(), trigger: item.trigger,
          ...(item.nature ? { nature: item.nature } : {}), source: { kind: "user-correction" }, expected });
      } else throw new HarnessServiceError("invalid-params", "Expected forget or a non-empty correction");
      response.json({ ok: true });
    } catch (error) { sendError(response, error, "Unable to update Bot memory"); }
  });

  /**
   * Resolve (or create) the Bot's durable entry session. The UI navigates to
   * the returned sessionId like any other conversation; reopening the entry
   * re-attaches to the same bot-root Thread and work scope.
   */
  app.post("/api/harness/bots/:botId/entry", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await bots.ensureEntry(botIdOf(request)));
    } catch (error) {
      sendError(response, error, "Unable to open bot entry");
    }
  });

  /** The Bot's associated work: threads owned by its owner scope. */
  app.get("/api/harness/bots/:botId/work", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const bot = await bots.get(botIdOf(request));
      if (!bot) throw new HarnessServiceError("not-found", "Unknown bot");
      const work = await bots.listWork(bot.id, true);
      const scopeId = botScopeId(bot.id);
      const [desktops, artifacts] = computers ? await Promise.all([
        computers.workDesktops(scopeId), computers.listArtifacts(scopeId),
      ]) : [[], []];
      response.json({ threads: work.map((item) => ({ ...item,
        desktops: desktops.filter((desktop) => desktop.work?.some((association) => association.threadId === item.thread.id)),
        artifacts: artifacts.filter((artifact) => artifact.threadId === item.thread.id) }))
        .filter((item) => item.thread.purpose !== 'bot-root' || item.desktops.length > 0 || item.artifacts.length > 0) });
    } catch (error) {
      sendError(response, error, "Unable to list bot work");
    }
  });

  /** Which Bot (if any) owns this session as its entry conversation. */
  app.get("/api/harness/sessions/:sessionId/bot", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const bot = await bots.botForSession(String(request.params.sessionId ?? ""));
      response.json({ bot });
    } catch (error) {
      sendError(response, error, "Unable to resolve session bot");
    }
  });
}
