import type { Express, Request, RequestHandler, Response } from "express";
import { HarnessServiceError } from "../harness/service-error.js";
import type { BotModelSelection, BotService } from "./bot-service.js";
import type { ComputerService } from "../computer/computer-service.js";
import { botScopeId } from "../harness/owner-scope.js";
import { createHash } from "node:crypto";
import type { MemoryService } from "../memory/memory-service.js";
import { KnowledgeMutationError, type Knowledge } from "../knowledge/store.js";
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { projectBotPresence } from './bot-presence.js';
import type { MemoryOrganizer } from '../memory/memory-organizer.js';

/**
 * Bot routes (BC0): the durable Bot catalog plus entry/work resolution. These
 * are Host-level surfaces — not session-scoped — because a Bot's identity and
 * work association intentionally outlive any one session or workspace.
 */
export interface BotRoutesOptions {
  bots: BotService;
  computers?: Pick<ComputerService, "workDesktops" | "listArtifacts">;
  memory?: MemoryService;
  organizer?: Pick<MemoryOrganizer, 'maintain' | 'maintenanceStatus' | 'cancelMaintenance'>;
  work?: Pick<AgentRuntimeClient, 'botMatters' | 'updateBotMatter' | 'botScope' | 'botActivity'>;
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
  if (error instanceof KnowledgeMutationError) {
    response.status(error.code === 'conflict' ? 409 : error.code === 'not-found' ? 404 : 400).json({ code: error.code, error: error.message });
    return;
  }
  if (error instanceof HarnessServiceError) {
    const status = error.harnessCode === "invalid-params" ? 400
      : error.harnessCode === "not-found" ? 404
        : 500;
    response.status(status).json({ code: error.harnessCode, error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : fallback });
};

export function registerBotRoutes(app: Express, { bots, computers, memory, organizer, work, requireAuth = noAuth }: BotRoutesOptions): void {
  app.post('/api/harness/bots/primary', requireAuth, async (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try { response.json({ bot: await bots.primary() }); }
    catch (error) { sendError(response, error, 'Unable to open the assistant'); }
  });
  app.get("/api/harness/bots", requireAuth, async (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ bots: await bots.list() });
    } catch (error) {
      sendError(response, error, "Unable to list bots");
    }
  });
  app.get('/api/harness/bots/:botId/matters', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (!work || !await bots.get(botIdOf(request))) throw new HarnessServiceError('not-found', 'Bot work is unavailable');
      response.json({ matters: await work.botMatters(botIdOf(request)) });
    } catch (error) { sendError(response, error, 'Unable to read followed work'); }
  });
  const runtimeOf = async (request: Request) => {
    const bot = await bots.get(botIdOf(request));
    if (!bot) throw new HarnessServiceError('not-found', 'Unknown Bot');
    if (!work) throw new HarnessServiceError('unavailable', 'The Bot runtime is unavailable');
    return { bot, work };
  };
  /** Dispatches, reports, the user's changes, quiet rounds and schedules across every Bot conversation. */
  app.get('/api/harness/bots/:botId/activity', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const count = (name: 'before' | 'limit') => {
        const value = request.query[name];
        if (value === undefined) return undefined;
        const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(parsed) || (name === 'limit' && parsed === 0)) throw new HarnessServiceError('invalid-params', `${name} must be a ${name === 'limit' ? 'positive' : 'non-negative'} integer`);
        return parsed;
      };
      const before = count('before'); const limit = count('limit');
      const { bot, work: runtime } = await runtimeOf(request);
      response.json(await runtime.botActivity({ botId: bot.id, ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }));
    } catch (error) { sendError(response, error, 'Unable to read Bot activity'); }
  });
  /** Who waits for the user, which work runs and which conversation replies. Pushed as `varin:bot-presence`. */
  app.get('/api/harness/bots/:botId/presence', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { bot, work: runtime } = await runtimeOf(request);
      response.json({ presence: projectBotPresence(bot, await runtime.botScope(bot.id)) });
    } catch (error) { sendError(response, error, 'Unable to read Bot presence'); }
  });
  app.post('/api/harness/bots/:botId/matters', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (!work || !await bots.get(botIdOf(request))) throw new HarnessServiceError('not-found', 'Bot work is unavailable');
      if (request.body?.botId !== botIdOf(request)) throw new HarnessServiceError('invalid-params', 'Bot work owner differs from the selected assistant');
      response.json({ matter: await work.updateBotMatter(request.body) });
    } catch (error) { sendError(response, error, 'Unable to update followed work'); }
  });

  app.post("/api/harness/bots", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.body?.runtime !== undefined) throw new HarnessServiceError("invalid-params", "Bot runtime selection is unsupported");
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
      if (body.runtime !== undefined || body.entry !== undefined) throw new HarnessServiceError("invalid-params", "A Bot runtime and entry cannot be changed");
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

  app.delete('/api/harness/bots/:botId', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const bot = await bots.remove(botIdOf(request));
      response.status(bot ? 202 : 200).json({ bot });
    } catch (error) { sendError(response, error, 'Unable to delete Bot'); }
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
  const memoryItem = (item: Knowledge) => ({ id: item.id, content: item.content, trigger: item.trigger,
    createdAt: item.createdAt, sourceKind: item.source?.kind ?? null, revision: memoryRevision(item), inactive: item.invalidAt !== undefined,
    ...(item.maintenanceReason ? { maintenanceReason: item.maintenanceReason } : {}), ...(item.overview ? { overview: true } : {}) });
  app.get('/api/harness/bots/:botId/memory-maintenance', requireAuth, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try { await memoryOwner(request); response.json({ jobs: await organizer?.maintenanceStatus(botScopeId(botIdOf(request))) ?? [] }); }
    catch (error) { sendError(response, error, 'Unable to read memory maintenance'); }
  });
  app.post('/api/harness/bots/:botId/memory-maintenance', requireAuth, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      await memoryOwner(request);
      if (!organizer) throw new HarnessServiceError('unavailable', 'Memory maintenance unavailable');
      const ids: unknown = request.body?.ids ?? [];
      if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new HarnessServiceError('invalid-params', 'ids must name existing memories');
      response.json({ job: await organizer.maintain(botScopeId(botIdOf(request)), ids as number[], typeof request.body?.reason === 'string' ? request.body.reason : 'Review and organize existing understanding', undefined, typeof request.body?.query === 'string' ? request.body.query : undefined) });
    } catch (error) { sendError(response, error, 'Unable to organize memory'); }
  });
  app.post('/api/harness/bots/:botId/memory-maintenance/cancel', requireAuth, async (request, response) => {
    try {
      await memoryOwner(request);
      if (!organizer || typeof request.body?.key !== 'string') throw new HarnessServiceError('invalid-params', 'Maintenance key required');
      await organizer.cancelMaintenance(botScopeId(botIdOf(request)), request.body.key); response.json({ ok: true });
    } catch (error) { sendError(response, error, 'Unable to cancel maintenance'); }
  });
  app.post('/api/harness/bots/:botId/memory/history/clear', requireAuth, async (request, response) => {
    try {
      const owner = await memoryOwner(request);
      const ids: unknown = request.body?.ids;
      if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new HarnessServiceError('invalid-params', 'Retired history IDs required');
      response.json(await memory!.clearHistory(owner, ids as number[]));
    } catch (error) { sendError(response, error, 'Unable to clear memory history'); }
  });
  app.get("/api/harness/bots/:botId/memory", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const owner = await memoryOwner(request);
      const items = await memory!.list(owner, { activeOnly: request.query.includeInactive !== 'true' });
      response.json({ items: items.filter(item => item.forgottenAt === undefined).map(memoryItem) });
    } catch (error) { sendError(response, error, "Unable to read Bot memory"); }
  });
  app.get('/api/harness/bots/:botId/memory/:memoryId/history', requireAuth, async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { item, chain } = await memory!.get(await memoryOwner(request), memoryId(request));
      response.json({ items: (chain?.chain ?? [item]).filter(row => row.forgottenAt === undefined && !row.historyCleared).map(memoryItem) });
    } catch (error) { sendError(response, error, 'Unable to read memory history'); }
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
      else if (request.body?.action === 'restore') {
        const { item: previous } = await memory!.get(owner, Number(request.body.previousId));
        const { chain } = await memory!.get(owner, id);
        if (!chain?.chain.some(row => row.id === previous.id) || previous.forgottenAt !== undefined || memoryRevision(previous) !== request.body.previousRevision)
          throw new HarnessServiceError('invalid-params', 'The selected historical revision is unavailable');
        await memory!.correct(owner, id, { content: previous.content, trigger: previous.trigger, ...(previous.nature ? { nature: previous.nature } : {}),
          source: { kind: 'user-correction', spans: previous.source?.spans ?? [] }, expected, restoreRetired: item.invalidAt !== undefined });
      }
      else if (request.body?.action === 'archive') await memory!.archive(owner, id, expected);
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

  /** The Bot's own conversations, primary entry first. */
  app.get("/api/harness/bots/:botId/sessions", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ sessions: await bots.listSessions(botIdOf(request)) });
    } catch (error) {
      sendError(response, error, "Unable to list Bot conversations");
    }
  });

  /** Start another conversation that shares the Bot identity, profile and memory. */
  app.post("/api/harness/bots/:botId/sessions", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json({ session: await bots.createSession(botIdOf(request)) });
    } catch (error) {
      sendError(response, error, "Unable to start a Bot conversation");
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
        desktops: desktops.filter((desktop) => desktop.work?.some((association) =>
          association.work.runtime === 'agent' && association.work.threadId === item.identity.threadId)),
        artifacts: artifacts.filter((artifact) => artifact.threadId === item.identity.threadId) }))
        .filter((item) => (item.purpose !== 'bot-root' && item.purpose !== 'session') || item.desktops.length > 0 || item.artifacts.length > 0) });
    } catch (error) {
      sendError(response, error, "Unable to list bot work");
    }
  });

}
