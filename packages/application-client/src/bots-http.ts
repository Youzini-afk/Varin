import type { BotsAPI, BotEntry, BotEntryResult, BotPresence, BotSession, BotSummary, BotWorkItem, BotMemoryItem } from './bots.js';
import type { ThreadMemoryDraft, ChatMemoryOwner, ChatMemoryReceipt } from './chat-memory.js';
import type { BotActivityPage, MemorySourceExcerpt } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export class BotRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryDisposition?: 'observe' | 'new_attempt' | 'none') { super(message); this.name = 'BotRequestError'; }
}
const invalid = (): never => { throw new BotRequestError(502, 'invalid-response', 'The Host returned an invalid Bot response. Refresh before continuing.'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const string = (value: unknown): string => typeof value === 'string' ? value : invalid();
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(string) : invalid();
const array = <T>(value: unknown, decode: (item: unknown) => T): T[] => Array.isArray(value) ? value.map(decode) : invalid();
const entry = (value: unknown): BotEntry => {
  const input = record(value);
  if (input.runtime === 'agent' && typeof input.threadId === 'string' && input.threadId && typeof input.branchId === 'string' && input.branchId) {
    return { runtime: 'agent', threadId: input.threadId, branchId: input.branchId };
  }
  return invalid();
};
export const decodeBot = (value: unknown): BotSummary => {
  const bot = record(value);
  for (const key of ['id', 'name', 'homeDir', 'coordinatorHostId', 'createdAt', 'updatedAt']) string(bot[key]);
  entry(bot.entry);
  if (typeof bot.archived !== 'boolean' || !nullableString(bot.instructions)) invalid();
  if (bot.model !== null) { const model = record(bot.model); string(model.providerId); string(model.modelId); }
  if (bot.pinnedAt !== undefined && !nullableString(bot.pinnedAt)) invalid();
  if (bot.archiveRequested !== undefined && typeof bot.archiveRequested !== 'boolean') invalid();
  if (bot.deletion !== undefined) { const deletion = record(bot.deletion); string(deletion.operationId); if (!nullableString(deletion.error)) invalid(); }
  if (bot.activity !== undefined) {
    const activity = record(bot.activity);
    if (!['awake', 'sleeping', 'asleep', 'waking', 'sleep-failed', 'wake-failed'].includes(string(activity.state))
      || typeof activity.planned !== 'boolean' || !nullableString(activity.error)) invalid();
    string(activity.operationId);
    array(activity.work, value => {
      const work = record(value); string(work.threadId);
      if (work.runtime === 'agent') { string(work.branchId); string(work.runId); } else invalid();
      if (['resume', 'stopped', 'resumed'].some(key => typeof work[key] !== 'boolean')) invalid();
    });
    array(activity.machines, value => {
      const machine = record(value); string(machine.machineId); string(machine.label);
      if (!['pending', 'stopping', 'stopped', 'starting', 'ready', 'kept-running'].includes(string(machine.state))) invalid();
      if (machine.detail !== undefined) string(machine.detail);
    });
    if (activity.execution !== undefined) {
      const execution = record(activity.execution);
      if (typeof execution.currentKernelWorkersDrained !== 'boolean') invalid();
      strings(execution.unprovenOperationStopIds); strings(execution.unknownEffectOperationIds); strings(execution.unresolvedModelRequestIds);
    }
  }
  return bot as unknown as BotSummary;
};
export const decodeBotEntryResult = (value: unknown): BotEntryResult => {
  const result = record(value); const bot = decodeBot(result.bot); const target = entry(result.entry);
  if (bot.entry.threadId !== target.threadId || bot.entry.branchId !== target.branchId) invalid();
  if (result.model !== null) { const model = record(result.model); string(model.providerId); string(model.modelId); }
  return { bot, entry: target, model: result.model } as BotEntryResult;
};
export const decodeBotWork = (value: unknown): BotWorkItem => {
  const work = record(value); const thread = record(work.thread);
  if (work.runtime === 'agent') {
    const identity = entry(work.identity);
    if (identity.threadId !== string(thread.thread_id)
      || !['bot-root', 'session', 'work', 'followed'].includes(string(work.purpose)) || !nullableString(thread.bot_id)
      || (work.sessionThreadId !== undefined && !nullableString(work.sessionThreadId))) invalid();
    const branchId = identity.branchId;
    const branches = array(thread.branches, value => {
      const branch = record(value); string(branch.branch_id); if (!nullableString(branch.head) || !nullableString(branch.active_run_id)) invalid();
      if (branch.latest_run !== null) { const run = record(branch.latest_run); string(run.id); string(run.state); }
      return branch;
    });
    if (!branches.some(branch => branch.branch_id === branchId)) invalid();
    if (work.activeRun !== null) { const run = record(work.activeRun); string(run.id); string(run.state); }
  } else invalid();
  if (work.desktops !== undefined) array(work.desktops, value => { const desktop = record(value); string(desktop.id); string(desktop.label); string(desktop.status); });
  if (work.artifacts !== undefined) array(work.artifacts, value => { const artifact = record(value); string(artifact.id); string(artifact.relativePath); });
  return work as unknown as BotWorkItem;
};
export const decodeBotSession = (value: unknown): BotSession => {
  const session = record(value); const identity = entry(session.identity); const thread = record(session.thread);
  if (identity.threadId !== string(thread.thread_id) || identity.branchId !== string(thread.main_branch_id)
    || typeof session.primary !== 'boolean' || typeof thread.title !== 'string' || !nullableString(thread.bot_id)) invalid();
  array(thread.branches, value => {
    const branch = record(value); string(branch.branch_id); if (!nullableString(branch.head) || !nullableString(branch.active_run_id)) invalid();
    if (branch.latest_run !== null) { const run = record(branch.latest_run); string(run.id); string(run.state); }
    return branch;
  });
  return session as unknown as BotSession;
};
const memoryItem = (value: unknown): BotMemoryItem => {
  const item = record(value);
  if (!Number.isSafeInteger(item.id) || Number(item.id) < 0 || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || !nullableString(item.sourceKind)) invalid();
  string(item.content); string(item.trigger); string(item.revision);
  if (item.inactive !== undefined && typeof item.inactive !== 'boolean') invalid();
  return item as unknown as BotMemoryItem;
};
const maintenanceJob = (value: unknown): import('./bots.js').BotMemoryMaintenance => {
  const job = record(value);
  string(job.key);
  if (!['pending', 'processing', 'prepared', 'formed', 'reviewed-empty', 'failed'].includes(String(job.status)) || typeof job.updatedAt !== 'number') invalid();
  if (job.lastError !== undefined) string(job.lastError);
  if (job.maintenance !== undefined) {
    const input = record(job.maintenance);
    if (!Array.isArray(input.ids) || input.ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || !['automatic', 'selection'].includes(String(input.mode)) || typeof input.reason !== 'string'
      || input.cancelled !== undefined && typeof input.cancelled !== 'boolean') invalid();
  }
  return job as unknown as import('./bots.js').BotMemoryMaintenance;
};
const sourceExcerpt = (value: unknown): MemorySourceExcerpt => {
  const source = record(value); const span = record(source.span);
  const required = span.kind === 'history-item' ? ['threadId', 'branchId', 'headId'] : null;
  if (!required || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || Number(span.start) < 0 || Number(span.end) <= Number(span.start)) invalid();
  for (const key of ['id', 'revision', ...required!]) string(span[key]);
  if (source.status === 'available') string(source.text);
  else if (source.status !== 'unavailable' && source.status !== 'changed') invalid();
  return source as unknown as MemorySourceExcerpt;
};

const memoryOwner = (value: unknown): ChatMemoryOwner => {
  const owner = record(value);
  if (!['workspace', 'bot', 'session', 'user'].includes(string(owner.scope)) || !nullableString(owner.ownerId)) invalid();
  return owner as unknown as ChatMemoryOwner;
};
const memoryDraft = (value: unknown): ThreadMemoryDraft => {
  const draft = record(value); string(draft.content); string(draft.trigger);
  if (draft.nature !== undefined && !['experience', 'decision', 'preference', 'judgment', 'instruction'].includes(string(draft.nature))) invalid();
  const sources = array(draft.sources, value => {
    const source = record(value); string(source.itemId); string(source.text); string(source.revision);
    if (!Number.isSafeInteger(source.start) || Number(source.start) < 0) invalid();
    return source;
  });
  if (!sources.length) invalid();
  return draft as unknown as ThreadMemoryDraft;
};
const memoryReceipt = (value: unknown): ChatMemoryReceipt => {
  const receipt = record(value); memoryOwner(receipt.owner); const item = record(receipt.item);
  if (typeof receipt.created !== 'boolean' || !Number.isSafeInteger(item.id) || Number(item.id) < 0 || item.status !== 'accepted') invalid();
  string(item.content); string(item.trigger);
  if (item.invalidAt !== undefined && (typeof item.invalidAt !== 'number' || !Number.isFinite(item.invalidAt))) invalid();
  return receipt as unknown as ChatMemoryReceipt;
};

/** Also decodes the `varin:bot-presence` push, which carries the same projection. */
export const decodeBotPresence = (value: unknown): BotPresence => {
  const presence = record(value); string(presence.botId); strings(presence.replying);
  array(presence.needs, value => {
    const need = record(value); entry(need.identity); string(need.name);
    if (!nullableString(need.avatar) || !['permission', 'question'].includes(string(need.kind)) || typeof need.session !== 'boolean') invalid();
  });
  array(presence.working, value => {
    const work = record(value); entry(work.identity); string(work.name);
    if (!nullableString(work.avatar) || !nullableString(work.sessionThreadId)) invalid();
  });
  return presence as unknown as BotPresence;
};
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const decodeActivity = (value: unknown): BotActivityPage => {
  const page = record(value); string(page.botId);
  if (!(page.before === null || count(page.before)) || !count(page.eventCursor)) invalid();
  array(page.participants, value => {
    const participant = record(value); string(participant.threadId); string(participant.name); string(participant.agentId);
    if (!nullableString(participant.avatar)) invalid();
  });
  array(page.events, value => {
    const event = record(value);
    if (!count(event.cursor) || !(event.atMs === null || count(event.atMs))) invalid();
    string(event.sessionThreadId); string(event.sessionBranchId);
    if (event.kind === 'dispatch' || event.kind === 'report') {
      string(event.operationId); string(event.executionId); string(event.threadId); string(event.branchId);
      if (event.kind === 'dispatch') { string(event.task); if (!nullableString(event.preset)) invalid(); } else string(event.outcome);
    } else if (event.kind === 'change') {
      if (!['user_input', 'workspace_change', 'history_changed'].includes(string(event.change))) invalid();
      string(event.threadId); string(event.branchId);
    } else if (event.kind === 'quiet') {
      string(event.runId);
      array(event.inputs, value => { const input = record(value); string(input.origin); if (!nullableString(input.threadId) || !nullableString(input.branchId) || !nullableString(input.change)) invalid(); });
    } else if (event.kind === 'schedule') {
      string(event.occurrenceId); string(event.definitionId); string(event.name); string(event.state);
    } else invalid();
  });
  return page as unknown as BotActivityPage;
};

const decodeMatter = (value: unknown): import('@varin/protocol').BotMatter => {
  const matter = record(value);
  string(matter.id); string(matter.title); string(matter.description);
  if (!Number.isSafeInteger(matter.revision) || Number(matter.revision) < 1 || typeof matter.archived !== 'boolean') invalid();
  array(matter.threads, value => {
    const link = record(value); string(link.threadId); string(link.branchId);
    if (typeof link.send !== 'boolean' || typeof link.memory !== 'boolean') invalid();
    return link;
  });
  return matter as unknown as import('@varin/protocol').BotMatter;
};

/** Runtime-independent Bot transport. Host replacement never publishes an old Bot view. */
export function createBotsHttpAPI(): BotsAPI {
  const request = async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const generation = getRuntimeEndpointGeneration();
    const current = () => { signal?.throwIfAborted(); if (generation !== getRuntimeEndpointGeneration()) throw new BotRequestError(409, 'host-changed', 'Application Host changed. Reload Bots.'); };
    current();
    const response = await runtimeFetch(path, { method, ...(signal ? { signal } : {}), headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    current(); const result: unknown = await response.json().catch(() => null); current();
    if (!response.ok) {
      const error = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      throw new BotRequestError(response.status, typeof error.code === 'string' ? error.code : 'bot-request-failed', typeof error.error === 'string' ? error.error : `Bot request failed (${response.status}).`, error.retryDisposition === 'observe' || error.retryDisposition === 'new_attempt' || error.retryDisposition === 'none' ? error.retryDisposition : undefined);
    }
    return record(result);
  };
  const path = (id: string) => `/api/harness/bots/${encodeURIComponent(id)}`;
  return {
    selection: {
      preview: async (input, signal) => {
        const result = await request('/api/bot-memory/preview', 'POST', input, signal);
        if (result.requestKey !== input.requestKey) invalid();
        return { owner: memoryOwner(result.owner), requestKey: string(result.requestKey), drafts: array(result.drafts, memoryDraft) };
      },
      save: async input => memoryReceipt(await request('/api/bot-memory/save', 'POST', input)),
      undo: async input => { const result = await request('/api/bot-memory/undo', 'POST', input); if (result.undone !== true) invalid(); return { undone: true }; },
    },
    list: async signal => array((await request('/api/harness/bots', 'GET', undefined, signal)).bots, decodeBot),
    primary: async signal => decodeBot((await request('/api/harness/bots/primary', 'POST', undefined, signal)).bot),
    matters: {
      list: async (botId, signal) => array((await request(`${path(botId)}/matters`, 'GET', undefined, signal)).matters, decodeMatter),
      update: async input => decodeMatter((await request(`${path(input.botId)}/matters`, 'POST', input)).matter),
    },
    get: async (id, signal) => { const result = await request(path(id), 'GET', undefined, signal); return result.bot === null ? null : decodeBot(result.bot); },
    create: async (input = {}) => decodeBot((await request('/api/harness/bots', 'POST', input)).bot),
    update: async (id, patch) => decodeBot((await request(`${path(id)}/update`, 'POST', patch)).bot),
    archive: async id => decodeBot((await request(`${path(id)}/archive`, 'POST')).bot),
    remove: async id => { const result = await request(path(id), 'DELETE'); return result.bot === null ? null : decodeBot(result.bot); },
    changeState: async (id, action) => decodeBot((await request(`${path(id)}/${action}`, 'POST')).bot),
    entry: async (id, signal) => decodeBotEntryResult(await request(`${path(id)}/entry`, 'POST', undefined, signal)),
    work: async (id, signal) => array((await request(`${path(id)}/work`, 'GET', undefined, signal)).threads, decodeBotWork),
    activity: async (id, page = {}, signal) => {
      const query = new URLSearchParams();
      if (page.before !== undefined) query.set('before', String(page.before));
      if (page.limit !== undefined) query.set('limit', String(page.limit));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = decodeActivity(await request(`${path(id)}/activity${suffix}`, 'GET', undefined, signal));
      if (result.botId !== id) invalid();
      return result;
    },
    presence: async (id, signal) => {
      const presence = decodeBotPresence((await request(`${path(id)}/presence`, 'GET', undefined, signal)).presence);
      if (presence.botId !== id) invalid();
      return presence;
    },
    sessions: {
      list: async (id, signal) => array((await request(`${path(id)}/sessions`, 'GET', undefined, signal)).sessions, decodeBotSession),
      create: async id => decodeBotSession((await request(`${path(id)}/sessions`, 'POST')).session),
    },
    memory: {
      clearHistory: async (id, ids) => { await request(`${path(id)}/memory/history/clear`, 'POST', { ids }); },
      organize: async (id, input) => maintenanceJob((await request(`${path(id)}/memory-maintenance`, 'POST', input)).job),
      maintenance: async (id, signal) => array((await request(`${path(id)}/memory-maintenance`, 'GET', undefined, signal)).jobs, maintenanceJob),
      cancelMaintenance: async (id, key) => { await request(`${path(id)}/memory-maintenance/cancel`, 'POST', { key }); },
      restore: async (id, current, previous) => { await request(`${path(id)}/memory/${current.id}`, 'POST', { action: 'restore', previousId: previous.id, previousRevision: previous.revision, revision: current.revision }); },
      list: async (id, signal, includeInactive) => array((await request(`${path(id)}/memory${includeInactive ? '?includeInactive=true' : ''}`, 'GET', undefined, signal)).items, memoryItem),
      history: async (id, memoryId, signal) => array((await request(`${path(id)}/memory/${memoryId}/history`, 'GET', undefined, signal)).items, memoryItem),
      source: async (id, memoryId, signal) => array((await request(`${path(id)}/memory/${memoryId}/source`, 'GET', undefined, signal)).sources, sourceExcerpt),
      update: async (id, item, action, content) => { await request(`${path(id)}/memory/${item.id}`, 'POST', { action, revision: item.revision, content }); },
    },
  };
}
