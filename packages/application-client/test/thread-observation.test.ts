import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadObservationBus } from '../src/thread-observation.js';
import type { ThreadObservationEvent } from '../src/thread-observation.js';
import type { ThreadsAPI } from '../src/threads.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const event = (cursor: number, thread_id: string, kind = 'run.changed', branch_id = 'main'): ThreadObservationEvent =>
  ({ cursor, thread_id, branch_id, subject: 'run', kind, revision: cursor, data: {} });
function transport() {
  const connections: { cursor: number | null; listener: (event: ThreadObservationEvent) => void; options: Parameters<ThreadsAPI['observe']>[2]; close(): void }[] = [];
  let open = 0, maximum = 0;
  const observe: ThreadsAPI['observe'] = (cursor, listener, options) => new Promise<void>(resolve => {
    open++; maximum = Math.max(maximum, open);
    let closed = false;
    const close = () => { if (!closed) { closed = true; open--; resolve(); } };
    connections.push({ cursor, listener, options, close });
    options.signal.addEventListener('abort', close, { once: true });
    options.onReady?.();
  });
  return { api: { observe }, connections, maximum: () => maximum };
}

test('one shared connection routes durable scopes, kinds and branch-independent thread changes', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api), a: ThreadObservationEvent[] = [], b: ThreadObservationEvent[] = [];
  const stopA = bus.subscribe({ threadId: 'a', branchId: 'main', kinds: ['run.*', 'thread.*'] }, value => a.push(value));
  const stopB = bus.subscribe({ threadId: 'b', kinds: ['run.changed'] }, value => b.push(value));
  for (let i = 0; i < 20; i++) bus.subscribe({ threadId: `background-${i}`, kinds: ['usage.updated'] }, () => {});
  await tick();
  assert.equal(t.connections.length, 1);
  a.length = 0; b.length = 0;
  assert.deepEqual(t.connections[0]!.options.threadIds, []);
  const send = t.connections[0]!.listener;
  send(event(1, 'a')); send(event(2, 'b')); send(event(3, 'a', 'history.appended')); send(event(4, 'a', 'run.changed', 'other'));
  send({ ...event(5, 'a', 'thread.read'), branch_id: null } as ThreadObservationEvent);
  assert.equal(a.length, 2); assert.equal(b.length, 1);
  assert.equal(t.maximum(), 1);
  stopA(); stopB(); bus.close();
});

test('interest changes keep the cursor without globally resyncing existing views', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api), a: ThreadObservationEvent[] = [];
  bus.subscribe({ threadId: 'a' }, value => a.push(value)); await tick(); a.length = 0;
  t.connections[0]!.listener(event(9, 'a'));
  const stop = bus.subscribe({ threadId: 'b' }, () => {}); await tick(); await tick();
  assert.equal(t.connections.length, 2); assert.equal(t.connections[1]!.cursor, 9);
  assert.deepEqual(t.connections[1]!.options.threadIds, ['a', 'b']);
  assert.equal(a.length, 1); assert.equal(t.maximum(), 1);
  t.connections[1]!.listener(event(9, 'a')); assert.equal(a.length, 1);
  stop(); bus.close();
});

test('explicit reset permits lower cursors and is delivered despite kind or scope filters', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api), seen: ThreadObservationEvent[] = [];
  bus.subscribe({ threadId: 'a', kinds: ['run.changed'] }, value => seen.push(value)); await tick(); seen.length = 0;
  const send = t.connections[0]!.listener;
  send(event(100, 'a'));
  send({ stream: 'resync', cursor: 0, kernelEpoch: 'new', reason: 'catalog-replaced' });
  send(event(1, 'a'));
  assert.equal(seen.length, 3); assert.equal('stream' in seen[1]! && seen[1].stream, 'resync');
  bus.close();
});

test('quiet reconnect refreshes after headers, and never opens concurrent transports', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api), seen: ThreadObservationEvent[] = [];
  bus.subscribe({ threadId: 'a' }, value => seen.push(value)); await tick(); seen.length = 0;
  t.connections[0]!.listener(event(8, 'a')); t.connections[0]!.close(); await tick();
  assert.equal('stream' in seen.at(-1)! && (seen.at(-1) as { reason: string }).reason, 'connection-lost');
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(t.connections[1]!.cursor, 8);
  assert.equal('stream' in seen.at(-1)! && (seen.at(-1) as { reason: string }).reason, 'connection-restored');
  assert.equal(t.maximum(), 1); bus.close();
});

test('mutates interests on the existing live transport and coalesces updates without a second connection', async () => {
  const t = transport(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const updates: Array<{ observationId: string; threadIds: readonly string[] | null }> = [];
  const api = { ...t.api, updateObservationInterests: async (input: typeof updates[number]) => { updates.push(input); if (updates.length === 1) await pending; } };
  const bus = new ThreadObservationBus(api), seen: ThreadObservationEvent[] = [];
  bus.subscribe({ threadId: 'a' }, value => seen.push(value)); await tick(); seen.length = 0;
  const removeB = bus.subscribe({ threadId: 'b' }, () => {}); await tick();
  const removeC = bus.subscribe({ threadId: 'c' }, () => {}); await tick();
  assert.equal(t.connections.length, 1); assert.equal(updates.length, 1);
  t.connections[0]!.listener(event(1, 'a'));
  removeB(); release(); await tick();
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1]!.threadIds, ['a', 'c']);
  assert.equal(updates[0]!.observationId, t.connections[0]!.options.observationId);
  assert.equal(seen.length, 1); assert.equal(t.connections.length, 1); assert.equal(t.maximum(), 1);
  removeC(); bus.close();
});

test('records unobserved child changes for a parent discovering that child during its snapshot', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api);
  bus.subscribe({ threadId: 'parent', kinds: ['run.*'] }, () => {}); await tick();
  t.connections[0]!.listener(event(12, 'new-child'));
  assert.equal(bus.getThreadCursor('new-child'), 12);
  t.connections[0]!.listener(event(13, 'new-child', 'thread.read'));
  assert.equal(bus.getThreadCursor('new-child'), 12);
  bus.close();
});

test('message notifications reach both original sender and recipient branches without generic body inference', async () => {
  const t = transport(), bus = new ThreadObservationBus(t.api), sender: ThreadObservationEvent[] = [], recipient: ThreadObservationEvent[] = [], other: ThreadObservationEvent[] = [];
  bus.subscribe({ threadId: 'sender', branchId: 'sending', kinds: ['message.*'] }, value => sender.push(value));
  bus.subscribe({ threadId: 'target', branchId: 'receiving', kinds: ['message.*'] }, value => recipient.push(value));
  bus.subscribe({ threadId: 'sender', branchId: 'other', kinds: ['message.*'] }, value => other.push(value));
  await tick(); sender.length = 0; recipient.length = 0; other.length = 0;
  t.connections[0]!.listener({ ...event(1, 'target', 'message.accepted', 'receiving'), data: { senderThreadId: 'sender', senderBranchId: 'sending', targetThreadId: 'target', targetBranchId: 'receiving' } });
  assert.equal(sender.length, 1); assert.equal(recipient.length, 1); assert.equal(other.length, 0);
  assert.equal(bus.getThreadCursor('sender'), 1); bus.close();
});
