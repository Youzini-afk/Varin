/** Self settings derive targets only from the already admitted Thread/Run.
 * These are facades over Bot and native model-selection owners, not a second
 * profile store, model selector or way to address arbitrary execution ids. */
import type { BotModelSelection, BotSummary, BotUpdateInput, ThreadsAPI } from '@varin/application-client';
import type { Run, RunModelSelection } from '@varin/protocol';
import { BotProfileConflictError, BotProfileMutationError, type BotService } from '../bots/bot-service.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { SettingsActionAdapter, SettingsActionContext, ActionInvocation } from './settings-actions.js';
import { HarnessServiceError } from './service-error.js';

export interface SelfSettingsDeps {
  runtime: Pick<AgentRuntimeClient, 'thread' | 'run' | 'modelSelections'>;
  bots: Pick<BotService, 'get' | 'update'>;
  threads: Pick<ThreadsAPI, 'selectModel'>;
  resolveBotModel(bot: BotSummary): Promise<BotModelSelection | null>;
}
const effect = 'Profile instructions and model apply to this Bot’s direct conversations at safe request boundaries; delegated work retains its own model. Name is immediate.';
const unavailable = (detail: string): ActionInvocation => ({ status: 'unavailable', mutation: 'none', detail });
const fail = (error: unknown, mutation: ActionInvocation['mutation'] = 'none'): ActionInvocation => ({ status: 'failed', mutation, detail: error instanceof Error ? error.message : String(error) });
const model = (configuration: unknown) => {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  const value = configuration as Record<string, unknown>;
  const options = value.modelOptions && typeof value.modelOptions === 'object' ? value.modelOptions as Record<string, unknown> : {};
  return { providerId: typeof value.providerId === 'string' ? value.providerId : null,
    modelId: typeof value.catalogModelId === 'string' ? value.catalogModelId : typeof value.model === 'string' ? value.model : null,
    thinkingLevel: typeof value.thinkingLevel === 'string' ? value.thinkingLevel : null,
    temperature: typeof options.temperature === 'number' ? options.temperature : null };
};
const selection = (value: RunModelSelection | null) => value ? {
  id: value.id, revision: value.revision, status: value.status, failure: value.failure, model: model(value.configuration),
} : null;
const profile = (bot: BotSummary) => ({ botId: bot.id, revision: bot.revision,
  saved: { name: bot.name, instructions: bot.instructions, model: bot.model } });
const readBotProfile = async (owner: SelfSettingsDeps, bot: BotSummary) => {
  try { return { ...profile(bot), effective: { model: await owner.resolveBotModel(bot) }, effect }; }
  catch (error) {
    return { ...profile(bot), effectiveUnavailable: error instanceof Error ? error.message : String(error), effect };
  }
};
const currentBot = async (owner: SelfSettingsDeps, ctx: SettingsActionContext) => {
  const thread = await owner.runtime.thread(ctx.caller.threadId, ctx.caller.signal);
  if (thread.thread_id !== ctx.caller.threadId || !thread.branches.some(branch => branch.branch_id === ctx.caller.branchId))
    throw new HarnessServiceError('not-found', 'The admitted Thread branch is unavailable');
  if (!thread.bot_id) return null;
  const bot = await owner.bots.get(thread.bot_id);
  if (!bot || bot.archived || bot.deletion) return null;
  return bot;
};
const currentRun = async (owner: SelfSettingsDeps, ctx: SettingsActionContext): Promise<Run> => {
  if (!ctx.caller.runId) throw new HarnessServiceError('unavailable', 'Current-conversation settings require an admitted native Run');
  const run = await owner.runtime.run(ctx.caller.runId, ctx.caller.signal);
  if (run.id !== ctx.caller.runId || run.thread_id !== ctx.caller.threadId || run.branch_id !== ctx.caller.branchId)
    throw new HarnessServiceError('not-found', 'The admitted Run does not belong to this Thread branch');
  return run;
};
const readConversation = async (owner: SelfSettingsDeps, ctx: SettingsActionContext) => {
  const run = await currentRun(owner, ctx);
  const selected = await owner.runtime.modelSelections(run.id, ctx.caller.signal);
  return { target: { threadId: run.thread_id, branchId: run.branch_id, runId: run.id }, runState: run.state,
    admitted: model(run.configuration), desired: selection(selected.desired), active: selection(selected.active),
    effect: 'A selection is staged for the next safe model-request boundary. Already accepted requests keep their original configuration. Bot profile and future-session defaults are unchanged.' };
};

