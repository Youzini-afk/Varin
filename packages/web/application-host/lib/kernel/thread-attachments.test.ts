import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createThreadAttachments } from './thread-attachments.js';
import { registerThreadAttachmentRoutes } from './thread-attachment-routes.js';
import { threadMaterialScope } from './material-storage.js';

const managedPath = vi.hoisted(() => vi.fn());
vi.mock('./managed-attachment-path.js', () => ({ prepareManagedAttachmentPath: managedPath }));

const root: ThreadIdentity = { runtime: 'agent', threadId: 'root', branchId: 'root-branch' };
const child: ThreadIdentity = { runtime: 'agent', threadId: 'child', branchId: 'child-branch' };
const peer: ThreadIdentity = { runtime: 'agent', threadId: 'peer', branchId: 'peer-branch' };
const all = [root, child, peer];
const bytes = async function* (value: Uint8Array) { for (let offset = 0; offset < value.length; offset += 4096) yield value.subarray(offset, offset + 4096); };
const collected = async (source: AsyncIterable<Uint8Array>) => { const out: Uint8Array[] = []; for await (const value of source) out.push(value); return Buffer.concat(out); };
afterEach(() => vi.unstubAllGlobals());

/** The real attachment and material lifecycle owners over the existing record fixture.
 * Native blob persistence, captures and filesystem leases have their Rust tests. */
function fixture() {
  const client = {
    putBlobStream: vi.fn(async (source: AsyncIterable<Uint8Array>, input: { operationId: string; byteLength: number; expectedHash?: string }) => {
      const body = await collected(source);
      const hash = `sha256-${createHash('sha256').update(body).digest('hex')}`;
      if (body.length !== input.byteLength || input.expectedHash && input.expectedHash !== hash) throw new Error('Storage rejected inconsistent bytes');
      f.objects.set(hash, body);
      return { hash, byteLength: body.length, ownerId: input.operationId };
    }),
    getBlob: vi.fn(async (hash: string, proof: { recordId: string; slot: string }, range: { offset?: number; length?: number; signal?: AbortSignal } = {}) => {
      range.signal?.throwIfAborted();
      const record = f.records.get(proof.recordId), body = f.objects.get(hash);
      if (!body || !record?.references.some(value => value.slot === proof.slot && value.objectHash === hash)) throw new Error('Storage denied an unretained object');
      const offset = range.offset ?? 0, nextOffset = Math.min(body.length, offset + (range.length ?? body.length));
      return { hash, offset, nextOffset, byteLength: body.length, eof: nextOffset === body.length, bytesBase64: body.subarray(offset, nextOffset).toString('base64') };
    }),
    objectViewRelease: vi.fn(async () => ({ released: true })),
    rebindObjectOwner: vi.fn(async () => ({})),
    objectViewPrepare: vi.fn(async (input: { filename: string }) => ({ path: `/actual-host-generation/${input.filename}`, kernelEpoch: 'epoch', readOnly: true, viewId: 'original-view' })),
  };
  const f: ReturnType<typeof createMaterialStoreFixture> = createMaterialStoreFixture({ workspaceId: threadMaterialScope(root.threadId), client });
  const runtime = {
    familyList: vi.fn(async () => ({ rootThreadId: root.threadId, members: all.map(identity => ({ threadId: identity.threadId, branches: [{ branchId: identity.branchId }] })) })),
    thread: vi.fn(async (id: string) => ({ branches: all.filter(identity => identity.threadId === id).map(identity => ({ branch_id: identity.branchId, active_run_id: null, latest_run: null })) })),
    run: vi.fn(async () => ({ id: 'run', thread_id: child.threadId, branch_id: child.branchId })),
    launch: vi.fn(async () => null),
    operation: vi.fn(async () => { throw new Error('No native Operation'); }),
    materialRetention: vi.fn(async () => ({ attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [], attachments: [], threads: [] })),
    child: vi.fn(async () => ({ parent_thread_id: root.threadId, parent_branch_id: root.branchId, child_thread_id: child.threadId, child_branch_id: child.branchId })),
  } as unknown as AgentRuntimeClient;
  const owner = createThreadAttachments({ kernel: {} as KernelClient, runtime, storage: f.workingStates, materials: f.materials, resolveLiveSource: vi.fn() });
  const upload = (identity: ThreadIdentity, key: string, data: Uint8Array, filename = 'archive.weird') => owner.upload(identity,
    { key, filename, mimeType: '', byteLength: data.length }, bytes(data));
  return { ...f, owner, runtime, client, upload };
}

