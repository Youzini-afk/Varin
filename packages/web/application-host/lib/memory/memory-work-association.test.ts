import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceKnowledge } from '../knowledge/store.js';
import { createMemoryService } from './memory-service.js';

it('preserves both work associations when explicit Bot memory deduplicates across conversations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-memory-association-'));
  const store = await openWorkspaceKnowledge({ dataDir, hostId: 'test-host', workspaceId: 'bot-test', scope: 'bot', embedding: null });
  try {
    const content = 'Do not publish until the signed approval arrives.';
    const owner = { scope: 'bot' as const, ownerId: 'test-bot' };
    const service = createMemoryService({
      storeForScopeId: async scope => scope === 'bot:test-bot' ? store : null,
      userStore: async () => null, ownerForSession: async () => owner,
      associationForSession: async sessionId => ({ sessionIds: [sessionId] }),
      readSessionEntries: async sessionId => [{ id: `${sessionId}-user`, parentId: null, type: 'message', timestamp: '2026-10-12T00:00:00Z',
        message: { role: 'user', timestamp: 1, content } }],
    });
    const first = await service.remember(owner, { content, source: { kind: 'memory.remember', sessionId: 'work-A' } });
    const recall = (sessionId: string) => service.search(owner, 'continue-zebra', 5, { sessionId });
    expect((await recall('work-A')).map(hit => hit.node.id)).toEqual([first.item.id]);
    const duplicate = await service.remember(owner, { content, source: { kind: 'memory.remember', sessionId: 'work-B' } });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.item.id).toBe(first.item.id);
    const sources = await service.readSource(owner, first.item.id);
    expect(sources.map(({ span }) => span.kind === 'pi-entry' ? span.sessionId : null).sort()).toEqual(['work-A', 'work-B']);
    expect(sources.every(source => source.status === 'available')).toBe(true);
    expect((await recall('work-A')).map(hit => hit.node.id)).toEqual([first.item.id]);
    expect((await recall('work-B')).map(hit => hit.node.id)).toEqual([first.item.id]);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