export function createSelfBotAdapter(getOwner: () => SelfSettingsDeps | null | undefined): SettingsActionAdapter {
  return {
    verbs: ['read', 'update'],
    async describe(ctx) {
      const owner = getOwner(); if (!owner) return { unavailable: 'Bot profile owner is unavailable' };
      const bot = await currentBot(owner, ctx);
      if (!bot) return { unavailable: 'The admitted Thread is not bound to an active Bot' };
      return { summary: `Current Bot: ${bot.name}`, data: await readBotProfile(owner, bot) };
    },
    async invoke(ctx, entry, verb, args) {
      const owner = getOwner(); if (!owner) return unavailable('Bot profile owner is unavailable');
      let dispatched = false;
      try {
        const bot = await currentBot(owner, ctx);
        if (!bot) return unavailable('The admitted Thread is not bound to an active Bot');
        if (verb === 'read') return { status: 'applied', mutation: 'none', data: await readBotProfile(owner, bot) };
        if (verb !== 'update') return unavailable(`Unsupported self profile action: ${verb}`);
        // A narrow allowlist is defense in depth for direct non-tool callers;
        // the registry's executable schema also refuses target/authority ids.
        const patch: BotUpdateInput = { expectedRevision: args.expectedRevision as number,
          ...('name' in args ? { name: args.name as string } : {}),
          ...('instructions' in args ? { instructions: args.instructions as string | null } : {}),
          ...('model' in args ? { model: args.model as BotModelSelection | null } : {}) };
        if (!Number.isSafeInteger(patch.expectedRevision)) throw new HarnessServiceError('invalid-params', 'Read the Bot profile and supply expectedRevision');
        dispatched = true;
        const saved = await owner.bots.update(bot.id, patch);
        if (!saved) return unavailable('The Bot was archived or removed before the edit');
        return { status: 'applied', mutation: 'applied', data: { ...profile(saved), propagation: { state: 'ready' }, effect } };
      } catch (error) {
        if (error instanceof BotProfileMutationError) return { status: 'failed', mutation: 'applied', detail: error.message,
          data: { ...profile(error.bot), propagation: { state: 'unavailable', stage: error.stage, retry: 'Re-read this profile and retry the intended patch with its current revision.' }, effect } };
        return fail(error, error instanceof HarnessServiceError || error instanceof BotProfileConflictError ? 'none' : dispatched ? 'unknown' : 'none');
      }
    },
  };
}
export function createSelfConversationAdapter(getOwner: () => SelfSettingsDeps | null | undefined): SettingsActionAdapter {
  return {
    verbs: ['read', 'select-model'],
    async describe(ctx) {
      const owner = getOwner(); if (!owner) return { unavailable: 'Native model-selection owner is unavailable' };
      if (!ctx.caller.runId) return { unavailable: 'Current-conversation settings require an admitted native Run' };
      return { summary: 'Current Run model selection (desired and active)', data: await readConversation(owner, ctx) };
    },
    async invoke(ctx, _entry, verb, args) {
      const owner = getOwner(); if (!owner) return unavailable('Native model-selection owner is unavailable');
      let dispatched = false;
      try {
        if (verb === 'read') return { status: 'applied', mutation: 'none', data: await readConversation(owner, ctx) };
        if (verb !== 'select-model') return unavailable(`Unsupported current-conversation action: ${verb}`);
        const run = await currentRun(owner, ctx);
        if (!ctx.caller.operationId) return unavailable('Model selection requires the original admitted tool operation identity');
        if (['completed', 'failed', 'cancelled'].includes(run.state)) return unavailable('The admitted Run is terminal; select a model from an active conversation');
        dispatched = true;
        const selected = await owner.threads.selectModel({ runtime: 'agent', threadId: ctx.caller.threadId, branchId: ctx.caller.branchId,
          runId: run.id, key: `settings:${ctx.caller.operationId}`, model: args.model as Parameters<ThreadsAPI['selectModel']>[0]['model'] });
        return { status: selected.status === 'failed' ? 'failed' : 'applied', mutation: 'applied',
          data: { target: { threadId: run.thread_id, branchId: run.branch_id, runId: run.id }, selection: selection(selected),
            effect: 'Selection saved. It becomes active only at a safe model-request boundary; read this setting to observe desired and active state. Bot profile and future-session defaults are unchanged.' },
          ...(selected.failure ? { detail: selected.failure } : {}) };
      } catch (error) { return fail(error, dispatched ? 'unknown' : 'none'); }
    },
  };
}
