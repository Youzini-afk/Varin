import { expect, it } from 'vitest';
import { WEB_TOOL_DECLARATIONS, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import { createDocumentReader } from '../harness/document-reading.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createWebRuntime, type WebRuntimeOptions } from './web-runtime.js';
import { createMaterialCollections } from '../harness/material-collections.js';
import { threadMaterialScope } from './material-storage.js';

it('freezes Web configuration failures at its own declarations and preserves the accepted configuration', async () => {
  const { materials } = createMaterialStoreFixture();
  const unused = async (): Promise<never> => { throw new Error('Configuration preparation must not execute a tool'); };
  const make = (settings: WebRuntimeOptions['settings']) => createWebRuntime({
    runtime: { familyList: unused, run: unused, launch: unused },
    materials, documentReader: createDocumentReader({ materials }),
    webFetch: createWebFetch({ materials }),
    fetch: unused, readAuth: unused, settings,
  });
  const snapshot: AgentSettingsSnapshot = { global: { harness: { web: { domains: { block: ['blocked.example'] } } } },
    project: {}, globalRevision: 'accepted', projectRevision: 'unselected', projectTrusted: false };
  const run = { runId: 'run', threadId: 'thread', source: null };
  const accepted = await make(async source => { expect(source).toBeNull(); return snapshot; }).prepareConfiguration(run, []);
  const original = accepted(WEB_TOOL_DECLARATIONS[1]);
  expect(JSON.parse(original!).web.settings.domains.block).toEqual(['blocked.example']);
  const failure = new Error('Settings file is unreadable');
  const broken = await make(async () => { throw failure; }).prepareConfiguration(run, [], () => 'other-owner');
  expect(broken(COMPUTER_TOOL_DECLARATIONS[0])).toBe('other-owner');
  expect(() => broken(WEB_TOOL_DECLARATIONS[1])).toThrow(failure);
  expect(broken(WEB_TOOL_DECLARATIONS[1], original)).toBe(original);
  expect(accepted.enabled!(WEB_TOOL_DECLARATIONS[0])).toBe(true); // Product-provided anonymous search is available without credentials.
  expect(accepted.enabled!(WEB_TOOL_DECLARATIONS[1])).toBe(true); // Page/material reads remain usable.
  const disabled = await make(async () => ({ ...snapshot, global: { harness: { tools: { webfetch: false } } } })).prepareConfiguration(run, []);
  expect(disabled.enabled!(WEB_TOOL_DECLARATIONS[1])).toBe(false);
  const searchDisabled = await make(async () => ({ ...snapshot, global: { harness: { tools: { websearch: false } } } })).prepareConfiguration(run, []);
  expect(searchDisabled.enabled!(WEB_TOOL_DECLARATIONS[0])).toBe(false);
  const noConnections = await make(async () => ({ ...snapshot, global: { harness: { web: { search: { connections: [], fallbackConnectionIds: [] } } } } })).prepareConfiguration(run, []);
  expect(noConnections.enabled!(WEB_TOOL_DECLARATIONS[0])).toBe(false);
  const malformed = await make(async () => ({ ...snapshot, global: { harness: { web: { search: { provider: 'unknown' } } } } })).prepareConfiguration(run, []);
  expect(malformed.enabled!(WEB_TOOL_DECLARATIONS[0])).toBe(false);
  expect(malformed.enabled!(WEB_TOOL_DECLARATIONS[1])).toBe(true);
});

it('reads and shares retained text through the real material ACL, retaining the original share key', async () => {
  const workspaceId = threadMaterialScope('root');
  const opened = createMaterialStoreFixture({ workspaceId, operationReceipts: true });
  const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials });
  const authority = { kind: 'thread' as const, owningWorkspaceId: workspaceId, threadId: 'root' };
  const snapshot = await opened.materials.put(workspaceId, { sourceUrl: 'https://example.test/report', finalUrl: 'https://example.test/report', representation: 'raw-text' }, Buffer.from('first line\n第二行完整内容\nlast line'), authority);
  const created = await collections.execute({ action: 'create', name: 'Investigation' }, { authority });
  const collectionId = created.result.collection!.collectionId;
  await collections.execute({ action: 'add', collectionId, member: { kind: 'snapshot', snapshotId: snapshot.snapshotId } }, { authority });
  const unused = async (): Promise<never> => { throw new Error('Retained material reading must not fetch a URL'); };
  const documentReader = createDocumentReader({ materials: opened.materials });
  const web = createWebRuntime({
    runtime: { familyList: async () => ({ rootThreadId: 'root', members: ['root','child'].map(threadId => ({ threadId, branches: [{ branchId: 'branch' }] })) }), run: unused, launch: unused } as unknown as WebRuntimeOptions['runtime'],
    materials: opened.materials, collections, documentReader,
    webFetch: createWebFetch({ materials: opened.materials, documentReader }),
    fetch: unused, readAuth: unused, settings: async () => ({ global: {}, project: {}, globalRevision: 'g', projectRevision: 'p', projectTrusted: false }),
  });
  const root = { runtime: 'agent' as const, threadId: 'root', branchId: 'branch' }, child = { ...root, threadId: 'child' };
  expect((await web.user.collection!(child, { action: 'inspect', collectionId })).status).toBe('not-found');
  await expect(web.user.collection!({ ...root, branchId: 'foreign' }, { action: 'inspect', collectionId })).rejects.toThrow('branch');
  const request = { action: 'share' as const, collectionId, targetThreadId: 'child', key: 'same-click' };
  const shared = await web.user.collection!(root, request);
  expect(shared.status).toBe('ok');
  expect((await web.user.collection!(root, request)).grant?.grantId).toBe(shared.grant?.grantId);
  expect((await web.user.collection!(child, { action: 'inspect', collectionId })).collection?.members[0]?.snapshotId).toBe(snapshot.snapshotId);
  const read = await web.user.read(child, { snapshotId: snapshot.snapshotId, position: { kind: 'lines', startLine: 2, endLine: 2 } });
  expect(read).toMatchObject({ status: 'ok', markdown: '第二行完整内容', range: { startLine: 2, endLine: 2, totalLines: 3 } });
  expect((await web.user.collection!(root, { ...request, targetThreadId: 'outside-family', key: 'outside' })).status).toBe('denied');
});

