import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import type { BotScopeView } from '../kernel/protocol.generated.js';
import { createBotPresencePublisher, projectBotPresence } from './bot-presence.js';

const bot = { id: 'bot', name: 'Muse', archived: false } as BotSummary;
const thread = (id: string, parent: string | null, run: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  thread_id: id, title: id === 'session' ? '' : `Title ${id}`, parent_thread_id: parent, deleted_at_ms: null,
  branches: [{ branch_id: `${id}-main`, active_run_id: run ? String(run.id) : null, latest_run: run }], ...extra,
});
const run = (id: string, state: string, waiting_on: string | null = null, cancel_requested = false) => ({ id, state, waiting_on, cancel_requested });
const scope = (threads: ReturnType<typeof thread>[]) => ({ botId: 'bot', sessions: ['session'], runs: [], threads }) as unknown as BotScopeView;

describe('Bot presence', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('separates waiting for the user from running, stopping and finished work', () => {
    const presence = projectBotPresence(bot, scope([
      thread('session', null, run('s', 'generating')),
      thread('asks', 'session', run('a', 'waiting', 'permission:write')),
      thread('grandchild', 'asks', run('g', 'executing')),
      thread('stopping', 'session', run('x', 'waiting', 'question:q', true)),
      thread('done', 'session', run('d', 'completed')),
      thread('gone', 'session', run('r', 'generating'), { deleted_at_ms: 5 }),
    ]));
    expect(presence.replying).toEqual(['session']);
    expect(presence.needs).toEqual([{ identity: { runtime: 'agent', threadId: 'asks', branchId: 'asks-main' }, name: 'Title asks', avatar: null, kind: 'permission', session: false }]);
    // Asked to stop is still running until it stops; nested work reports to the session that started its ancestry.
    expect(presence.working.map(item => [item.identity.threadId, item.sessionThreadId])).toEqual([['grandchild', 'session'], ['stopping', 'session']]);
  });

  it('publishes once per change and keeps the last projection when a read fails', async () => {
    vi.useFakeTimers();
    let current = scope([thread('session', null, null)]);
    let failing = false;
    const publish = vi.fn(); const onError = vi.fn();
    const publisher = createBotPresencePublisher({
      bots: async () => [bot, { ...bot, id: 'archived', archived: true }],
      scope: async () => { if (failing) throw new Error('kernel unavailable'); return current; },
      publish, onError, delayMs: 10,
    });
    publisher.schedule(); publisher.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(1);
    publisher.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(1);
    current = scope([thread('session', null, run('s', 'waiting', 'question:q'))]);
    failing = true; publisher.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    failing = false; publisher.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({ botId: 'bot', needs: [{ kind: 'question', session: true, name: 'Muse' }] });
    publisher.dispose();
  });
});