it('streams arbitrary and empty originals, reuses same-key uploads and rejects changed retry bytes', async () => {
  const f = fixture(), original = Buffer.from([0xff, 0x00, 0x80, 0x51]);
  const attachment = await f.upload(root, 'upload', original);
  expect(attachment.mimeType).toBe('application/octet-stream');
  expect(await collected((await f.owner.read(root, attachment.ref)).stream)).toEqual(original);
  expect(await f.upload(root, 'upload', original)).toEqual(attachment);
  expect(f.client.putBlobStream).toHaveBeenCalledTimes(1);
  await expect(f.upload(root, 'upload', Buffer.from([1, 2, 3, 4]))).rejects.toThrow('changed its original bytes');
  const empty = await f.upload(root, 'empty', Buffer.alloc(0), 'empty.dat');
  expect(await collected((await f.owner.read(root, empty.ref)).stream)).toHaveLength(0);
});

it('requires explicit recipient relations and keeps forwarded originals after source Thread deletion', async () => {
  const f = fixture(), original = Buffer.from('fixed delivery version');
  const attachment = await f.upload(root, 'upload', original);
  await expect(f.owner.read(child, attachment.ref)).rejects.toThrow('has not received');
  await f.owner.prepare(root, [{ ref: attachment.ref }], 'send-child', child.threadId);
  await f.owner.prepare(child, [{ ref: attachment.ref }], 'forward-peer', peer.threadId);
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), [root.threadId, child.threadId]);
  expect(await collected((await f.owner.read(peer, attachment.ref)).stream)).toEqual(original);
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), all.map(identity => identity.threadId));
  await expect(f.owner.read(peer, attachment.ref)).rejects.toThrow('not available');
});

it('never grants a partial file set or permissions inferred from a name, hash or extra selector field', async () => {
  const f = fixture(), attachment = await f.upload(root, 'upload', Buffer.from('one'));
  await expect(f.owner.prepare(root, [{ ref: attachment.ref }, { ref: 'attachment:unknown' }], 'failed', child.threadId)).rejects.toThrow('Attachment 2');
  await expect(f.owner.read(child, attachment.ref)).rejects.toThrow('has not received');
  await expect(f.owner.prepare(root, [{ ref: attachment.ref, path: 'anything' } as never], 'forged', child.threadId)).rejects.toThrow('exactly one');
  await expect(f.owner.read({ ...root, branchId: peer.branchId }, attachment.ref)).rejects.toThrow('does not belong');
});

it('uses the original execution owner path and does not pretend a coordinator path is remote', async () => {
  const f = fixture(), attachment = await f.upload(root, 'upload', Buffer.from('data'));
  await f.owner.prepare(root, [{ ref: attachment.ref }], 'send-child', child.threadId);
  expect(await f.owner.path(child, attachment.ref, 'run')).toMatchObject({ path: '/actual-host-generation/archive.weird', kernelEpoch: 'epoch', readOnly: true });
  expect(f.client.objectViewPrepare).toHaveBeenCalledWith(expect.objectContaining({ recordId: attachment.ref, slot: 'source', runId: 'run' }), undefined);
  vi.mocked(f.runtime.launch).mockResolvedValue({ selection: { source: { resource_owner: { kind: 'managed_host' } } } } as never);
  managedPath.mockImplementationOnce(async input => {
    const page = await input.readPage(0, 256);
    expect(Buffer.from(page.bytesBase64, 'base64').toString()).toBe('data');
    expect(input).toMatchObject({ runId: 'run', attachment, source: { resource_owner: { kind: 'managed_host' } } });
    return { path: '/actual-remote-host/attachment', kernelEpoch: 'remote-generation', readOnly: true };
  });
  expect(await f.owner.path(child, attachment.ref, 'run')).toMatchObject({ path: '/actual-remote-host/attachment', kernelEpoch: 'remote-generation' });
});