it('keeps an unconfirmed Storage mutation unknown and unstopped rather than converting a rejected Host promise to no effect', async () => {
  const { MaterialCollectionMutationError, createMaterialCollections } = await import('../harness/material-collections.js');
  const { withToolInvocation } = await import('./tool-invocation.js');
  const opened = createMaterialStoreFixture();
  const unused = async (): Promise<never> => { throw new Error('This mutation never reads a document or network'); };
  const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials });
  collections.execute = async () => { throw new MaterialCollectionMutationError('Original Storage response was lost', 'unknown'); };
  const web = createWebRuntime({
    runtime: { run: async () => ({ thread_id: 'thread', branch_id: 'branch' }),
      familyList: async () => ({ rootThreadId: 'thread', members: [{ threadId: 'thread', branches: [{ branchId: 'branch' }] }] }), launch: unused } as unknown as WebRuntimeOptions['runtime'],
    materials: opened.materials, collections, documentReader: createDocumentReader({ materials: opened.materials }),
    webFetch: createWebFetch({ materials: opened.materials }),
    fetch: unused, readAuth: unused,
    settings: async () => ({ global: {}, project: {}, globalRevision: 'global', projectRevision: 'project', projectTrusted: false }),
  });
  const declaration = WEB_TOOL_DECLARATIONS.find(value => value.tool!.name === 'materials')!;
  const prepare = await web.prepareConfiguration({ runId: 'run', threadId: 'thread', source: null }, []);
  const args = { action: 'create' }, owner = { extensionId: 'varin.builtin.web', extensionVersion: '0.1.0', entrypointId: 'host', instanceKey: 'web-runtime-fixture', generation: 1 };
  const signal = new AbortController().signal;
  let receipt: import('./tool-bridge.js').ToolExecutionReceipt | undefined;
  await withToolInvocation({ owner, signal, onEffectReceipt: value => { receipt = value; }, authority: {
    invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'request:tool:call', callId: 'call',
    origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'external', identity: 'provider', epoch: 'owner' },
    source: null, operation: 'effect', completion: 'result', toolName: 'materials', configurationIdentity: prepare(declaration), arguments: args,
  } }, async invocation => { await web.capability('collections', args, { owner, signal, invocation }); });
  expect(receipt).toMatchObject({ executor_stopped: false, completion: { outcome: 'indeterminate', effect: 'unknown' } });
});

