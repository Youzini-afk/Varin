import { expect, it, vi } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelClientError } from '../kernel/kernel-error.js';
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