it('real authenticated HTTP and client use a Blob body and download the original binary', async () => {
  const f = fixture(), app = express();
  app.use(express.json({ limit: '1kb' })); // Generic uploads must never enter the JSON parser.
  registerThreadAttachmentRoutes(app, f.owner, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'yes') { response.status(401).end(); return; } next();
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local test listener');
  const base = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('x-fixture-auth', 'yes');
    return realFetch(new URL(String(url), base), { ...init, headers });
  });
  try {
    const original = Buffer.alloc(512 * 1024, 0x81), api = createThreadsHttpAPI();
    const uploaded = await api.attachments.upload(root, { key: 'http-upload', filename: 'large.bin', mimeType: 'application/octet-stream', data: new Blob([original]) });
    const downloaded = await api.attachments.read(root, { ref: uploaded.ref });
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(original);
    expect((await realFetch(`${base}/api/threads/attachments/read?${new URLSearchParams({ ...root, ref: uploaded.ref })}`)).status).toBe(401);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


it('keeps an admitted binary stream alive until it stops, while deletion waits', async () => {
  const f = fixture(), original = Buffer.alloc(512 * 1024, 0x52), attachment = await f.upload(root, 'stream', original);
  const iterator = (await f.owner.read(root, attachment.ref)).stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toHaveLength(256 * 1024);
  let finished = false;
  const deletion = f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false);
  expect((await iterator.next()).value).toHaveLength(256 * 1024);
  await iterator.return?.(); await deletion;
  expect(finished).toBe(true);
  await expect(f.owner.read(root, attachment.ref)).rejects.toThrow('not available');
});

it('retains exact typed child-context references before original Thread deletion', async () => {
  const f = fixture(), attachment = await f.upload(root, 'context', Buffer.from('context original'));
  await f.owner.retain({ attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [], threads: [
    { threadId: root.threadId, rootThreadId: root.threadId, release: true },
    { threadId: child.threadId, rootThreadId: root.threadId, release: false },
  ], attachments: [{ holderKind: 'context', holderId: 'dispatch', threadId: child.threadId, branchId: child.branchId, attachments: [attachment] }] });
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId);
  expect(await collected((await f.owner.read(child, attachment.ref)).stream)).toEqual(Buffer.from('context original'));
});

it('external process exit releases its views without revoking a forwarded original', async () => {
  const f = fixture(), conversation = { id: 'external:child:original', parent: { threadId: root.threadId, branchId: root.branchId, operationId: 'dispatch' } };
  const attachment = await f.upload(root, 'external', Buffer.from('external original'));
  await f.owner.prepare(root, [{ ref: attachment.ref }], 'external-send', conversation.id);
  await f.owner.externalPath(conversation, attachment.ref);
  await f.owner.releaseExternal(conversation);
  expect(f.client.objectViewRelease).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: threadMaterialScope(root.threadId) }));
  expect(await collected((await f.owner.read(root, attachment.ref)).stream)).toEqual(Buffer.from('external original'));
  await expect(f.owner.readExternal(conversation, attachment.ref)).rejects.toThrow('has not received');
});

it('does not let an execution-path cache keep its original descriptor alive after final deletion', async () => {
  const f = fixture(), attachment = await f.upload(root, 'cache', Buffer.from('cache original'));
  const source = f.records.get(attachment.ref)!;
  f.records.set('view', { ...source, recordId: 'view', recordType: 'file.object-view', threadId: 'cache-owner',
    payloadJson: JSON.stringify({ recordId: attachment.ref }), references: [...source.references] });
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId);
  expect(f.records.has(attachment.ref)).toBe(false);
  // The real native owner keeps this independent byte root until actual executor stop.
  expect(f.records.has('view')).toBe(true);
});

it('admits final typed report references on demand without granting unrelated references', async () => {
  const f = fixture(), attachment = await f.upload(child, 'report', Buffer.from('final report file'));
  vi.mocked(f.runtime.materialRetention).mockResolvedValue({ attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [],
    threads: [{ threadId: root.threadId, rootThreadId: root.threadId, release: false }],
    attachments: [{ holderKind: 'report', holderId: 'execution', threadId: root.threadId, branchId: root.branchId,
      sourceThreadId: child.threadId, sourceBranchId: child.branchId, attachments: [attachment] }] });
  expect(await collected((await f.owner.read(root, attachment.ref)).stream)).toEqual(Buffer.from('final report file'));
  await expect(f.owner.read(peer, attachment.ref)).rejects.toThrow('has not received');
});