it('default admitted search preserves objective semantics and returns a readable, typed source observation', async () => {
  const { withToolInvocation } = await import('./tool-invocation.js');
  const { materialAttachmentRef } = await import('@varin/protocol');
  const workspaceId = threadMaterialScope('thread');
  const opened = createMaterialStoreFixture({ workspaceId });
  const unused = async (): Promise<never> => { throw new Error('Unexpected network or source access'); };
  const dispatched: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    dispatched.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { results: [
      { title: 'Original announcement', url: 'https://example.test/announcement', highlights: ['原始公告中的有效证据。'] },
    ] } } }), { headers: { 'content-type': 'application/json' } });
  };
  const authority = { kind: 'thread' as const, owningWorkspaceId: workspaceId, threadId: 'thread' };
  const attached: string[] = [];
  const web = createWebRuntime({
    runtime: { run: async () => ({ thread_id: 'thread', branch_id: 'branch' }),
      familyList: async () => ({ rootThreadId: 'thread', members: ['thread', 'unshared'].map(threadId => ({ threadId, branches: [{ branchId: 'branch' }] })) }), launch: unused } as unknown as WebRuntimeOptions['runtime'],
    materials: opened.materials, documentReader: createDocumentReader({ materials: opened.materials }),
    documentSources: { attachment: async (_invocation: import('./tool-invocation.js').ToolInvocationAuthority, snapshotId: string) => {
      const material = await opened.materials.read(workspaceId, snapshotId, authority);
      expect(material).not.toBeNull(); attached.push(snapshotId);
      return { ref: materialAttachmentRef(snapshotId), filename: 'source.txt', mimeType: 'text/plain', byteLength: material!.ref.byteLength };
    } } as unknown as NonNullable<WebRuntimeOptions['documentSources']>,
    webFetch: createWebFetch({ materials: opened.materials }),
    fetch, readAuth: unused, settings: async () => ({ global: {}, project: {}, globalRevision: 'g', projectRevision: 'p', projectTrusted: false }),
  });
  const declaration = WEB_TOOL_DECLARATIONS.find(value => value.tool!.name === 'websearch')!;
  const prepared = await web.prepareConfiguration({ runId: 'run', threadId: 'thread', source: null }, []);
  const tools = WEB_TOOL_DECLARATIONS.filter(value => prepared.enabled?.(value) !== false).map(value => value.tool!.name);
  expect(tools).toContain('websearch');
  const args = { query: 'version 4.2', objective: 'Find the exact release requirement' };
  const owner = { extensionId: 'varin.builtin.web', extensionVersion: '0.1.0', entrypointId: 'host', instanceKey: 'source-test', generation: 1 };
  const signal = new AbortController().signal;
  let completed: import('./tool-bridge.js').ToolExecutionReceipt | undefined;
  await withToolInvocation({ owner, signal, onEffectReceipt: value => { completed = value; }, authority: {
    invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'request:tool:search', callId: 'search',
    origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'external', identity: 'provider', epoch: 'owner' },
    source: null, operation: 'read', completion: 'result', toolName: 'websearch', configurationIdentity: prepared(declaration), arguments: args,
  } }, async invocation => { await web.capability('search', args, { owner, signal, invocation }); });
  expect(dispatched).toHaveLength(1);
  expect(completed).toMatchObject({ executor_stopped: true, completion: { outcome: 'succeeded' } });
  if (completed!.completion.kind !== 'result') throw new Error('No source result');
  const data = completed!.completion.content.data as unknown as import('@varin/protocol').WebSearchResult;
  expect(data.items).toHaveLength(1);
  const source = data.items[0]!.results![0]!.source!;
  expect(source.citation).toContain('varin-material://');
  expect(source.snapshot.provenance).toMatchObject({ kind: 'search-result', query: args.query, objective: args.objective, operationId: 'request:tool:search' });
  expect(attached).toEqual([source.snapshot.snapshotId]);
  expect(completed!.completion.content.parts).toMatchObject([{ kind: 'attachment', attachment: { ref: source.attachmentRef } }]);
  // The model sees one copy of each observation, not another merged body list.
  expect(data.results).toBeUndefined();
  const read = await web.user.read({ runtime: 'agent', threadId: 'thread', branchId: 'branch' }, { snapshotId: source.snapshot.snapshotId });
  expect(read).toMatchObject({ status: 'ok', markdown: '原始公告中的有效证据。' });
  const longSource = await opened.materials.put(workspaceId, { sourceUrl: 'https://example.test/long', finalUrl: 'https://example.test/long', representation: 'raw-text' },
    Buffer.from(Array.from({ length: 90 }, (_, index) => [10, 50].includes(index) ? 'Exact evidence' : 'Context line').join('\n')), authority);
  const passages = await web.user.read({ runtime: 'agent', threadId: 'thread', branchId: 'branch' }, { snapshotId: longSource.snapshotId, find: 'Exact evidence' });
  if (passages.status !== 'ok') throw new Error('Source passages unavailable');
  expect(passages.passageCitations).toHaveLength(2);
  for (const passage of passages.passageCitations!) {
    const url = new URL(passage.citation);
    expect(url.hostname).toBe(longSource.snapshotId);
    expect(url.searchParams.get('contentHash')).toBe(longSource.contentHash);
    expect(Number(url.searchParams.get('startLine'))).toBe(passage.startLine);
    expect(Number(url.searchParams.get('endLine'))).toBe(passage.endLine);
  }
  const denied = await web.user.read({ runtime: 'agent', threadId: 'unshared', branchId: 'branch' }, { snapshotId: source.snapshot.snapshotId });
  expect(denied.status).not.toBe('ok');
  await web.close();
});
