import { describe, expect, it, vi } from 'vitest';
import { createBotGroupChats } from './bot-group-chat.js';

const events = vi.hoisted(() => ({ emit: (_event: unknown) => true }));
vi.mock('../kernel/event-hub.js', () => ({ threadEventHub: () => ({
  subscribe: (_cursor: number, _principal: unknown, emit: typeof events.emit) => { events.emit = emit; return () => {}; },
}) }));

function fixture() {
  type Stored = { recordType: string; recordRevision: number; payloadJson: string };
  const records = new Map<string, Stored>();
  const bots = new Map([['ops', { name: 'Ops' }], ['qa', { name: 'QA' }]]);
  const sleeping = new Set<string>();
  const state = new Map<string, string>();
  const core = {
    createBotThread: vi.fn(),
    thread: vi.fn(async (id: string) => ({ branches: [{ branch_id: id.replace(/^thread:/, 'branch:'), head: null, active_run_id: null }] })),
    run: vi.fn(async (id: string) => ({ id, state: state.get(id) })),
    historyPage: vi.fn(async ({ branchId }: { branchId: string }) => ({ head: 'answer', items: [...state].filter(([, value]) => value === 'completed')
      .map(([run_id]) => ({ run_id, source: 'assistant', branchId })) })),
    historyItem: vi.fn(async () => ({ content: { content: { kind: 'text', text: 'The image is ready.' } } })),
    sendMessage: vi.fn(async () => ({ messageId: 'native-handoff' })),
    getMessage: vi.fn(async () => ({ state: 'queued', activation: { state: 'pending' } })),
    followups: vi.fn(async () => []),
    status: vi.fn(async () => ({ eventCursor: 0 })),
    onReady: vi.fn(() => () => {}),
  };
  const submit = vi.fn(async ({ threadId, key }: { threadId: string; key: string }) => {
    const run_id = threadId + ':' + key;
    state.set(run_id, 'generating');
    return { run_id };
  });
  const options = {
    client: async () => ({
      getRecord: async (_workspace: string, id: string) => records.get(id) ?? null,
      listRecords: async () => ({ records: [...records.values()], nextCursor: null }),
      putRecord: async (params: { recordId: string; expectedRecordRevision?: number; recordType: string; payloadJson: string }) => {
        const previous = records.get(params.recordId);
        expect(params.expectedRecordRevision).toBe(previous?.recordRevision);
        const row = { recordType: params.recordType, payloadJson: params.payloadJson, recordRevision: (previous?.recordRevision ?? 0) + 1 };
        records.set(params.recordId, row);
        return row;
      },
    }),
    workspaceId: 'test-bots',
    bots: { get: async (id: string) => bots.get(id) ?? null, canExecute: async (id: string) => !sleeping.has(id), wake: async (id: string) => sleeping.delete(id) },
    runtime: core, threads: { submit }, model: async () => ({ providerId: 'test', modelId: 'fixture' }),
    changed: vi.fn(), onError: (error: unknown) => { throw error; },
  } as unknown as Parameters<typeof createBotGroupChats>[0];
  return { groups: createBotGroupChats(options), options, submit, state, sleeping, core };
}

describe('Bot group chat delivery', () => {
  it('keeps ordinary posts searchable, honors address precedence and recovers the settled reply', async () => {
    const { groups, options, submit, state } = fixture();
    const { id } = await groups.create('user', 'Release', ['ops', 'qa']);
    await groups.post('user', id, { id: 'note', text: 'Windows first', addressed: [] });
    expect((await groups.page('user', id, undefined, 'windows')).posts[0]?.delivery).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(await groups.list('another-user')).toEqual([]);

    await groups.change('user', id, { kind: 'listen', botId: 'qa', enabled: true }, 'bot');
    await groups.post('user', id, { id: 'request', text: 'Build the image', addressed: ['ops', 'ops'] });
    await groups.post('user', id, { id: 'request', text: 'Build the image', addressed: ['ops', 'ops'] });
    await expect.poll(async () => (await groups.page('user', id)).posts.at(-1)?.delivery[0]?.state).toBe('running');
    expect(submit).toHaveBeenCalledTimes(1);

    const runId = [...state.keys()][0]!;
    state.set(runId, 'completed');
    const reopened = createBotGroupChats(options);
    const stop = reopened.start();
    try {
      await expect.poll(async () => (await reopened.page('user', id)).posts.at(-1)?.text).toBe('The image is ready.');
      const group = await reopened.page('user', id);
      expect(group.posts.at(-1)?.quoteId).toBe('user:request');
      expect(group.posts.at(-1)?.author).toEqual({ kind: 'bot', botId: 'ops', name: 'Ops' });
      await reopened.post('user', id, { id: 'reply', text: 'Package is public', addressed: [], quoteId: group.posts.at(-1)!.id, reply: true });
      expect((await reopened.page('user', id)).posts.at(-1)?.delivery.map(value => value.botId)).toEqual(['ops']);
    } finally { stop(); }
  });

  it('wakes and retries only the sleeping member of a multi-recipient post', async () => {
    const { groups, submit, sleeping } = fixture();
    sleeping.add('ops');
    const { id } = await groups.create(null, 'Release', ['ops', 'qa']);
    await groups.post(null, id, { id: 'request', text: 'Look at this', addressed: ['ops', 'qa'] });
    const deliveries = async () => (await groups.page(null, id)).posts[0]?.delivery.map(value => value.state);
    await expect.poll(deliveries).toEqual(['asleep', 'running']);
    await groups.change(null, id, { kind: 'retry', postId: 'user:request', botId: 'ops' });
    await expect.poll(deliveries).toEqual(['running', 'running']);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('sends a Bot handoff through native collaboration while sharing the same post with the room', async () => {
    const { groups, core, submit } = fixture();
    const { id } = await groups.create('user', 'Release', ['ops', 'qa']);
    await groups.botPost('user', id, 'ops', { threadId: 'ops-thread', branchId: 'ops-main', operationId: 'original-tool' },
      'The expected digest changed.', undefined, ['qa'], true);
    await expect.poll(async () => (await groups.page('user', id)).posts[0]?.delivery[0]?.state).toBe('informed');
    expect(core.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      senderThreadId: 'ops-thread', senderGroupOperationId: 'original-tool', kind: 'inform',
    }));
    expect(submit).not.toHaveBeenCalled();
  });
});
