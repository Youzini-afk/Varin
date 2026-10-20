import { expect, it, vi } from 'vitest';
import type { ThreadsAPI, ThreadIdentity } from '@varin/application-client';
import type { FamilyMember, MessageFeedEntry, RuntimeEvent } from '@varin/protocol';
import { CollaborationFeed } from './collaborationFeed';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'root', branchId: 'root-branch' };
const message = (id: number): MessageFeedEntry => ({
  messageId: `message-${id}`,
  senderThreadId: 'worker',
  senderBranchId: 'worker-branch',
  targetThreadId: 'reviewer',
  targetBranchId: 'reviewer-branch',
  actor: { kind: 'user' },
  kind: 'request',
  replyTo: null,
  acceptedCursor: id,
  acceptedAtMs: id,
  state: 'queued',
  activation: { state: 'pending', executionId: null, holdReason: null },
  replyWait: null,
  deliveredCursor: null,
  deliveredRunId: null,
  text: `body-${id}`,
});
function fixture() {
  const records = [message(1), message(2), message(3)];
  let listener: (event: RuntimeEvent) => void = () => {};
  const member = (id: string, current = true): FamilyMember => ({
    threadId: id,
    name: id,
    agentId: id,
    parentThreadId: id === 'root' ? null : 'root',
    task: null,
    state: 'running',
    current,
    branches: [{ branchId: `${id}-branch`, headId: null, activeRunId: 'run', latestRun: null }],
  });
  const api = {
    messages: {
      feed: vi.fn<NonNullable<ThreadsAPI['messages']>['feed']>(async (_identity, request) => {
        const matching = records.filter((item) =>
          request.before !== undefined
            ? item.acceptedCursor < request.before
            : request.after !== undefined
              ? item.acceptedCursor > request.after
              : true,
        );
        const selected = request.after !== undefined ? matching.slice(0, 2) : matching.slice(-2);
        return {
          rootThreadId: 'root',
          messages: structuredClone(selected),
          participants: ['worker', 'reviewer'].map((threadId) => ({
            threadId,
            name: threadId,
            agentId: threadId,
            avatar: null,
          })),
          before: request.after === undefined && matching.length > 2 ? selected[0]!.acceptedCursor : null,
          after: request.after !== undefined && matching.length > 2 ? selected.at(-1)!.acceptedCursor : null,
          eventCursor: records.at(-1)!.acceptedCursor,
        };
      }),
      get: vi.fn(async (_identity: ThreadIdentity, id: string) =>
        structuredClone(records.find((item) => item.messageId === id)!),
      ),
    },
    family: {
      list: vi.fn(async (_identity: ThreadIdentity, options: { scope: string; query?: string }) => ({
        rootThreadId: 'root',
        nextCursor: null,
        members: options.query ? [member(options.query, false)] : [member('worker'), member('reviewer')],
      })),
    },
    observe: vi.fn<ThreadsAPI['observe']>(async (_cursor, next, { signal }) => {
      listener = next;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }),
  };
  return { api: api as unknown as ThreadsAPI, records, readers: api, emit: (event: RuntimeEvent) => listener(event) };
}
it('keeps peer messages, prepended history and new pages in one ordered feed, while refreshing original delivery state', async () => {
  const f = fixture();
  const feed = new CollaborationFeed(f.api, identity);
  await feed.start();
  expect(feed.getSnapshot().messages.map((item) => item.messageId)).toEqual(['message-2', 'message-3']);
  expect(feed.getSnapshot().members.find((member) => member.threadId === 'root')?.detail?.branches[0]?.branchId).toBe(
    'root-branch',
  );
  await feed.earlier();
  f.records.push(message(4), message(5), message(6));
  f.records[0]!.state = 'delivered';
  f.emit({ cursor: 6, subject: 'message-6', revision: 1, kind: 'message.accepted', data: {} });
  f.emit({ cursor: 7, subject: 'message-1', revision: 2, kind: 'message.delivered', data: {} });
  await vi.waitFor(() => expect(feed.getSnapshot().messages).toHaveLength(6));
  await vi.waitFor(() => expect(feed.getSnapshot().messages[0]!.state).toBe('delivered'));
  expect(f.readers.messages.get).toHaveBeenCalledWith(
    { runtime: 'agent', threadId: 'worker', branchId: 'worker-branch' },
    'message-1',
    expect.any(AbortSignal),
  );
  expect(feed.getSnapshot().messages.map((item) => item.acceptedCursor)).toEqual([1, 2, 3, 4, 5, 6]);
  feed.close();
});
it('does not publish an old page after its panel closes', async () => {
  const f = fixture();
  const feed = new CollaborationFeed(f.api, identity);
  await feed.start();
  let resolve!: (page: Awaited<ReturnType<NonNullable<ThreadsAPI['messages']>['feed']>>) => void;
  f.readers.messages.feed.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = feed.earlier();
  const before = feed.getSnapshot();
  feed.close();
  resolve({
    rootThreadId: 'another',
    messages: [message(99)],
    participants: [],
    before: null,
    after: null,
    eventCursor: 99,
  });
  await pending;
  expect(feed.getSnapshot()).toBe(before);
  expect(f.readers.observe.mock.calls[0]![2].signal.aborted).toBe(true);
});

it('keeps the actual terminal state when a member leaves the current directory', async () => {
  const f = fixture();
  const feed = new CollaborationFeed(f.api, identity);
  await feed.start();
  const directory = f.readers.family.list.getMockImplementation()!;
  f.readers.family.list.mockImplementation(async (identity, options) => {
    const page = await directory(identity, options);
    return options.query === 'worker'
      ? { ...page, members: page.members.map((member) => ({ ...member, current: false, state: 'completed' })) }
      : { ...page, members: page.members.filter((member) => member.threadId !== 'worker') };
  });
  f.emit({ cursor: 9, subject: 'run-worker', revision: 2, kind: 'run.completed', data: {} });
  await vi.waitFor(() =>
    expect(feed.getSnapshot().members.find((member) => member.threadId === 'worker')?.detail).toMatchObject({
      current: false,
      state: 'completed',
    }),
  );
  expect(feed.getSnapshot().messages).toHaveLength(2);
  feed.close();
});
