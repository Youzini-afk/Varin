import type { ThreadIdentity, ThreadNextStep } from '@varin/application-client';
import { resolveHarnessNextStepSettings, parseHarnessModelSlots } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ModelTextService } from './service.js';
import { buildNextStepContext, NEXT_STEP_SCHEMA, NEXT_STEP_SYSTEM } from './next-step-context.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ended = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
type Runtime = Pick<AgentRuntimeClient, 'thread' | 'run' | 'historyPage' | 'historyItem' | 'context' | 'activeOperations' | 'onEvent' | 'onReady' | 'onExit' | 'status' | 'events'>;

/** Suggestions are auxiliary requests bound to a committed conversation cut, never conversation inputs. */
export function createNextStepService(options: {
  runtime: Runtime;
  modelText: Pick<ModelTextService, 'prepareBudget' | 'original' | 'resumeUnsent'>;
  readSettings(): Promise<unknown>;
  onError(code: string): void;
}) {
  const pending = new Map<string, { branchId: string; runId: string; settingsKey?: string; controller: AbortController; promise: Promise<ThreadNextStep> }>();
  const settingsKey = (harness: Record<string, unknown>) => JSON.stringify([harness.nextStep, record(harness.models).nextStep]);
  let closed = false;
  const lifetime = new AbortController();
  const keyFor = (identity: ThreadIdentity, runId: string, headId: string) => `next-step:v1:${identity.threadId}:${identity.branchId}:${runId}:${headId}`;
  async function read(identity: ThreadIdentity, runId: string, headId: string): Promise<ThreadNextStep> {
    const key = keyFor(identity, runId, headId);
    if (closed) return { status: 'unavailable', code: 'next-step-closed' };
    const running = pending.get(key);
    if (running) return running.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const work = async (): Promise<ThreadNextStep> => {
      const current = async () => {
        const thread = await options.runtime.thread(identity.threadId, signal);
        const branch = thread.branches.find(branch => branch.branch_id === identity.branchId);
        return thread.deleted_at_ms === null && !thread.parent_thread_id && !thread.bot_id && branch?.head === headId
          && !branch.active_run_id && branch.latest_run?.id === runId && ended(branch.latest_run.state) ? branch.latest_run : null;
      };
      const harness = record(record(await options.readSettings()).harness);
      const originalWork = pending.get(key);
      if (originalWork) originalWork.settingsKey = settingsKey(harness);
      if (!resolveHarnessNextStepSettings(harness.nextStep).enabled) return { status: 'disabled' };
      const selected = parseHarnessModelSlots(harness.models).nextStep;
      if (selected?.enabled === false) return { status: 'disabled' };
      if (!selected?.providerId || !selected.modelId) return { status: 'unavailable', code: 'next-step-model-unconfigured' };
      const run = await current();
      if (!run) return { status: 'stale' };
      let result;
      // A reopened view reuses the original request, including its original prompt and binding.
      if (await options.modelText.original(key, signal)) {
        result = await options.modelText.resumeUnsent(key, signal);
        if (!result) return { status: 'unavailable', code: 'next-step-original-unfinished' };
      } else {
        const model = { providerId: selected.providerId, modelId: selected.modelId };
        const budget = await options.modelText.prepareBudget({ model, signal });
        try {
          const inputTokens = budget.contextTokens - (budget.outputTokens ?? 0);
          const prompt = await buildNextStepContext(options.runtime, { ...identity, runId, headId, state: run.state, inputTokens,
            count: texts => budget.count(texts) }, signal);
          if (!await current()) return { status: 'stale' };
          result = await budget.generate({ key, purpose: 'text', system: NEXT_STEP_SYSTEM, prompt, responseSchema: NEXT_STEP_SCHEMA, signal });
        } finally { await budget.release(); }
      }
      signal.throwIfAborted();
      if (!await current()) return { status: 'stale' };
      const value = record(JSON.parse(result.text));
      if (value.suggestion === null || typeof value.suggestion === 'string' && !value.suggestion.trim()) return { status: 'empty' };
      if (typeof value.suggestion !== 'string') throw Object.assign(new Error('Invalid next-step response'), { code: 'next-step-response-invalid' });
      return { status: 'ready', runId, headId, text: value.suggestion.trim() };
    };
    const promise = work().catch((error: unknown): ThreadNextStep => {
      if (signal.aborted) return { status: 'stale' };
      const code = typeof record(error).code === 'string' ? String(record(error).code) : 'next-step-generation-failed';
      options.onError(code);
      return { status: 'unavailable', code };
    }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
    pending.set(key, { branchId: identity.branchId, runId, controller, promise });
    return promise;
  }

  // Read durable Run facts once per cursor. Generation never blocks the event reader or main Run.
  let cursor: number | undefined;
  let notified = 0;
  let firstNotification: number | undefined;
  let epoch = 0;
  let pumping = false;
  let initializing: Promise<void> | undefined;
  async function pump() {
    if (closed || pumping || cursor === undefined) return;
    pumping = true;
    const generation = epoch;
    try {
      while (!closed && generation === epoch && cursor !== undefined && cursor < notified) {
        const events = await options.runtime.events(cursor, 256, lifetime.signal);
        if (generation !== epoch || !events.length) break;
        for (const event of events) {
          cursor = event.cursor;
          if (event.kind !== 'run.changed' && event.kind !== 'run.accepted') continue;
          const run = event.kind === 'run.accepted' ? record(await options.runtime.run(event.subject, lifetime.signal)) : record(event.data);
          if (typeof run.thread_id !== 'string' || !run.thread_id.startsWith('thread:') || typeof run.branch_id !== 'string') continue;
          if (!ended(String(run.state))) {
            for (const work of pending.values()) if (work.branchId === run.branch_id && work.runId !== event.subject) work.controller.abort();
            continue;
          }
          const thread = await options.runtime.thread(run.thread_id, lifetime.signal);
          const branch = thread.branches.find(branch => branch.branch_id === run.branch_id);
          if (branch?.head && branch.latest_run?.id === event.subject && !branch.active_run_id && !thread.parent_thread_id && !thread.bot_id) {
            void read({ runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id }, event.subject, branch.head);
          }
        }
      }
    } catch { if (!closed) options.onError('next-step-observation-failed'); }
    finally { pumping = false; }
  }
  function initialize() {
    if (closed || initializing || cursor !== undefined) return;
    const generation = epoch;
    initializing = options.runtime.status(lifetime.signal).then(status => {
      if (generation !== epoch || closed) return;
      cursor = Math.min(status.eventCursor, firstNotification === undefined ? status.eventCursor : firstNotification - 1);
      notified = Math.max(notified, status.eventCursor);
      void pump();
    }).catch(() => { if (!closed) options.onError('next-step-observation-failed'); }).finally(() => { initializing = undefined; });
  }
  const removers = [options.runtime.onEvent(event => {
    if (event.stream !== 'durable') return;
    firstNotification ??= event.cursor; notified = Math.max(notified, event.cursor);
    if (cursor === undefined) initialize(); else void pump();
  }), options.runtime.onReady(initialize), options.runtime.onExit(() => {
    epoch++; cursor = undefined; notified = 0; firstNotification = undefined;
    for (const work of pending.values()) work.controller.abort();
  })];
  initialize();
  return {
    read,
    async settingsChanged() {
      try {
        const key = settingsKey(record(record(await options.readSettings()).harness));
        for (const work of pending.values()) if (work.settingsKey && work.settingsKey !== key) work.controller.abort();
      } catch { if (!closed) options.onError('next-step-settings-unavailable'); }
    },
    async close() {
      closed = true; lifetime.abort(); removers.forEach(remove => remove());
      await Promise.allSettled([...pending.values()].map(work => work.promise));
      await initializing;
    },
  };
}
export type NextStepService = ReturnType<typeof createNextStepService>;
