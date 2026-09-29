import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { HarnessServiceError } from "../harness/service-error.js";
import { botScopeId } from "../harness/owner-scope.js";
import type { ThreadRegistry } from "../harness/thread-registry.js";
import type {
  BotModelSelection,
  BotProfile,
  BotSummary,
  BotWorkItem,
} from "@varin/application-client";

export type { BotModelSelection, BotProfile, BotSummary, BotWorkItem } from "@varin/application-client";

/** Kernel workspace under which durable `bot.profile` records are cataloged. */
export const BOT_CATALOG_WORKSPACE_ID = "__varin_bots__";

export interface BotServiceOptions {
  client: KernelClient;
  hostId: string;
  /** Directory containing Host-owned data; Bot home directories live below it. */
  dataDir: string;
  registry: Pick<ThreadRegistry, "listRuns" | "listWorkspaceThreadSnapshots">;
  /** Create a fresh Pi session bound to the Bot's home directory. */
  createSession(input: {
    cwd: string;
    name?: string;
    model?: BotModelSelection;
  }): Promise<{ sessionId: string }>;
  /** Reopen a persisted Pi session (or return the live one). */
  openSession(input: { sessionId: string; cwd?: string; model?: BotModelSelection }): Promise<{
    sessionId: string;
    model?: { provider: string; id: string };
  }>;
  /**
   * Apply a profile model change to an already-running entry worker. Absent
   * or failing workers keep the durable write; the next open re-applies.
   */
  applyModel?: (input: { sessionId: string; model: BotModelSelection | null }) => Promise<void>;
  applyInstructions?: (input: { sessionId: string; instructions: string | null }) => Promise<void>;
  onError?(error: unknown): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseModel = (value: unknown): BotModelSelection | null => {
  if (!isObject(value)) return null;
  const providerId = typeof value.providerId === "string" ? value.providerId : "";
  const modelId = typeof value.modelId === "string" ? value.modelId : "";
  return providerId && modelId ? { providerId, modelId } : null;
};

const parseProfile = (record: KernelRecordResult): BotProfile | null => {
  try {
    const raw = JSON.parse(record.payloadJson) as unknown;
    if (!isObject(raw)) return null;
    if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
    if (typeof raw.coordinatorHostId !== "string") return null;
    const id = record.recordId.split(":")[1];
    if (!id || raw.id !== id) return null;
    return {
      id,
      name: raw.name,
      instructions: typeof raw.instructions === "string" ? raw.instructions : null,
      model: parseModel(raw.model),
      coordinatorHostId: raw.coordinatorHostId,
      homeDir: typeof raw.homeDir === "string" ? raw.homeDir : "",
      entrySessionId: typeof raw.entrySessionId === "string" ? raw.entrySessionId : null,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  } catch {
    return null;
  }
};

export interface BotService {
  list(): Promise<BotSummary[]>;
  get(botId: string): Promise<BotSummary | null>;
  create(input?: { name?: string; instructions?: string; model?: BotModelSelection }): Promise<BotSummary>;
  update(botId: string, patch: {
    name?: string;
    instructions?: string | null;
    model?: BotModelSelection | null;
  }): Promise<BotSummary | null>;
  archive(botId: string): Promise<BotSummary | null>;
  /**
   * Resolve (creating if necessary) the Bot's long-lived entry session. A
   * persisted session that no longer exists is cleared and a fresh entry is
   * created — the Bot's work association lives on the Thread scope, so losing
   * one entry session never loses the work.
   */
  ensureEntry(botId: string): Promise<{ bot: BotSummary; sessionId: string }>;
  /** Which Bot (if any) owns this session as its entry conversation. */
  botForSession(sessionId: string): Promise<BotSummary | null>;
  /** Threads owned by the Bot's owner scope — its real associated work. */
  listWork(botId: string): Promise<BotWorkItem[]>;
  /**
   * Called when a session is deleted: clears a stale entry binding so the next
   * entry resolution creates a fresh conversation instead of re-anchoring a
   * dead session.
   */
  releaseEntry(sessionId: string): Promise<void>;
}

export function createBotService(options: BotServiceOptions): BotService {
  const mutations = new Map<string, Promise<unknown>>();
  const serialize = <T>(botId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(botId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    mutations.set(botId, task);
    return task.finally(() => { if (mutations.get(botId) === task) mutations.delete(botId); });
  };
  let scopedClient: Promise<KernelScopedClient> | null = null;
  const scoped = (): Promise<KernelScopedClient> => {
    if (scopedClient) return scopedClient;
    const creating = (async () => {
      const grant = await options.client.issueGrant({
        grantId: `bot-catalog:${randomUUID()}`,
        owningWorkspace: BOT_CATALOG_WORKSPACE_ID,
        executionWorkspace: BOT_CATALOG_WORKSPACE_ID,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return options.client.scoped(grant);
    })();
    scopedClient = creating;
    void creating.catch(() => { if (scopedClient === creating) scopedClient = null; });
    return creating;
  };
  const toSummary = (record: KernelRecordResult): BotSummary | null => {
    const profile = parseProfile(record);
    return profile ? { ...profile, archived: record.state === "archived" } : null;
  };

  /**
   * session→bot index consulted on every `agent_start` through the bot-root
   * runtime; populated on the first lookup and invalidated on each write.
   */
  let sessionIndex: Map<string, string> | null = null;
  let catalogGeneration = 0;

  const recordFor = async (botId: string): Promise<KernelRecordResult | null> => {
    const client = await scoped();
    const record = await client.getRecord(BOT_CATALOG_WORKSPACE_ID, `bot.profile:${botId}`);
    if (record && (record.recordType !== "bot.profile" || !parseProfile(record))) {
      throw new HarnessServiceError("failed", `Bot profile is malformed: ${botId}`);
    }
    return record;
  };

  const write = async (
    botId: string,
    state: "active" | "archived",
    patch: Partial<BotProfile>,
    expectedRecordRevision?: number,
  ): Promise<BotSummary> => {
    const existing = await recordFor(botId);
    const profile = existing ? parseProfile(existing) : null;
    const base: BotProfile = profile ?? {
      id: botId,
      name: "Bot",
      instructions: null,
      model: null,
      coordinatorHostId: options.hostId,
      homeDir: join(options.dataDir, "bots", botId),
      entrySessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const next: BotProfile = {
      ...base,
      ...patch,
      id: botId,
      coordinatorHostId: options.hostId,
      updatedAt: new Date().toISOString(),
    };
    const client = await scoped();
    const revision = expectedRecordRevision ?? existing?.recordRevision;
    const result = await client.putRecord({
      operationId: `bot.profile:${randomUUID()}`,
      workspaceId: BOT_CATALOG_WORKSPACE_ID,
      recordId: `bot.profile:${botId}`,
      recordType: "bot.profile",
      state,
      payloadJson: JSON.stringify(next),
      ownerIds: [],
      references: [],
      ...(typeof revision === "number" ? { expectedRecordRevision: revision } : {}),
    });
    const summary = toSummary(result) ?? { ...next, archived: state === "archived" };
    // Rebuild the session index from the authoritative write so a moved or
    // cleared entry binding cannot keep an old sessionId mapped.
    catalogGeneration += 1;
    sessionIndex = null;
    return summary;
  };

  const list: BotService["list"] = async () => {
    const client = await scoped();
    const records: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await client.listRecords({
        workspaceId: BOT_CATALOG_WORKSPACE_ID,
        recordType: "bot.profile",
        ...(typeof cursor === "number" ? { cursor } : {}),
        pageSize: 100,
      });
      records.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records
      .map((record) => {
        const bot = toSummary(record);
        if (!bot) throw new HarnessServiceError("failed", `Bot profile is malformed: ${record.recordId}`);
        return bot;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const get: BotService["get"] = async (botId) => {
    const record = await recordFor(botId);
    return record ? toSummary(record) : null;
  };

  const create: BotService["create"] = async (input = {}) => {
    const botId = randomUUID();
    const homeDir = join(options.dataDir, "bots", botId);
    await mkdir(homeDir, { recursive: true });
    const now = new Date().toISOString();
    return write(botId, "active", {
      name: input.name?.trim() || "Varin Bot",
      instructions: input.instructions?.trim() || null,
      model: input.model ?? null,
      homeDir,
      createdAt: now,
      entrySessionId: null,
    });
  };

  const update: BotService["update"] = (botId, patch) => serialize(botId, async () => {
    const existing = await recordFor(botId);
    if (!existing || existing.state === "archived") return null;
    const updates: Partial<BotProfile> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new HarnessServiceError("invalid-params", "Bot name must be non-empty");
      updates.name = name;
    }
    if (patch.instructions !== undefined) {
      updates.instructions = typeof patch.instructions === "string" && patch.instructions.trim()
        ? patch.instructions.trim()
        : null;
    }
    if (patch.model !== undefined) updates.model = patch.model;
    const summary = await write(botId, "active", updates, existing.recordRevision);
    // Keep a live entry worker on the profile's current model. A closed or
    // unreachable worker is retried by the model passed on the next open;
    // clearing the preference likewise applies from the next open.
    if (summary.entrySessionId && (patch.model !== undefined || patch.instructions !== undefined)) {
      try {
        if (patch.model !== undefined) await options.applyModel?.({ sessionId: summary.entrySessionId, model: patch.model });
        if (patch.instructions !== undefined) await options.applyInstructions?.({
          sessionId: summary.entrySessionId, instructions: summary.instructions,
        });
      } catch (error) {
        options.onError?.(error);
        if (!isObject(error) || error.code !== "session_not_found") {
          throw new HarnessServiceError("unavailable", "Bot profile was saved, but the live entry could not apply it. Reopen the entry conversation.");
        }
      }
    }
    return summary;
  });

  const archive: BotService["archive"] = (botId) => serialize(botId, async () => {
    const existing = await recordFor(botId);
    if (!existing || existing.state === "archived") return null;
    return write(botId, "archived", {}, existing.recordRevision);
  });

  const ensureEntry: BotService["ensureEntry"] = (botId) => serialize(botId, async () => {
    const bot = await get(botId);
    if (!bot) throw new HarnessServiceError("not-found", `Unknown Bot "${botId}"`);
    if (bot.archived) throw new HarnessServiceError("invalid-params", `Bot "${botId}" is archived`);
    if (bot.entrySessionId) {
      try {
        const session = await options.openSession({
          sessionId: bot.entrySessionId,
          cwd: bot.homeDir,
          ...(bot.model ? { model: bot.model } : {}),
        });
        // The broker returns an existing live worker without applying the
        // `openSession` model argument. Reconcile that worker before exposing
        // the entry as ready; a closed worker already opened on the preference.
        if (bot.model && options.applyModel && (session.model?.provider !== bot.model.providerId
          || session.model.id !== bot.model.modelId)) {
          await options.applyModel({ sessionId: session.sessionId, model: bot.model });
        }
        if (!bot.model) await options.applyModel?.({ sessionId: session.sessionId, model: null });
        await options.applyInstructions?.({ sessionId: session.sessionId, instructions: bot.instructions });
        return { bot, sessionId: session.sessionId };
      } catch (error) {
        if (!isObject(error) || error.code !== "session_not_found") throw error;
        // The persisted entry session is gone (deleted or never materialized
        // on this Host). Clear it and create a fresh entry below — the Bot's
        // work lives on its Thread scope, not on this one conversation.
      }
    }
    await mkdir(bot.homeDir, { recursive: true });
    const session = await options.createSession({
      cwd: bot.homeDir,
      name: bot.name,
      ...(bot.model ? { model: bot.model } : {}),
    });
    // Return the session only once the durable owner binding was committed.
    // An IPC/storage failure is not a successful entry without Bot identity.
    const updated = await write(botId, "active", { entrySessionId: session.sessionId });
    await options.applyInstructions?.({ sessionId: session.sessionId, instructions: updated.instructions });
    return { bot: updated, sessionId: session.sessionId };
  });

  const botForSession: BotService["botForSession"] = async (sessionId) => {
    if (!sessionId) return null;
    while (!sessionIndex) {
      const generation = catalogGeneration;
      const bots = await list();
      if (generation !== catalogGeneration) continue;
      sessionIndex = new Map(bots.flatMap((bot) => (
        !bot.archived && bot.entrySessionId ? [[bot.entrySessionId, bot.id] as const] : []
      )));
    }
    const botId = sessionIndex.get(sessionId);
    return botId ? get(botId) : null;
  };

  const listWork: BotService["listWork"] = async (botId) => {
    const snapshots = await options.registry.listWorkspaceThreadSnapshots(botScopeId(botId));
    const items: BotWorkItem[] = [];
    for (const { thread, activeRun } of snapshots) {
      if (thread.purpose === "bot-root") continue;
      // The latest Run's session is the reopenable surface for this work.
      const runs = await options.registry.listRuns(botScopeId(botId), thread.id);
      const sessionId = activeRun?.sessionId ?? runs.at(-1)?.sessionId ?? null;
      items.push({ thread, activeRun, sessionId });
    }
    return items;
  };

  const releaseEntry: BotService["releaseEntry"] = async (sessionId) => {
    const bots = await list();
    for (const bot of bots) {
      if (bot.entrySessionId !== sessionId || bot.archived) continue;
      await serialize(bot.id, async () => {
        const existing = await recordFor(bot.id);
        if (!existing) return;
        const profile = parseProfile(existing);
        if (profile?.entrySessionId !== sessionId) return;
        await write(bot.id, "active", { entrySessionId: null }, existing.recordRevision);
      });
    }
  };

  return {
    list,
    get,
    create,
    update,
    archive,
    ensureEntry,
    botForSession,
    listWork,
    releaseEntry,
  };
}
