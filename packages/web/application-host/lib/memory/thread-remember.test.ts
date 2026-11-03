import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { knowledgeStoreKeyForScope } from '../harness/owner-scope.js';
import { openKnowledgeStoreEngine } from '../knowledge/store-engine.js';
import { createMemoryService } from './memory-service.js';
import { createThreadRemember } from './thread-remember.js';
import type { AgentPersonalization } from './agent-personalization.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { runtime: 'agent' as const, threadId: 'thread:1', branchId: 'branch:1' };
async function fixture(bot = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-remember-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'host', workspaceId: knowledgeStoreKeyForScope('bot:1'), scope: 'bot', embedding: null });
  cleanups.push(() => store.close());
  const memory = createMemoryService({ storeForScopeId: async () => store, userStore: async () => store, ownerForThread: async () => ({ scope: 'bot', ownerId: 'bot:1' }) });
  const runtime = { thread: vi.fn(async () => ({ bot_id: bot ? 'bot:1' : null, branches: [{ branch_id: identity.branchId }], deleted_at_ms: null })) } as unknown as Pick<AgentRuntimeClient, 'thread'>;
  const personalization = { context: vi.fn(async () => ({ mode: 'agent', projectId: 'project:1', revision: 4 })), saveNote: vi.fn(async (input: { content: string; scope: unknown }) => ({ result: { id: 12, ...input } })) } as unknown as AgentPersonalization;
  return { service: createThreadRemember({ runtime, memory, personalization }), runtime, memory, personalization, store };
}
it('writes through KnowledgeStore CAS/receipt and retries exactly once after a changed revision', async () => {
  const { service, memory, store } = await fixture();
  const scopes = await service.scopes(identity); const scope = scopes[0]!;
  const input = { ...identity, key: 'save-1', ...scope, content: 'Keep the original user wording.', trigger: 'When preparing a handoff' };
  const receipt = await service.remember(input);
  expect(receipt.content).toBe(input.content);
  await memory.remember({ scope: 'bot', ownerId: 'bot:1' }, { content: 'A later unrelated memory' });
  expect(await service.remember(input)).toEqual(receipt);
  expect(await store.listKnowledge({ scope: 'bot' })).toHaveLength(2);
  await expect(service.remember({ ...input, key: 'new-save', content: 'Should not overwrite concurrent work' })).rejects.toThrow();
});
it('ordinary notes use exact permitted scopes and the original user-labelled note receipt', async () => {
  const { service, personalization } = await fixture(false);
  const scopes = await service.scopes(identity);
  expect(scopes.map(scope => scope.destination)).toEqual([{ kind: 'thread', id: 'thread:1' }, { kind: 'project', id: 'project:1' }, { kind: 'global' }]);
  const receipt = await service.remember({ ...identity, key: 'note-1', ...scopes[0]!, content: 'Quoted selection' });
  expect(receipt.id).toBe(12);
  expect(personalization.saveNote).toHaveBeenCalledWith(expect.objectContaining({ source: { label: 'user', threadId: identity.threadId }, revision: 4 }), expect.objectContaining({ origin: expect.stringContaining('note-1'), native: true }));
  await expect(service.remember({ ...identity, key: 'wrong-scope', revision: 4, destination: { kind: 'thread', id: 'someone-else' }, content: 'Do not save' })).rejects.toThrow('outside');
});
it('rejects an owner change and a branch that does not belong to the source thread', async () => {
  const { service } = await fixture();
  await expect(service.remember({ ...identity, key: 'wrong-owner', revision: '0', destination: { kind: 'bot', id: 'another-bot' }, content: 'Never copied' })).rejects.toThrow('destination changed');
  await expect(service.scopes({ ...identity, branchId: 'other-branch' })).rejects.toThrow('no longer available');
});