it.each(['path','file-reference'] as const)('recovers a durable native %s capture without opening its deleted original pathname again', async kind => {
  const f = fixture(), body = Buffer.from('original captured bytes'), operationId = 'restore';
  const key = createHash('sha256').update(JSON.stringify([root.threadId, operationId, 0])).digest('hex');
  const ref = `attachment:${key}`, captureId = `attachment-capture:${key}`, hash = `sha256-${createHash('sha256').update(body).digest('hex')}`;
  const source = { mode: 'live_root', resource_owner: { kind: 'local' }, workspace_id: 'original-source', execution_workspace_id: 'execution-source',
    branch_id: null, revision: null, live_root: { hostId: 'host', rootId: 'root', canonicalRoot: '/deleted-original' } };
  f.objects.set(hash, body);
  f.records.set(captureId, { recordId: captureId, workspaceId: 'original-source', recordType: 'attachment.capture', state: 'temporary', threadId: root.threadId, recordRevision: 1,
    payloadJson: JSON.stringify({ path: 'fixed.bin', readVersion:'native-version', stateJson: JSON.stringify({ kind: 'regular-file', objectHash: hash, byteLength: body.length }), operationId: `attachment-preparation:${Buffer.from(operationId).toString('base64url')}:0`,
      canonicalRoot: '/deleted-original', executionWorkspaceId: 'execution-source' }), references: [{ slot: 'source', objectHash: hash }] });
  vi.mocked(f.runtime.run).mockResolvedValue({ id: 'run', thread_id: root.threadId, branch_id: root.branchId } as never);
  vi.mocked(f.runtime.thread).mockImplementation(async id => ({ branches: all.filter(value => value.threadId === id).map(value => ({ branch_id: value.branchId, active_run_id: 'run' })) }) as never);
  vi.mocked(f.runtime.launch).mockResolvedValue({ selection: { source } } as never);
  const sourceClient = { ...f.client, getRecord: vi.fn(async (_workspace: string, id: string) => f.records.get(id) ?? null),
    releaseRecord: vi.fn(async (_op: string, _workspace: string, id: string) => { f.records.delete(id); return {}; }) };
  const kernel = { issueGrant: vi.fn(async input => ({ grantId: input.grantId })), scoped: () => sourceClient, revokeGrant: vi.fn(async () => ({})),
    agentRuntimeRequest: vi.fn(async (method:string,params:Record<string,unknown>)=>{
      if (method==='runtime.model_reference.resolve') return {kind:'file',owner:'source',target:{kind:'observation',source,path:'fixed.bin',readVersion:'observed-version',format:null}};
      if (method==='runtime.model_reference.file_state') {expect(params).toMatchObject({source,path:'fixed.bin',readVersion:'native-version',expectedReadVersion:'observed-version'});return {readVersion:'native-version'};}
      throw new Error(method);
    }),
  };
  const resolveLiveSource = vi.fn(async () => { throw new Error('The source root no longer exists'); });
  const owner = createThreadAttachments({ kernel: kernel as unknown as KernelClient, runtime: f.runtime, storage: f.workingStates, materials: f.materials, resolveLiveSource });
  const selection=kind==='path'?{path:'/deleted-original/fixed.bin'}:{ref:'file:42'};
  f.client.putBlobStream.mockRejectedValueOnce(new DOMException('Observer cancelled', 'AbortError'));
  await expect(owner.prepare(root, [selection], operationId, child.threadId)).rejects.toThrow('Observer cancelled');
  expect(f.records.has(captureId)).toBe(true);
  const attachments = await owner.prepare(root, [selection], operationId, child.threadId);
  expect(attachments[0]?.ref).toBe(ref);
  expect(await collected((await owner.read(child, ref)).stream)).toEqual(body);
  expect(resolveLiveSource).not.toHaveBeenCalled();
  expect(f.records.has(captureId)).toBe(false);
});

