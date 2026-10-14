import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import { WEB_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { createDocumentReader } from '../harness/document-reading.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { makePdf } from '../harness/pdf-test-fixture.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { Run } from './protocol.generated.js';
import { threadMaterialScope } from './material-storage.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { withToolInvocation } from './tool-invocation.js';
import { createWebRuntime } from './web-runtime.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:pdf', branchId: 'branch:pdf' };
const child: ThreadIdentity = { runtime: 'agent', threadId: 'thread:child', branchId: 'branch:child' };
const model = { providerId: 'fixture', modelId: 'fixture' };
const bytes = makePdf();
const upload = { filename: 'original.pdf', mimeType: 'application/pdf' as const, data: bytes.toString('base64') };
const sourceHash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
afterEach(() => vi.unstubAllGlobals());

/** Real client, Host admission, PDF engine, MaterialStore and document_read. Only Catalog
 * transport/blob persistence and model launch are controlled; this is not a Rust-storage test. */
function fixture() {
  const workspaceId = threadMaterialScope(identity.threadId);
  const store = createMaterialStoreFixture({ workspaceId });
  const unused = async (): Promise<never> => { throw new Error('PDF upload must not use network or source work'); };
  const configuration = { providerFamily: 'fixture', model: 'fixture', endpoint: 'http://fixture.invalid',
    credentialEnvironment: null, allowAnonymous: true, acceptsImages: true, maxOutputTokens: null, configurationGeneration: 1 };
  const run: Run = { id: 'run:pdf', thread_id: identity.threadId, branch_id: identity.branchId, state: 'waiting',
    revision: 1, epoch: 1, configuration, cancel_requested: false, waiting_on: null };
  const members = [identity, child];
  const runtime = {
    thread: vi.fn(async (threadId: string) => ({ thread_id: threadId, branches: members.filter(member => member.threadId === threadId)
      .map(member => ({ branch_id: member.branchId, head: null, active_run_id: run.id, latest_run: { ...run, thread_id: threadId, branch_id: member.branchId } })) })),
    familyList: vi.fn(async () => ({ rootThreadId: identity.threadId,
      members: members.map(member => ({ threadId: member.threadId, branches: [{ branchId: member.branchId }] })) })),
    launch: vi.fn(async () => null), run: vi.fn(async () => run),
    modelSelections: vi.fn(async () => ({ desired: null, active: null })),
    submit: vi.fn<AgentRuntimeClient['submit']>(async input => ({ thread_id: input.threadId, branch_id: input.branchId, run_id: run.id, input_id: 'input:pdf', cursor: 1 })),
    enqueue: vi.fn<AgentRuntimeClient['enqueue']>(async input => ({ run_id: run.id, input_id: 'input:queued', mode: input.mode, cursor: 2 })),
    childForThread: vi.fn(async (threadId: string) => threadId === child.threadId ? { child_branch_id: child.branchId, operation_id: 'operation:child' } : null),
    acceptChildContinuation: vi.fn<AgentRuntimeClient['acceptChildContinuation']>(async () => ({ execution_id: 'execution:child' }) as never),
  };
  const catalog = runtime as unknown as AgentRuntimeClient;
  const documentReader = createDocumentReader({ materials: store.materials });
  const web = createWebRuntime({ runtime: catalog, materials: store.materials, documentReader,
    webFetch: createWebFetch({ ssrf: { check: unused, isSameHost: () => false }, materials: store.materials, documentReader }),
    fetch: unused, readAuth: unused,
    settings: async () => ({ global: {}, project: {}, globalRevision: 'global', projectRevision: 'project', projectTrusted: false }) });
  const credentialOwner = { scope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }), release() {} } as unknown as ExistingHostCredentialOwner;
  const adapter = new ThreadAdapter(catalog, { resolveModel: async () => ({ configuration, credentialOwner }), rebindModel: unused }, unused, () => {});
  adapter.bindMaterials(web.inputMaterials);
  vi.spyOn(adapter, 'continueLaunch').mockResolvedValue();
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers), get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'pdf-user') { response.status(401).end(); return; } next();
  }, undefined, undefined, web.user);
  const request = async (path: string, body: unknown, authenticated = true) => {
    let status = 200, output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; } });
    const handlers = routes.get(`/api/threads/${path}`)!;
    const input = { body, headers: authenticated ? { authorization: 'pdf-user' } : {} } as Request;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'https://fixture.invalid').pathname.replace('/api/threads/', ''), JSON.parse(String(init.body))));
  const api = createThreadsHttpAPI();
  const uploaded = async (owner = identity) => {
    const result = await api.materials.upload(owner, upload);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || !result.sourceSnapshot) throw new Error('Original PDF snapshot was not retained');
    return result.sourceSnapshot;
  };
  return { api, runtime, web, store, workspaceId, request, uploaded };
}

