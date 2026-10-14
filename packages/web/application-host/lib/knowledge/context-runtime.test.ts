import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKnowledgeContextRuntime, type ThreadObservationSource } from './context-runtime.js';
import { openKnowledgeStoreEngine } from './store-engine.js';
import type { KnowledgeStore } from './store.js';
import { createTerminalCommandObserveAdapter, createTerminalCommandProjector } from './terminal-projection.js';
let root: string, store: KnowledgeStore;
let sources: ThreadObservationSource[];
const source = (threadId = 'thread:a'): ThreadObservationSource => ({ threadId, anchorId: `input:${threadId}`, epoch: 1, branchId: `branch:${threadId}`, runId: `run:${threadId}`, source: {
  resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'ws', execution_workspace_id: 'ws', branch_id: null, revision: null,
  live_root: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace/project' },
} });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'varin-native-observations-')); store = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'host', workspaceId: 'ws', embedding: null }); sources = [source()]; });
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
const runtime = () => createKnowledgeContextRuntime({ getStore: async () => store, threadSources: async () => sources });
it('persists real document and terminal observations to admitted native Threads with durable dedupe', async () => {
  let context = runtime(); sources.push(source('thread:b'));
  context.observeDocumentMutation({ workspaceId: 'ws', resourceId: 'src/a.ts', kind: 'modified', owner: { kind: 'web-route', id: 'editor' } }); await context.drain();
  const event = { workspaceId: 'ws', sessionId: 'terminal:1', commandId: 'command:1', command: 'git status', exitCode: 0, source: 'user' as const };
  expect(await context.observeTerminalCommand(event, source())).toBe(true);
  expect(await context.observeTerminalCommand(event, source())).toBe(false);
  const first = await context.observationsForRun({ threadId: 'thread:a', branchId: 'branch:thread:a', runId: 'run:thread:a' });
  expect(first?.events.map(item => item.event.kind)).toEqual(['edit', 'command']);
  expect(first?.events.every(item => item.ref === `observation:run:thread:a:${item.event.id}`)).toBe(true);
  expect((await context.observationsForRun({ threadId: 'thread:b', branchId: 'branch:thread:b', runId: 'run:thread:b' }))?.events).toHaveLength(1);
  await context.dispose(); context = runtime();
  expect(await context.observeTerminalCommand(event, source())).toBe(false);
  expect((await context.observationsForRun({ threadId: 'thread:a', branchId: 'branch:thread:a', runId: 'run:thread:a', afterEventId: first!.eventCursor }))?.events).toEqual([]);
  await context.dispose();
});
it('does not borrow a local cwd for a fixed or managed source and fences a changed original Run', async () => {
  sources = [{ ...source('thread:fixed'), source: { ...source().source, mode: 'fixed_branch' } },
    { ...source('thread:remote'), source: { ...source().source, resource_owner: { kind: 'managed_host', hostId: 'remote', connectionId: 'remote', endpointIdentity: 'remote' } } }, source()];
  const context = runtime(); expect(await context.listBoundOwners('ws')).toEqual([{ threadId: 'thread:a', branchId: 'branch:thread:a', runId: 'run:thread:a' }]);
  await expect(context.observationsForRun({ threadId: 'thread:a', runId: 'run:thread:a', branchId: 'different' })).rejects.toThrow('original Run');
  expect(await context.observationsForRun({ threadId: 'thread:remote', branchId: 'branch:thread:remote', runId: 'run:thread:remote' })).toBeNull();
  sources = []; expect(await context.listBoundOwners('ws')).toEqual([]); await context.dispose();
});
it('projects user terminal records into each original Thread, never a runtime session', async () => {
  sources.push(source('thread:b')); const context = runtime();
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: async () => 'ws', drain: context.drain,
    listBoundOwners: context.listBoundOwners, observe: createTerminalCommandObserveAdapter(context) });
  const record = { terminalId: 'terminal:1', owner: 'user' as const, commandId: 'cmd', command: 'pwd', exitCode: 0,
    integration: 'osc-633' as const, endedAt: 1, cwd: '/workspace/project' };
  expect(await projector.project(record)).toEqual({ 'run:thread:a': true, 'run:thread:b': true });
  expect(await projector.project(record)).toEqual({ 'run:thread:a': false, 'run:thread:b': false });
  await context.dispose();
});