it('drains an in-flight upload before deletion sweeps its late fixed record', async () => {
  const f = fixture(), body = Buffer.from('late upload');
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
  const stream = (async function* () { started(); await released; yield body; })();
  const upload = f.owner.upload(root, { key: 'racing-upload', filename: 'late.bin', mimeType: '', byteLength: body.length }, stream);
  await entered;
  vi.mocked(f.runtime.thread).mockResolvedValue({ deleted_at_ms: 1, branches: [{ branch_id: root.branchId }] } as never);
  let deleted = false;
  const deletion = f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId).then(() => { deleted = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(deleted).toBe(false);
  finish(); const attachment = await upload; await deletion;
  expect(f.records.has(attachment.ref)).toBe(false); expect(deleted).toBe(true);
  await expect(f.upload(root, 'too-late', body)).rejects.toThrow('has been deleted');
});

it('does not revoke an accepted original delivery when its same-key retry loses its observer', async () => {
  const f = fixture(), attachment = await f.upload(root, 'accepted', Buffer.from('accepted original'));
  await f.owner.prepare(root, [{ ref: attachment.ref }], 'accepted-key', child.threadId);
  vi.mocked(f.runtime.materialRetention).mockResolvedValue({ attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [], threads: [],
    attachments: [{ holderKind: 'input', holderId: 'accepted-message', threadId: child.threadId, branchId: child.branchId, attachments: [attachment] }] });
  const controller = new AbortController(), original = f.workingStates.withBranchStore.bind(f.workingStates);
  f.workingStates.withBranchStore = async (scope, purpose, action, mode, actor) => {
    const result = await original(scope, purpose, action, mode, actor);
    if (purpose === 'attachment-write' && actor?.threadId === child.threadId) controller.abort(new DOMException('Observer closed', 'AbortError'));
    return result;
  };
  await expect(f.owner.prepare(root, [{ ref: attachment.ref }], 'accepted-key', child.threadId, controller.signal)).rejects.toThrow('Observer closed');
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId);
  expect(await collected((await f.owner.read(child, attachment.ref)).stream)).toEqual(Buffer.from('accepted original'));
});

it('releases only partial path captures after their original Operation is definitively terminal', async () => {
  const f = fixture(), body = Buffer.from('partial original'), hash = `sha256-${createHash('sha256').update(body).digest('hex')}`;
  const upload = await f.upload(root, 'keep-upload', Buffer.from('independent upload'));
  f.owner.bindAbsolutePathCapture(async () => ({ filename: 'path.bin', mimeType: 'application/octet-stream', contentHash: hash, byteLength: body.length,
    chunks: bytes(body), readPage: async (offset, length) => { const nextOffset = Math.min(body.length, offset + length); return { hash, offset, nextOffset, byteLength: body.length, eof: nextOffset === body.length, bytesBase64: body.subarray(offset, nextOffset).toString('base64') }; }, release: async () => {} }));
  const operationId = 'native-operation';
  await expect(f.owner.prepare(root, [{ path: '/admitted/path.bin' }, { ref: 'attachment:missing' }], operationId, child.threadId)).rejects.toThrow('Attachment 2');
  const ref = `attachment:${createHash('sha256').update(JSON.stringify([root.threadId, operationId, 0])).digest('hex')}`;
  const plan = { attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [], attachments: [], threads: [{ threadId: root.threadId, rootThreadId: root.threadId, release: false }] };
  vi.mocked(f.runtime.operation).mockResolvedValue({ id: operationId, run_id: 'run', phase: 'running', outcome: null, effect: 'none' } as never);
  expect(await f.owner.reconcilePreparations(plan)).toEqual({ pending: true }); expect(f.records.has(ref)).toBe(true);
  vi.mocked(f.runtime.operation).mockResolvedValue({ id: operationId, run_id: 'run', phase: 'terminal', outcome: 'failed', effect: 'none' } as never);
  vi.mocked(f.runtime.run).mockResolvedValue({ thread_id: root.threadId } as never);
  expect(await f.owner.reconcilePreparations(plan)).toEqual({ pending: false });
  expect(f.records.has(ref)).toBe(false); expect(f.records.has(upload.ref)).toBe(true);
});

