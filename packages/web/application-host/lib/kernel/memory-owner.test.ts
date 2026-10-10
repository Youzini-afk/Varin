import { expect, it } from 'vitest';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import type { KernelClient, KernelScopedClient } from './kernel-client.js';
import { createMemoryOwner, type MemoryQuery } from './memory-owner.js';
import type { ContextPreparer } from './thread-context.js';

/** Storage primitives are a fixture. The ordinary personalization and private tool owners are real. */
function storageFixture() {
  type RecordValue = Awaited<ReturnType<KernelScopedClient['putRecord']>>;
  let current: RecordValue | null = null;
  const operations = new Map<string, { kind: string; state: string; result: RecordValue }>();
  let writes = 0;
  const scoped = {
    getRecord: async () => current && structuredClone(current),
    getOperation: async (id: string) => structuredClone(operations.get(id) ?? null),
    putRecord: async (input: Parameters<KernelScopedClient['putRecord']>[0]) => {
      if (input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== current?.recordRevision) throw new Error('record revision conflict');
      current = { ...input, recordRevision: (current?.recordRevision ?? 0) + 1, createdAt: 1, updatedAt: 1 };
      operations.set(input.operationId, { kind: 'storage.record.put', state: 'committed', result: structuredClone(current) });
      writes++;
      return structuredClone(current);
    },
  };
  return { client: { issueGrant: async () => ({}), scoped: () => scoped } as unknown as KernelClient, writes: () => writes };
}

it('child ordinary memory resolves self, preserves shared scopes and reconciles original receipts after a user edit', async () => {
  const storage = storageFixture();
  const open = () => createAgentPersonalization({ client: storage.client, context: async id => ({ bot: id === 'bot', projectId: 'project-a', threadRole: id === 'parent' ? 'main' : 'worker' }) });
  let personalization = open();
  await personalization.saveNote({ scope: { kind: 'global' }, content: 'Shared global' });
  await personalization.saveNote({ scope: { kind: 'project', id: 'project-a' }, content: 'Shared project' });
  const parent = await personalization.saveNote({ scope: { kind: 'session', id: 'parent' }, content: 'Parent private' });
  await personalization.saveNote({ scope: { kind: 'session', id: 'sibling' }, content: 'Sibling private' });
  await personalization.saveNote({ scope: { kind: 'project', id: 'project-b' }, content: 'Foreign project' });
  const prepareContext = Object.assign(async () => { throw new Error('No context synchronization in this owner test'); },
    { main: async () => { throw new Error('No main context'); } }) as ContextPreparer;
  let owner = createMemoryOwner({ personalization, prepareContext });
  const scope = { mode: 'agent' as const, sessionId: 'child', projectId: 'project-a' };
  const read = (args: MemoryQuery['arguments'] = { action: 'read' }) => owner({ action: 'tool', runId: 'child-run', scope, arguments: args }, new AbortController().signal);
  const visible = await read();
  expect(visible).toMatchObject({ status: 'ready', revision: 5, notes: [
    expect.objectContaining({ content: 'Shared global' }), expect.objectContaining({ content: 'Shared project' }),
  ] });
  expect(await read({ action: 'read', scope: 'currentThread' })).toMatchObject({ status: 'ready', notes: [] });
  const query: MemoryQuery = { action: 'tool', runId: 'child-run', scope, origin: 'run:child-run:child-action:node:save',
    arguments: { action: 'save', scope: 'currentThread', content: 'Child committed note', revision: 5 } };
  const saved = await owner(query, new AbortController().signal);
  expect(saved).toMatchObject({ status: 'ready', memoryReceipt: { origin: query.origin, revision: 6,
    changes: [expect.objectContaining({ scope: { kind: 'session', id: 'child' } })] } });
  const childNote = (await personalization.context('child')).memories.find(note => note.scope.kind === 'session')!;
  expect(childNote.content).toBe('Child committed note');
  expect((await personalization.context('parent')).memories).not.toContainEqual(expect.objectContaining({ id: childNote.id }));
  const foreignUpdate: MemoryQuery = { ...query, origin: 'run:child-run:deny:node:update',
    arguments: { action: 'save', id: parent.result.id, scope: 'currentThread', content: 'Steal private note', revision: 6 } };
  expect(await owner(foreignUpdate, new AbortController().signal)).toMatchObject({ status: 'rejected' });
  expect(await owner({ ...query, scope: { ...scope, mode: 'bot' } }, new AbortController().signal)).toMatchObject({ status: 'rejected' });
  await personalization.saveNote({ id: childNote.id, scope: childNote.scope, content: 'Newer child user edit', revision: 6 });
  const writes = storage.writes();
  personalization = open(); owner = createMemoryOwner({ personalization, prepareContext });
  expect(await owner({ ...query, action: 'receipt' }, new AbortController().signal)).toEqual(saved);
  expect(await owner(query, new AbortController().signal)).toEqual(saved);
  expect(storage.writes()).toBe(writes);
  expect(await read({ action: 'read', scope: 'currentThread' })).toMatchObject({ status: 'ready', notes: [expect.objectContaining({ content: 'Newer child user edit' })] });
  expect(await owner({ ...query, origin: 'run:child-run:stale:node:save' }, new AbortController().signal)).toMatchObject({ status: 'rejected' });
  const cancelled = new AbortController(); cancelled.abort();
  expect(await owner({ ...query, origin: 'run:child-run:cancelled:node:save', arguments: { ...query.arguments!, revision: 7 } }, cancelled.signal)).toMatchObject({ status: 'unknown' });
  expect(storage.writes()).toBe(writes);
});
