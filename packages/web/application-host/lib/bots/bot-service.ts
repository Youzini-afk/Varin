import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { BotExecutionGate, KernelRecordResult } from "../kernel/protocol.generated.js";
import { HarnessServiceError } from "../harness/service-error.js";
import type {
  BotActivity,
  BotCreateInput,
  BotUpdateInput,
  BotEntryResult,
  ThreadIdentity,
  BotSleepWork,
  BotSleepMachine,
  BotModelSelection,
  BotProfile,
  BotSummary,
  BotWorkItem,
} from "@varin/application-client";

export interface BotLifecycleRuntime {
  planWork(bot: BotSummary): Promise<BotSleepWork[]>;
  planMachines(bot: BotSummary): Promise<BotSleepMachine[]>;
  stop(bot: BotSummary, work: BotSleepWork): Promise<void>;
  stopScope(bot: BotSummary): Promise<BotActivity["execution"] | void>;
  machine(bot: BotSummary, machine: BotSleepMachine, waking: boolean): Promise<BotSleepMachine>;
  prepareWake(bot: BotSummary): Promise<void>;
  resume(bot: BotSummary, work: BotSleepWork): Promise<void>;
  awakened(bot: BotSummary): Promise<void>;
}

export type { BotModelSelection, BotProfile, BotSummary, BotWorkItem } from "@varin/application-client";

/** Kernel workspace under which durable `bot.profile` records are cataloged. */
export const BOT_CATALOG_WORKSPACE_ID = "__varin_bots__";

export interface BotServiceOptions {
  client: KernelClient;
  hostId: string;
  /** Directory containing Host-owned data; Bot home directories live below it. */
  dataDir: string;
  agent: {
    ensureEntry(bot: BotSummary): Promise<ThreadIdentity>;
    model(bot: BotSummary): Promise<BotModelSelection | null>;
    listWork(bot: BotSummary, includeEntry: boolean): Promise<BotWorkItem[]>;
    applyProfile?(bot: BotSummary): Promise<void>;
  };
  onError?(error: unknown): void;
  lifecycle?(): BotLifecycleRuntime;
  removeData?(bot: BotSummary): Promise<void>;
  /** Private execution projection of this service's exact authoritative record. */
  publishExecutionGate?(gate: BotExecutionGate): Promise<void>;
  onChange?(bot: BotSummary): void;
  onDeleted?(botId: string): void;
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
    if (typeof raw.coordinatorHostId !== "string" || !raw.coordinatorHostId
      || typeof raw.homeDir !== "string" || !raw.homeDir
      || (raw.instructions !== null && typeof raw.instructions !== 'string')
      || (raw.model !== null && !parseModel(raw.model))) return null;
    // Unsupported formats remain untouched; no legacy asset conversion is performed.
    if ('entrySessionId' in raw || !isObject(raw.entry) || raw.entry.runtime !== 'agent'
      || typeof raw.entry.threadId !== 'string' || !raw.entry.threadId
      || typeof raw.entry.branchId !== 'string' || !raw.entry.branchId) return null;
    const id = record.recordId.split(":")[1];
    if (!id || raw.id !== id) return null;
    if (raw.deletion !== undefined && (!isObject(raw.deletion) || typeof raw.deletion.operationId !== 'string'
      || (raw.deletion.error !== null && typeof raw.deletion.error !== 'string'))) return null;
    return {
      id,
      name: raw.name,
      instructions: typeof raw.instructions === "string" ? raw.instructions : null,
      model: parseModel(raw.model),
      coordinatorHostId: raw.coordinatorHostId,
      homeDir: typeof raw.homeDir === "string" ? raw.homeDir : "",
      entry: { runtime: 'agent', threadId: raw.entry.threadId, branchId: raw.entry.branchId },
      pinnedAt: typeof raw.pinnedAt === "string" ? raw.pinnedAt : null,
      archiveRequested: raw.archiveRequested === true,
      ...(raw.deletion === undefined ? {} : { deletion: raw.deletion as NonNullable<BotProfile['deletion']> }),
      ...(raw.activity === undefined ? {} : { activity: parseActivity(raw.activity) }),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  } catch {
    return null;
  }
};