it('reconciles an unpublished delivery after lost observation only when the original Operation proves failure', async () => {
  const f = fixture(), attachment = await f.upload(root, 'original', Buffer.from('original'));
  await f.owner.prepare(root, [{ ref: attachment.ref }], 'failed-send', child.threadId);
  const plan = { attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [], attachments: [], threads: [{ threadId: root.threadId, rootThreadId: root.threadId, release: false }] };
  vi.mocked(f.runtime.operation).mockResolvedValue({ id: 'failed-send', run_id: 'run', phase: 'running', outcome: null, effect: 'none' } as never);
  expect(await f.owner.reconcilePreparations(plan)).toEqual({ pending: true });
  expect(await collected((await f.owner.read(child, attachment.ref)).stream)).toEqual(Buffer.from('original'));
  vi.mocked(f.runtime.operation).mockResolvedValue({ id: 'failed-send', run_id: 'run', phase: 'terminal', outcome: 'failed', effect: 'none' } as never);
  vi.mocked(f.runtime.run).mockResolvedValue({ thread_id: root.threadId } as never);
  expect(await f.owner.reconcilePreparations(plan)).toEqual({ pending: false });
  await expect(f.owner.read(child, attachment.ref)).rejects.toThrow('has not received');
  expect(await collected((await f.owner.read(root, attachment.ref)).stream)).toEqual(Buffer.from('original'));
});

it('delivers fixed source citations through existing attachments and retains them after sender deletion', async () => {
  const f = fixture(), scope = threadMaterialScope(root.threadId);
  const authority = (threadId: string) => ({ kind: 'thread' as const, owningWorkspaceId: scope, threadId });
  const snapshot = await f.materials.put(scope, { sourceUrl: 'https://example.com/source', finalUrl: 'https://example.com/source', representation: 'search-observation-v1',
    provenance: { kind: 'search-result', providerId: 'provider', contentKind: 'provider-excerpt' } }, Buffer.from('fixed original excerpt'), authority(child.threadId));
  const href = `varin-material://${snapshot.snapshotId}?contentHash=${snapshot.contentHash}&startLine=1&endLine=1`;
  await expect(f.owner.prepare(root, [{ ref: href }], 'forged', peer.threadId)).rejects.toThrow('not readable');
  const [attachment] = await f.owner.prepare(child, [{ ref: href }], 'report-source', root.threadId);
  expect(attachment!.ref).toMatch(/^attachment:material_/);
  expect((await f.reopen().read(scope, snapshot.snapshotId, authority(root.threadId)))?.body.toString()).toBe('fixed original excerpt');
  await f.owner.prepare(root, [{ ref: attachment!.ref }], 'forward-source', peer.threadId);
  await f.lifecycle.releaseThreadMaterials(scope, [child.threadId, root.threadId]);
  expect((await f.reopen().read(scope, snapshot.snapshotId, authority(peer.threadId)))?.body.toString()).toBe('fixed original excerpt');
  await expect(f.owner.prepare(peer, [{ ref: href.replace(snapshot.contentHash, `sha256-${'0'.repeat(64)}`) }], 'changed', peer.threadId)).rejects.toThrow('revision changed');
  await f.lifecycle.releaseThreadMaterials(scope, all.map(identity => identity.threadId));
  expect(await f.materials.read(scope, snapshot.snapshotId, authority(peer.threadId))).toBeNull();
});

it('lazily admits only Catalog-proven final source report references', async () => {
  const f = fixture(), scope = threadMaterialScope(root.threadId), authority = { kind: 'thread' as const, owningWorkspaceId: scope, threadId: child.threadId };
  const snapshot = await f.materials.put(scope, { sourceUrl: 'https://example.com/report', finalUrl: 'https://example.com/report', representation: 'markdown' }, Buffer.from('report evidence'), authority);
  const [attachment] = await f.owner.prepare(child, [{ ref: snapshot.snapshotId }], 'capture-source', child.threadId);
  vi.mocked(f.runtime.materialRetention).mockResolvedValue({ attachmentPreparations: [], attachmentSources: [], uiReferences: [], sources: [], inheritances: [],
    threads: [{ threadId: root.threadId, rootThreadId: root.threadId, release: false }],
    attachments: [{ holderKind: 'report', holderId: 'execution', threadId: root.threadId, branchId: root.branchId,
      sourceThreadId: child.threadId, sourceBranchId: child.branchId, attachments: [attachment!] }] });
  await f.owner.retainMaterial(root, snapshot.snapshotId);
  expect((await f.materials.read(scope, snapshot.snapshotId, { ...authority, threadId: root.threadId }))?.body.toString()).toBe('report evidence');
  await expect(f.owner.retainMaterial(peer, snapshot.snapshotId)).rejects.toThrow('has not received');
});

