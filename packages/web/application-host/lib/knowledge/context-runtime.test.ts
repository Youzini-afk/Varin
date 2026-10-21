import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKnowledgeContextRuntime, type ThreadObservationSource } from './context-runtime.js';
import { openKnowledgeStoreEngine } from './store-engine.js';
import type { KnowledgeStore } from './store.js';
import { createTerminalCommandObserveAdapter, createTerminalCommandProjector } from './terminal-projection.js';
import { createContextObservationPublication } from './context-publication.js';
import { ContextService } from '../kernel/context-service.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ContextPreparer } from '../kernel/thread-context.js';
import type { KernelClient } from '../kernel/kernel-client.js';
let root: string, store: KnowledgeStore;
let sources: ThreadObservationSource[];
const source = (threadId = 'thread:a'): ThreadObservationSource => ({ threadId, anchorId: `input:${threadId}`, epoch: 1, branchId: `branch:${threadId}`, runId: `run:${threadId}`, source: {
  resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'ws', execution_workspace_id: 'ws', branch_id: null, revision: null,
  live_root: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace/project' },
} });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'varin-native-observations-')); store = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'host', workspaceId: 'ws', embedding: null }); sources = [source()]; });
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
const runtime = () => createKnowledgeContextRuntime({ getStore: async () => store, threadSources: async () => sources });
it('keeps model preparation available with a corrupt observation store and publishes the original events after recovery', async () => {
  const owner = source();
  await store.putEvent({ kind: 'edit', at: 1, sessionId: owner.runId, text: 'editor save', source: 'user' });
  await store.close();
  const marker = join(root, 'knowledge', 'host', 'ws.tdb.flush_ok');
  const original = await readFile(marker);
  await writeFile(marker, 'invalid checkpoint marker');
  let opened = false;
  const load = vi.fn(async () => {
    if (!opened) { store = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'host', workspaceId: 'ws', embedding: null }); opened = true; }
    return store;
  });
  const context = createKnowledgeContextRuntime({ getStore: load });
  const admitted: number[] = [];
  const request = vi.fn(async (method: string, params: { events?: Array<{ id: number }> }) => {
    if (method.endsWith('sources')) return [owner];
    admitted.push(...params.events!.map(event => event.id));
    return params.events!.map(event => ({ id: `observation:${owner.runId}:${event.id}`, cursor: 1, state: 'queued' }));
  });
  const warning = vi.fn();
  const publication = createContextObservationPublication({ agentRuntimeRequest: request } as unknown as Pick<KernelClient, 'agentRuntimeRequest'>, { onUnavailable: warning });
  const consumer = { id: 'consumer', thread_id: owner.threadId, branch_id: owner.branchId, state: 'running', cancel_requested: false };
  const service = new ContextService({ run: async () => consumer, launch: async () => null } as unknown as AgentRuntimeClient,
    Object.assign(async () => { throw new Error('No initial context'); }, { main: async () => { throw new Error('No main context'); } }) as ContextPreparer,
    async () => ({ policy: { configurationIdentity: 'policy', enabled: false, reserveTokens: 0, keepRecentTokens: 0, explicitKeepRecentTokens: null, backgroundPreparation: false, preparationWaterline: 0.8 }, scope: { threadId: owner.threadId } }), async () => {}, null);
  service.bindObservations((run, signal) => publication.publish(context, run, signal));
  const prepare = () => service.query({ action: 'prepare', runId: consumer.id, requestId: 'model', expectedRevision: 1 }, new AbortController().signal);
  try {
    expect(await prepare()).toMatchObject({ status: 'ready' });
    expect(await prepare()).toMatchObject({ status: 'ready' });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws', reason: 'corrupt' });
    expect(admitted).toEqual([]);
    expect(await readFile(marker, 'utf8')).toBe('invalid checkpoint marker');
    await writeFile(marker, original);
    expect(await prepare()).toMatchObject({ status: 'ready' });
    expect(admitted).toHaveLength(1);
    expect(await prepare()).toMatchObject({ status: 'ready' });
    expect(admitted).toHaveLength(1);
  } finally { service.close(); await context.dispose(); }
});
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