const parseActivity = (value: unknown): BotActivity => {
  if (!isObject(value) || !["awake", "sleeping", "asleep", "waking", "sleep-failed", "wake-failed"].includes(String(value.state))
    || typeof value.operationId !== "string" || typeof value.planned !== "boolean"
    || (value.readyToResume !== undefined && typeof value.readyToResume !== 'boolean')
    || (value.machinesPlanned !== undefined && typeof value.machinesPlanned !== 'boolean')
    || (value.wakeAttempt !== undefined && (!Number.isSafeInteger(value.wakeAttempt) || Number(value.wakeAttempt) < 0))
    || !Array.isArray(value.work) || !Array.isArray(value.machines)
    || (value.error !== null && typeof value.error !== "string")
    || !value.work.every((item) => isObject(item) && typeof item.threadId === "string"
      && item.runtime === "agent" && typeof item.branchId === "string" && typeof item.runId === "string"
      && [item.resume, item.stopped, item.resumed].every((flag) => typeof flag === "boolean"))
    || !value.machines.every((item) => isObject(item) && typeof item.machineId === "string" && typeof item.label === "string"
      && ["pending", "stopping", "stopped", "starting", "ready", "kept-running"].includes(String(item.state)))) {
    throw new Error("Malformed Bot activity record");
  }
  return value as unknown as BotActivity;
};

export interface BotService {
  list(): Promise<BotSummary[]>;
  get(botId: string): Promise<BotSummary | null>;
  create(input?: BotCreateInput): Promise<BotSummary>;
  update(botId: string, patch: BotUpdateInput): Promise<BotSummary | null>;
  archive(botId: string): Promise<BotSummary | null>;
  remove(botId: string): Promise<BotSummary | null>;
  restore(botId: string): Promise<BotSummary | null>;
  sleep(botId: string): Promise<BotSummary>;
  wake(botId: string): Promise<BotSummary>;
  retry(botId: string): Promise<BotSummary>;
  canExecute(botId: string): Promise<boolean>;
  publishExecutionGates(): Promise<void>;
  executionGate(botId: string): Promise<BotExecutionGate>;
  reconcile(): Promise<void>;
  dispose(): Promise<void>;
  /** Materialize and resolve the allocated native entry without changing its identity. */
  ensureEntry(botId: string): Promise<BotEntryResult>;
  /** Threads owned by the Bot's owner scope, including original executor references. */
  listWork(botId: string, includeEntry?: boolean): Promise<BotWorkItem[]>;
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
  const detachKernelExit = options.client.subscribeExit(() => { scopedClient = null; });
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

  const recordFor = async (botId: string): Promise<KernelRecordResult | null> => {
    const client = await scoped();
    const record = await client.getRecord(BOT_CATALOG_WORKSPACE_ID, `bot.profile:${botId}`);
    if (record && (record.recordType !== "bot.profile" || !parseProfile(record))) {
      throw new HarnessServiceError("failed", `Bot profile format is unsupported or malformed; its data has been preserved: ${botId}`);
    }
    return record;
  };

  const permitted = (bot: BotSummary): boolean => !bot.archived && !bot.deletion && (!bot.activity || bot.activity.state === "awake"
    || (bot.activity.state === "waking" && bot.activity.readyToResume === true && operations.has(bot.id)));
  const publishExecutionGate = async (record: KernelRecordResult): Promise<void> => {
    if (!options.publishExecutionGate) return;
    const bot = toSummary(record);
    if (!bot) throw new HarnessServiceError("failed", `Bot profile format is unsupported or malformed; its data has been preserved: ${record.recordId}`);
    // A saved waking receipt cannot reopen this executor epoch. Reconciliation
    // checkpoints readiness=false before the new lifecycle owner resumes its work.
    if (bot.activity?.state === "waking" && bot.activity.readyToResume && !operations.has(bot.id)) return;
    await options.publishExecutionGate({ botId:bot.id, profileRevision:record.recordRevision,
      activityOperationId:bot.activity?.operationId ?? null, permitted:permitted(bot) });
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
      entry: { runtime: "agent", threadId: `thread:bot:${botId}`, branchId: `branch:bot:${botId}` },
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
    await publishExecutionGate(result);
    options.onChange?.(summary);
    return summary;
  };

  const listRecords = async (): Promise<KernelRecordResult[]> => {
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
    return records;
  };
  const list: BotService["list"] = async () => {
    return (await listRecords())
      .map((record) => {
        const bot = toSummary(record);
        if (!bot) throw new HarnessServiceError("failed", `Bot profile format is unsupported or malformed; its data has been preserved: ${record.recordId}`);
        return bot;
      })
      .sort((a, b) => a.pinnedAt && b.pinnedAt ? a.pinnedAt.localeCompare(b.pinnedAt)
        : a.pinnedAt ? -1 : b.pinnedAt ? 1 : a.createdAt.localeCompare(b.createdAt));
  };

  const get: BotService["get"] = async (botId) => {
    const record = await recordFor(botId);
    return record ? toSummary(record) : null;
  };