it('uploads original PDF bytes through the authenticated Thread boundary and reads the same source through document_read', async () => {
  const f = fixture();
  const snapshot = await f.uploaded();
  expect(snapshot.document?.source).toEqual({ contentHash: sourceHash, byteLength: bytes.length, contentType: 'application/pdf' });
  const retained = await f.store.reopen().read(f.workspaceId, snapshot.snapshotId,
    { kind: 'thread', owningWorkspaceId: f.workspaceId, threadId: identity.threadId }, { includeSource: true });
  expect(retained?.source?.bytes.equals(bytes)).toBe(true);
  expect(retained?.body.length).toBe(0);
  expect((await f.uploaded()).snapshotId).toBe(snapshot.snapshotId);
  const declaration = WEB_TOOL_DECLARATIONS.find(value => value.tool!.name === 'document_read')!;
  const configuration = await f.web.prepareConfiguration({ runId: 'run:pdf', threadId: identity.threadId, source: null }, []);
  const args = { snapshotId: snapshot.snapshotId, view: 'text' }, signal = new AbortController().signal;
  const owner = { extensionId: 'varin.builtin.web', extensionVersion: '0.1.0', entrypointId: 'host', instanceKey: 'pdf-input-fixture', generation: 1 };
  let result: import('./tool-bridge.js').ToolExecutionReceipt | undefined;
  await withToolInvocation({ owner, signal, onEffectReceipt: value => { result = value; }, authority: {
    invocationId: 'invocation:pdf', runId: 'run:pdf', threadId: identity.threadId, operationId: 'request:pdf:tool:call:pdf', callId: 'call:pdf',
    origin: { kind: 'model_step', request_id: 'request:pdf' }, executorOwner: { kind: 'external', identity: 'provider', epoch: 'owner' },
    source: null, operation: 'read', completion: 'result', toolName: 'document_read', configurationIdentity: configuration(declaration), arguments: args,
  } }, async invocation => { await f.web.capability('read', args, { owner, signal, invocation }); });
  expect(result).toMatchObject({ completion: { outcome: 'succeeded', content: { data: { status: 'ok', sourceSnapshot: { snapshotId: snapshot.snapshotId },
    overview: { sourceHash }, markdown: expect.stringContaining('LEFT') } } } });
  const text = await f.api.materials.read(identity, { snapshotId: snapshot.snapshotId, view: 'text' });
  expect(text).toMatchObject({ status: 'ok', markdown: expect.stringContaining('RIGHT'), sourceSnapshot: { snapshotId: snapshot.snapshotId } });
});

