import type { BotSummary } from '@varin/application-client';
import type { BotScopeView } from '../kernel/protocol.generated.js';

/** Shared Bot configuration remains shared; execution details require the caller's Catalog scope. */
export function projectPublicBotProfile(bot: BotSummary, scope?: BotScopeView): BotSummary {
  const threads = new Set(scope?.threads.map(thread => thread.thread_id) ?? []);
  const runs = new Set(scope?.runs.map(run => run.runId) ?? []);
  const activity = bot.activity;
  const { execution: _execution, ...publicActivity } = activity ?? {};
  return { ...bot, ...(activity ? { activity: {
    ...publicActivity,
    state: activity.state, operationId: activity.operationId, planned: activity.planned, machines: activity.machines,
    work: activity.work.filter(work => threads.has(work.threadId) && runs.has(work.runId)),
    // These diagnostic IDs have no Thread attribution in the profile record. Do not
    // mistake a shared lifecycle record for authority to disclose execution handles.
    error: activity.error ? 'The Bot lifecycle needs attention. Retry its current operation.' : null,
  } } : {}), ...(bot.deletion ? { deletion: { ...bot.deletion,
    error: bot.deletion.error ? 'Bot cleanup needs attention. Retry its deletion.' : null,
  } } : {}) };
}