  const create: BotService["create"] = async (input = {}) => {
    if ("runtime" in input) throw new HarnessServiceError("invalid-params", "Bot runtime selection is unsupported");
    const botId = randomUUID();
    const homeDir = join(options.dataDir, "bots", botId);
    await mkdir(homeDir, { recursive: true });
    const now = new Date().toISOString();
    const bot = await write(botId, "active", {
      name: input.name?.trim() || "Varin Bot",
      instructions: input.instructions?.trim() || null,
      model: input.model ?? null,
      homeDir,
      createdAt: now,
      entry: { runtime: "agent", threadId: `thread:bot:${botId}`, branchId: `branch:bot:${botId}` },
    });
    await options.agent.ensureEntry(bot);
    return bot;
  };

  const update: BotService["update"] = (botId, patch) => serialize(botId, async () => {
    const existing = await recordFor(botId);
    if (!existing || existing.state === "archived") return null;
    if (parseProfile(existing)?.deletion) throw new HarnessServiceError('invalid-params', 'This Bot is being deleted');
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
    if (patch.pinned !== undefined) updates.pinnedAt = patch.pinned ? (toSummary(existing)?.pinnedAt ?? new Date().toISOString()) : null;
    const summary = await write(botId, "active", updates, existing.recordRevision);
    if (patch.instructions !== undefined || patch.model !== undefined) await options.agent.applyProfile?.(summary);
    return summary;
  });

  const archive: BotService["archive"] = async (botId) => {
    const bot = await get(botId);
    if (!bot || bot.archived) return null;
    await transition(botId, false);
    return serialize(botId, async () => {
      const current = await get(botId);
      const asleep = current?.activity?.state === "asleep";
      return write(botId, asleep ? "archived" : "active", { archiveRequested: !asleep });
    });
  };

  const restore: BotService["restore"] = (botId) => serialize(botId, async () => {
    const existing = await recordFor(botId);
    if (existing && parseProfile(existing)?.deletion) throw new HarnessServiceError('invalid-params', 'This Bot is being deleted');
    return existing ? write(botId, "active", { archiveRequested: false }, existing.recordRevision) : null;
  });