it('imports original event files through Catalog authorization and the existing Storage attachment owner', async () => {
  const f = fixture();
  const { createEventAttachmentCapture } = await import('./event-attachment-capture.js');
  const original = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600_000, 0x5a)]);
  const attachment = { ref: 'attachment:event_original', filename: 'Customer report.pdf', mimeType: 'application/pdf', byteLength: original.length };
  const contentHash = `sha256-${createHash('sha256').update(original).digest('hex')}`;
  const allowed = new Set([root.threadId, child.threadId]);
  const readEventAttachment = vi.fn(async (input: { threadId: string; ref: string; offset: number; length: number }) => {
    if (!allowed.has(input.threadId) || input.ref !== attachment.ref) throw new Error('Catalog denied original attachment');
    const nextOffset = Math.min(original.length, input.offset + input.length);
    return { attachment, contentHash, offset: input.offset, nextOffset, eof: nextOffset === original.length,
      bytesBase64: original.subarray(input.offset, nextOffset).toString('base64') };
  });
  f.owner.bindEventAttachmentCapture(createEventAttachmentCapture({ readEventAttachment }));
  const read = await f.owner.read(root, attachment.ref);
  expect(read.attachment).toEqual(attachment); expect(await collected(read.stream)).toEqual(original);
  expect(readEventAttachment.mock.calls.map(([input]) => input.offset)).toEqual([0, 256 * 1024, 512 * 1024]);
  const reads = readEventAttachment.mock.calls.length;
  expect(await collected((await f.owner.read(root, attachment.ref)).stream)).toEqual(original);
  expect(readEventAttachment).toHaveBeenCalledTimes(reads);
  expect(await collected((await f.owner.read(child, attachment.ref)).stream)).toEqual(original);
  expect(readEventAttachment.mock.calls.at(-1)?.[0].threadId).toBe(child.threadId);
  await expect(f.owner.read(peer, attachment.ref)).rejects.toThrow('Catalog denied');
  expect(f.records.get(attachment.ref)?.recordType).toBe('attachment.file');
  expect([...f.records.values()].some(record => record.recordType === 'attachment.delivery' && record.threadId === child.threadId)).toBe(true);
  allowed.delete(root.threadId);
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), root.threadId);
  expect(await collected((await f.owner.read(child, attachment.ref)).stream)).toEqual(original);
  allowed.delete(child.threadId);
  await f.lifecycle.releaseThreadMaterials(threadMaterialScope(root.threadId), child.threadId);
  await expect(f.owner.read(child, attachment.ref)).rejects.toThrow('Catalog denied');
});

it('does not publish an event attachment or delivery when original byte transfer fails', async () => {
  const f = fixture();
  const { createEventAttachmentCapture } = await import('./event-attachment-capture.js');
  const original = Buffer.alloc(300_000, 0x41);
  const attachment = { ref: 'attachment:event_incomplete', filename: 'dataset.csv', mimeType: 'text/csv', byteLength: original.length };
  const contentHash = `sha256-${createHash('sha256').update(original).digest('hex')}`;
  const readEventAttachment = vi.fn(async ({ offset, length }: { threadId: string; ref: string; offset: number; length: number }) => {
    const nextOffset = Math.min(original.length, offset + length);
    return { attachment, contentHash, offset: offset === 0 ? 0 : offset + 1, nextOffset, eof: nextOffset === original.length,
      bytesBase64: original.subarray(offset, nextOffset).toString('base64') };
  });
  f.owner.bindEventAttachmentCapture(createEventAttachmentCapture({ readEventAttachment }));
  await expect(f.owner.read(root, attachment.ref)).rejects.toThrow('transfer was incomplete');
  expect(f.records.has(attachment.ref)).toBe(false);
  expect([...f.records.values()].some(record => record.recordType === 'attachment.delivery')).toBe(false);
});
