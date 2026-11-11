import { expect, it, vi } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelClientError } from '../kernel/kernel-error.js';
import { withRequestPrincipal } from '../kernel/request-principal.js';
import { createBotSessions } from './bot-sessions.js';

const bot: BotSummary = {
  id: 'bot', name: 'Varin', coordinatorHostId: 'host', homeDir: '/bots/bot', revision: 1,
  createdAt: '', updatedAt: '', archived: false, instructions: null, model: null,
  entry: { runtime: 'agent', threadId: 'original', branchId: 'original-main' },
};
function fixture() {
  const request = vi.fn();
  const runtime = new AgentRuntimeClient({
    agentRuntimeRequest: request, subscribeExit: vi.fn(), onToolReleased: vi.fn(),
  } as unknown as KernelClient);
  return { request, sessions: createBotSessions(() => runtime) };
}

it.each([
  { threadId: 'original', branchId: 'original-main' },
  { threadId: 'surviving', branchId: 'surviving-main' },
  { threadId: 'fresh', branchId: 'fresh-main' },
])('returns the Catalog-resolved entry through the real runtime client: $threadId', async identity => {
  const { request, sessions } = fixture();
  request.mockResolvedValue(identity);
  expect(await sessions.ensureEntry(bot)).toEqual({ runtime: 'agent', ...identity });
  expect(request.mock.calls).toEqual([[
    'runtime.bot.entry.resolve', { botId: 'bot', threadId: 'original', branchId: 'original-main' }, undefined,
  ]]);
  expect(bot.entry).toEqual({ runtime: 'agent', threadId: 'original', branchId: 'original-main' });
});

it.each(['identity-unavailable', 'not-found', 'storage-error', 'unauthorized', 'activation-held', 'transport-error'])(
  'preserves %s without a read/create fallback or retry', async code => {
    const { request, sessions } = fixture();
    const error = new KernelClientError({ code, message: 'Original result is unavailable' });
    request.mockRejectedValue(error);
    await expect(sessions.ensureEntry(bot)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('runtime.bot.entry.resolve');
  },
);

it('reopens with the original profile identity after an unknown response', async () => {
  const { request, sessions } = fixture();
  const unknown = new Error('Connection lost after admission');
  request.mockRejectedValueOnce(unknown).mockResolvedValueOnce({ threadId: 'accepted', branchId: 'accepted-main' });
  await expect(sessions.ensureEntry(bot)).rejects.toBe(unknown);
  expect(await sessions.ensureEntry(bot)).toEqual({ runtime: 'agent', threadId: 'accepted', branchId: 'accepted-main' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
});


it('passes trusted request ownership and the selected container through the real Bot creation RPC', async () => {
  const { request, sessions } = fixture();
  const identity = { runtime: 'agent' as const, threadId: 'session', branchId: 'main' };
  request.mockImplementation(async (method: string) => method === 'runtime.bot.thread.create' ? identity : { thread_id: 'session', main_branch_id: 'main' });
  await withRequestPrincipal('alice', () => sessions.createSession(bot, identity, { containerId: 'release' }));
  expect(request.mock.calls[0]).toEqual(['runtime.bot.thread.create', { botId: 'bot', threadId: 'session', branchId: 'main', principalId: 'alice', organization: { containerId: 'release' } }, undefined]);
});

it('scopes public and authenticated session reads without narrowing background lifecycle scope', async () => {
  const { request, sessions } = fixture(); request.mockResolvedValue({ sessions: [], threads: [], runs: [] });
  await withRequestPrincipal('alice', () => sessions.listSessions(bot));
  expect(request.mock.calls.at(-1)?.[1]).toEqual({ botId: 'bot', historyOnly: true, principalId: 'alice' });
  await withRequestPrincipal(null, () => sessions.listSessions(bot));
  expect(request.mock.calls.at(-1)?.[1]).toEqual({ botId: 'bot', historyOnly: true, principalId: null });
  await sessions.listSessions(bot);
  expect(request.mock.calls.at(-1)?.[1]).toEqual({ botId: 'bot', historyOnly: true });
});