  let disposed = false;
  const operations = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const canExecute = async (botId: string): Promise<boolean> => {
    const bot = await get(botId);
    return Boolean(bot && permitted(bot));
  };
  const checkpoint = (botId: string, activity: BotActivity) => serialize(botId, async () => {
    const current = await get(botId);
    if (!current || current.activity?.operationId !== activity.operationId) throw new Error("Bot lifecycle operation was superseded");
    const archive = current.archiveRequested && activity.state === "asleep";
    return write(botId, current.archived || archive ? "archived" : "active", {
      activity, ...(archive ? { archiveRequested: false } : {}),
      ...(current.deletion && activity.state === 'sleep-failed'
        ? { deletion: { ...current.deletion, error: activity.error } } : {}),
    });
  });
  const runLifecycle = async (botId: string): Promise<void> => {
    let bot = await get(botId);
    if (disposed || !bot) return;
    if (bot.deletion && bot.activity?.state === 'asleep') { await removeStoppedBot(bot); return; }
    if (!bot.activity || !["sleeping", "waking"].includes(bot.activity.state)) return;
    const activity = structuredClone(bot.activity);
    const waking = activity.state === "waking";
    try {
      const runtime = options.lifecycle?.();
      if (!runtime) throw new Error("Bot lifecycle runtime is unavailable");
      if (!activity.planned) {
        activity.work = await runtime.planWork(bot);
        activity.planned = true;
        bot = await checkpoint(botId, activity);
      }
      if (!waking) {
        // Close every worker even if one target cannot stop. Preserve successful
        // checkpoints so retries never restart completed work or hide failures.
        const failures: string[] = [];
        for (const work of activity.work) {
          if (disposed) return;
          if (work.stopped) continue;
          try { await runtime.stop(bot, work); work.stopped = true; }
          catch (error) { failures.push(`${work.threadId || work.runId}: ${error instanceof Error ? error.message : String(error)}`); }
          bot = await checkpoint(botId, activity);
        }
        try { const execution = await runtime.stopScope(bot); if (execution) activity.execution = execution; }
        catch (error) { if (isObject(error) && error.execution) activity.execution = error.execution as NonNullable<BotActivity['execution']>; failures.push(error instanceof Error ? error.message : String(error)); }
        if (failures.length) throw new Error(failures.join("\n"));
        if (!activity.machinesPlanned) {
          activity.machines = await runtime.planMachines(bot);
          activity.machinesPlanned = true;
          bot = await checkpoint(botId, activity);
        }
      }
      for (let index = 0; index < activity.machines.length; index++) {
        if (disposed) return;
        const machine = activity.machines[index]!;
        if (machine.state === "kept-running" || (!waking && machine.state === "stopped") || (waking && machine.state === "ready")) continue;
        // Record request intent before crossing the provider boundary.
        const observed = await runtime.machine(bot, machine, waking);
        if (JSON.stringify(observed) !== JSON.stringify(machine)) {
          activity.machines[index] = observed;
          bot = await checkpoint(botId, activity);
        }
      }
      const pending = activity.machines.some((machine) => waking
        ? machine.state !== "ready" && machine.state !== "kept-running"
        : machine.state !== "stopped" && machine.state !== "kept-running");
      if (pending) {
        if (!disposed) {
          const timer = setTimeout(() => { timers.delete(botId); launch(botId); }, 2_000);
          timer.unref?.();
          timers.set(botId, timer);
        }
        return;
      }
      if (waking) {
        await runtime.prepareWake(bot);
        activity.readyToResume = true;
        bot = await checkpoint(botId, activity);
        for (const work of [...activity.work.filter((item) => item.threadId), ...activity.work.filter((item) => !item.threadId)]) {
          if (disposed) return;
          if (!work.resume || work.resumed) continue;
          await runtime.resume(bot, work);
          work.resumed = true;
          bot = await checkpoint(botId, activity);
        }
      }
      if (disposed) return;
      activity.state = waking ? "awake" : "asleep";
      activity.error = null;
      bot = await checkpoint(botId, activity);
      if (waking) await runtime.awakened(bot);
      else if (bot.deletion) await removeStoppedBot(bot);
    } catch (error) {
      if (disposed) return;
      activity.state = waking ? "wake-failed" : "sleep-failed";
      activity.error = error instanceof Error ? error.message : String(error);
      await checkpoint(botId, activity);
    }
  };
  const launch = (botId: string): void => {
    if (disposed) return;
    const prior = operations.get(botId);
    if (prior) { void prior.then(() => launch(botId)); return; }
    const operation = runLifecycle(botId).catch((error) => options.onError?.(error))
      .finally(() => { operations.delete(botId); });
    operations.set(botId, operation);
  };
  const transition = async (botId: string, waking: boolean): Promise<BotSummary> => {
    const bot = await serialize(botId, async () => {
      const current = await get(botId);
      if (!current || current.archived) throw new HarnessServiceError("not-found", "Unknown or archived Bot");
      if (current.deletion) throw new HarnessServiceError('invalid-params', 'This Bot is being deleted');
      const state = current.activity?.state ?? "awake";
      if (state === (waking ? "awake" : "asleep") || state === (waking ? "waking" : "sleeping")) return current;
      if (state === "sleeping" || state === "waking" || (waking && state === "sleep-failed")) {
        throw new HarnessServiceError("invalid-params", "Finish the current Bot lifecycle operation before switching state");
      }
      const activity: BotActivity = (waking || state === "sleep-failed") && current.activity
        ? { ...structuredClone(current.activity), state: waking ? "waking" : "sleeping", error: null }
        : { state: "sleeping", operationId: randomUUID(), planned: false, work: [], machines: [], error: null };
      if (waking && state === "wake-failed") activity.wakeAttempt = (activity.wakeAttempt ?? 0) + 1;
      return write(botId, "active", { activity, ...(waking ? { archiveRequested: false } : {}) });
    });
    launch(botId);
    return bot;
  };
  const retry = async (botId: string): Promise<BotSummary> => {
    if ((await get(botId))?.deletion) {
      const deleting = await remove(botId);
      if (!deleting) throw new HarnessServiceError('not-found', 'Unknown Bot');
      return deleting;
    }
    const bot = await serialize(botId, async () => {
      const current = await get(botId);
      if (!current || current.archived) throw new HarnessServiceError("not-found", "Unknown Bot");
      if (!current.activity || ["awake", "asleep"].includes(current.activity.state) || operations.has(botId)) return current;
      const timer = timers.get(botId);
      if (timer) clearTimeout(timer);
      timers.delete(botId);
      const activity = structuredClone(current.activity);
      if (activity.state === "wake-failed") activity.wakeAttempt = (activity.wakeAttempt ?? 0) + 1;
      activity.state = activity.state.startsWith("wake") || activity.state === "waking" ? "waking" : "sleeping";
      activity.error = null;
      for (const machine of activity.machines) {
        if (machine.state === "stopping") machine.state = "pending";
        if (machine.state === "starting") machine.state = "stopped";
      }
      return write(botId, "active", { activity });
    });
    launch(botId);
    return bot;
  };

