import { expect, it } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import type { BotScopeView } from '../kernel/protocol.generated.js';
import { projectPublicBotProfile } from './bot-public-profile.js';
it('projects shared lifecycle state without disclosing foreign execution handles or mutating its owner', () => {
  const bot = { id: 'bot', entry: { threadId: 'original-shared-entry' }, activity: {
    state: 'sleep-failed', operationId: 'shared-lifecycle', planned: true, machines: [], error: 'Foreign task details',
    work: [{ threadId: 'mine', runId: 'mine-run' }, { threadId: 'foreign', runId: 'secret-run' }],
    execution: { currentKernelWorkersDrained: false, unknownEffectOperationIds: ['secret-operation'] },
  } } as unknown as BotSummary;
  const scope = { threads: [{ thread_id: 'mine' }], runs: [{ runId: 'mine-run' }] } as BotScopeView;
  const result = projectPublicBotProfile(bot, scope);
  expect(result.activity).toMatchObject({ state: 'sleep-failed', operationId: 'shared-lifecycle', work: [{ threadId: 'mine', runId: 'mine-run' }] });
  expect(result.activity).not.toHaveProperty('execution'); expect(result.activity?.error).not.toContain('Foreign');
  expect(result.entry).toBe(bot.entry); expect(bot.activity?.work).toHaveLength(2);
  expect(projectPublicBotProfile(bot).activity?.work).toEqual([]);
});