it('passes authoritative fixed provenance into native submit and all three enqueue forms without resending PDF bytes', async () => {
  const f = fixture();
  const snapshot = await f.uploaded(), materials = [{ snapshotId: snapshot.snapshotId }];
  const command = { ...identity, key: 'pdf-submit', expectedHead: null, text: 'Read this original.', materials, model };
  await f.api.submit(command); await f.api.submit(command);
  expect(f.runtime.submit.mock.calls[1]![0].input).toEqual(f.runtime.submit.mock.calls[0]![0].input);
  const submitted = f.runtime.submit.mock.calls[0]![0].input as { text: string; attachments?: unknown[] };
  expect(submitted.attachments).toBeUndefined();
  expect(submitted.text).toContain('Read this original.');
  expect(submitted.text).not.toContain(upload.data);
  expect(JSON.parse(submitted.text.split('\n').at(-1)!)).toEqual([{ snapshotId: snapshot.snapshotId, sourceSnapshotId: snapshot.snapshotId,
    filename: upload.filename, sourceUrl: snapshot.sourceUrl, sourceHash, byteLength: bytes.length, mimeType: 'application/pdf' }]);
  for (const mode of ['boundary', 'interrupt', 'next_run'] as const) {
    await f.api.enqueue({ ...identity, key: `pdf-${mode}`, text: '', mode, materials });
    const queued = f.runtime.enqueue.mock.calls.at(-1)![0];
    expect(queued.mode).toBe(mode);
    expect(queued.input).toEqual({ text: submitted.text.replace('Read this original.\n\n', '') });
  }
});

it('continues only the original child with PDF references readable by that child', async () => {
  const f = fixture();
  const snapshot = await f.uploaded(child);
  await f.api.collaboration!.continueChild({ ...child, key: 'child-pdf', previousRunId: 'run:child', expectedHead: null,
    text: '', materials: [{ snapshotId: snapshot.snapshotId }] });
  expect(f.runtime.acceptChildContinuation).toHaveBeenCalledWith(expect.objectContaining({ childOperationId: 'operation:child',
    input: { text: expect.stringContaining(snapshot.snapshotId) } }), expect.any(AbortSignal));
  expect(await f.api.materials.read(child, { snapshotId: snapshot.snapshotId, view: 'text' })).toMatchObject({ status: 'ok', markdown: expect.stringContaining('LEFT') });
  await expect(f.api.submit({ ...identity, key: 'foreign-child-pdf', expectedHead: null, text: 'Read', model,
    materials: [{ snapshotId: snapshot.snapshotId }] })).rejects.toMatchObject({ admission: 'not_started' });
  expect(f.runtime.submit).not.toHaveBeenCalled();
});

it('rejects forged scope, provenance, invalid PDF bytes and revoked access before native input admission', async () => {
  const f = fixture();
  expect((await f.request('materials/upload', { ...identity, request: upload }, false)).status).toBe(401);
  expect((await f.request('materials/upload', { ...identity, branchId: child.branchId, request: upload })).status).toBe(403);
  for (const request of [{ ...upload, data: 'bm90IGEgcGRm' }, { ...upload, mimeType: 'text/plain' }, { ...upload, filename: '../outside.pdf' }, { ...upload, workspaceId: 'forged' }]) {
    expect((await f.request('materials/upload', { ...identity, request })).status).toBe(400);
  }
  expect(f.store.records.size).toBe(0);
  const snapshot = await f.uploaded();
  expect((await f.request('submit', { ...identity, key: 'forged', text: '', expectedHead: null, model,
    materials: [{ snapshotId: snapshot.snapshotId, sourceHash: 'forged' }] })).status).toBe(400);
  await f.store.lifecycle.releaseThreadMaterials(f.workspaceId, identity.threadId);
  await expect(f.api.submit({ ...identity, key: 'released', text: '', expectedHead: null, model,
    materials: [{ snapshotId: snapshot.snapshotId }] })).rejects.toMatchObject({ admission: 'not_started' });
  expect(f.runtime.submit).not.toHaveBeenCalled();
  await expect(f.api.enqueue({ ...identity, key: 'released-queued', text: '', mode: 'interrupt',
    materials: [{ snapshotId: snapshot.snapshotId }] })).rejects.toMatchObject({ admission: 'not_started' });
  expect(f.runtime.enqueue).not.toHaveBeenCalled();
});