  const removeStoppedBot = async (bot: BotSummary): Promise<void> => {
    const deletion = bot.deletion!;
    try {
      if (!options.removeData) throw new Error('Bot data cleanup is unavailable');
      await options.removeData(bot);
      await serialize(bot.id, async () => {
        const current = await get(bot.id);
        if (!current) return;
        if (current.deletion?.operationId !== deletion.operationId) throw new Error('Bot deletion was superseded');
        await (await scoped()).releaseRecord(`bot.delete:${deletion.operationId}`, BOT_CATALOG_WORKSPACE_ID, `bot.profile:${bot.id}`);
        options.onDeleted?.(bot.id);
      });
    } catch (error) {
      await serialize(bot.id, async () => {
        const current = await get(bot.id);
        if (current?.deletion?.operationId === deletion.operationId) await write(bot.id, current.archived ? 'archived' : 'active', {
          deletion: { ...deletion, error: error instanceof Error ? error.message : String(error) },
        });
      });
    }
  };

  const remove: BotService['remove'] = async (botId) => {
    const bot = await serialize(botId, async () => {
      const current = await get(botId);
      if (!current) return null;
      if (current.deletion && !current.deletion.error) return current;
      const state = current.activity?.state ?? 'awake';
      if (state === 'sleeping' || state === 'waking') throw new HarnessServiceError('invalid-params', 'Finish the current Bot lifecycle operation before deleting it');
      const timer = timers.get(botId);
      if (timer) clearTimeout(timer);
      timers.delete(botId);
      const activity: BotActivity = state === 'asleep' ? current.activity!
        : state === 'sleep-failed' && current.activity
          ? { ...structuredClone(current.activity), state: 'sleeping', error: null }
          : { state: 'sleeping', operationId: randomUUID(), planned: false, work: [], machines: [], error: null };
      return write(botId, current.archived ? 'archived' : 'active', { activity, archiveRequested: false,
        deletion: { operationId: current.deletion?.operationId ?? randomUUID(), error: null } });
    });
    if (bot) launch(botId);
    return bot;
  };

  const ensureEntry: BotService["ensureEntry"] = (botId) => serialize(botId, async () => {
    const bot = await get(botId);
    if (!bot) throw new HarnessServiceError("not-found", `Unknown Bot "${botId}"`);
    if (bot.deletion) throw new HarnessServiceError('unavailable', 'This Bot is being deleted');
    if (bot.archived) throw new HarnessServiceError("invalid-params", `Bot "${botId}" is archived`);
    const entry = await options.agent.ensureEntry(bot);
    return { bot, entry, model: await options.agent.model(bot) };
  });

  const listWork: BotService["listWork"] = async (botId, includeEntry = false) => {
    const bot = await get(botId);
    if (!bot) throw new HarnessServiceError('not-found', 'Unknown Bot');
    return options.agent.listWork(bot, includeEntry);
  };

  return {
    list,
    get,
    create,
    update,
    archive,
    remove,
    restore,
    sleep: (botId) => transition(botId, false),
    wake: (botId) => transition(botId, true),
    retry,
    canExecute,
    executionGate: async (botId) => {
      const record = await recordFor(botId);
      const bot = record && toSummary(record);
      if (!record || !bot) throw new HarnessServiceError('not-found', 'Unknown Bot');
      return { botId, profileRevision: record.recordRevision, activityOperationId: bot.activity?.operationId ?? null, permitted: permitted(bot) };
    },
    publishExecutionGates: async () => {
      for (const listed of await listRecords()) {
        const bot = toSummary(listed);
        if (!bot) throw new HarnessServiceError("failed", `Bot profile format is unsupported or malformed; its data has been preserved: ${listed.recordId}`);
        await serialize(bot.id, async () => {
          const current = await recordFor(bot.id);
          if (current) await publishExecutionGate(current);
        });
      }
    },
    reconcile: async () => {
      for (const bot of await list()) {
        if (bot.activity?.state === 'waking' && !operations.has(bot.id)) {
          const activity = structuredClone(bot.activity);
          activity.readyToResume = false;
          // A saved readiness receipt predates this Host restart. Reinspect the
          // real guest before admitting any continuation in the new process.
          for (const machine of activity.machines) {
            if (machine.state === 'ready' || machine.state === 'starting') machine.state = 'stopped';
          }
          await checkpoint(bot.id, activity);
        }
        launch(bot.id);
      }
    },
    dispose: async () => {
      disposed = true;
      detachKernelExit();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled(operations.values());
    },
    ensureEntry,
    listWork,
  };
}
