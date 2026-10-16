import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, readThreadMedia, type ThreadIdentity } from '@varin/application-client';
import type { MediaReadChunk, MediaReadParams, OutputMediaHolder, StoredMedia } from '@varin/protocol';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:media', branchId: 'branch:media' };
const hash = `sha256-${'a'.repeat(64)}`;
const media: StoredMedia = { media_type: 'image/png', content_ref: { content_object: hash },
  source: { kind: 'tool', context: { run_id: 'run:original', operation_id: 'operation:original', origin: { kind: 'model_step', request_id: 'request:original' } } } };
const holder: OutputMediaHolder = { kind: 'history', itemId: 'history:original' };
const selection = { ...identity, holder, partIndex: 1, chunkIndex: 0, expectedContentRef: hash };

/** Original public client, authenticated route, ThreadAdapter and AgentRuntimeClient execute.
 * Only the final private RPC is controlled; this does not establish product socket transport
 * or duplicate Catalog's membership/epoch/content-integrity tests. */
function fixture() {
  let failure = false;
  let foreignChild = false;
  let beforeRead: ((signal: AbortSignal | undefined, method: string) => void) | undefined;
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    beforeRead?.(signal, method);
    signal?.throwIfAborted();
    if (method === 'runtime.thread.inspect') return { thread_id: identity.threadId, branches: [{ branch_id: identity.branchId }] };
    if (method === 'runtime.child.inspect' || method === 'runtime.child.execution.inspect') return {
      operation_id: 'child:original', execution_id: params.executionId ?? 'child:original',
      parent_thread_id: foreignChild ? 'thread:foreign' : identity.threadId,
      parent_branch_id: identity.branchId,
      child_thread_id: 'thread:child', child_branch_id: 'branch:child',
    };
    if (method === 'runtime.child.report.read' || method === 'runtime.child.execution.report.read') {
      const text = JSON.stringify({ data: null, parts: [{ kind: 'media', media }] });
      return { operation_id: 'child:original', execution_id: params.executionId ?? 'child:original',
        item_id: params.itemId, format: 'output_body', offset: params.offset,
        next_offset: null, total_bytes: new TextEncoder().encode(text).length, text };
    }
    expect(method).toBe('runtime.output.media.read');
    if (failure) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: original media identity changed' });
    return { media, partIndex: Number(params.partIndex), chunkIndex: Number(params.chunkIndex), chunkCount: 1, totalBytes: 3, bytesBase64: 'AQID' } satisfies MediaReadChunk;
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const adapter = new ThreadAdapter(runtime, { resolveModel: vi.fn(), rebindModel: vi.fn() }, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...chain: RequestHandler[]) => routes.set(path, chain), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'host-session') { response.status(401).end(); return; }
    next();
  };
  registerThreadRoutes(app, adapter, requireAuth);
  const request = async (path: string, body: unknown, authenticated = true, onResponse?: (response: EventEmitter) => void) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    onResponse?.(response);
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    const handlers = routes.get(path); if (!handlers) throw new Error(`Unknown route: ${path}`);
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  return { api: createThreadsHttpAPI(), requests, request, fail: () => { failure = true; }, foreign: () => { foreignChild = true; }, before: (hook: typeof beforeRead) => { beforeRead = hook; } };
}
afterEach(() => vi.unstubAllGlobals());

it('routes each original media holder unchanged through the authenticated public client and real Host owners', async () => {
  const f = fixture();
  const holders: OutputMediaHolder[] = [holder, { kind: 'input', inputId: 'input:original', expectedRevision: 4 },
    ...(['completion', 'result', 'external_receipt', 'mcp_task_result'] as const).map(output => ({ kind: 'operation' as const, operationId: 'operation:original', output })),
    { kind: 'event', cursor: 17, output: 'external_receipt' }, { kind: 'event', cursor: 18, output: 'mcp_task_result' },
    { kind: 'child_report', operationId: 'child:original', itemId: 'report:original' },
    { kind: 'child_report', operationId: 'child:original', executionId: 'execution:later', itemId: 'report:later' },
    { kind: 'policy_evidence', reference: { action_id: 'action:original', node_id: 'node:original', content_ref: hash } },
    { kind: 'family', threadId: 'thread:child', branchId: 'branch:child', runId: 'run:child', anchor: 'history:anchor', itemId: 'history:child' }];
  for (const selected of holders) {
    expect(await f.api.mediaRead({ ...selection, holder: selected })).toMatchObject({ media, partIndex: 1, bytesBase64: 'AQID' });
    const params = f.requests.mock.calls.filter(([method]) => method === 'runtime.output.media.read').at(-1)![1] as unknown as MediaReadParams;
    expect(params).toEqual({ threadId: identity.threadId, branchId: identity.branchId, holder: selected, partIndex: 1, chunkIndex: 0, expectedContentRef: hash });
  }
  expect(await readThreadMedia(f.api, { ...identity, holder, partIndex: 1 }, media)).toEqual(new Uint8Array([1, 2, 3]));
  const count = f.requests.mock.calls.length;
  expect((await f.request('/api/threads/media/read', selection, false)).status).toBe(401);
  expect(f.requests.mock.calls).toHaveLength(count);
  await expect(f.api.mediaRead({ ...selection, branchId: 'branch:other' })).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.filter(([method]) => method === 'runtime.output.media.read')).toHaveLength(holders.length + 1);
  expect((await f.request('/api/threads/media/read', { ...selection, arbitraryContentHash: hash })).status).toBe(400);
  f.fail();
  await expect(f.api.mediaRead(selection)).rejects.toMatchObject({ status: 409 });
});

it('closing a media observation aborts its original reader without cancelling its tool, Run or physical owner', async () => {
  for (const phase of ['runtime.thread.inspect', 'runtime.output.media.read']) {
    const f = fixture(); let response!: EventEmitter; let observed: AbortSignal | undefined;
    f.before((signal, method) => { if (method === phase) { observed = signal; response.emit('close'); } });
    await f.request('/api/threads/media/read', selection, true, value => { response = value; });
    expect(observed?.aborted).toBe(true);
    expect(f.requests.mock.calls.map(([method]) => method)).toEqual(phase === 'runtime.thread.inspect' ? [phase] : ['runtime.thread.inspect', phase]);
  }
});


it('keeps original and later child report pages on their real public routes, with original identity and reader cancellation', async () => {
  for (const later of [false, true]) {
    const f = fixture();
    const method = later ? 'runtime.child.execution.report.read' : 'runtime.child.report.read';
    const inspect = later ? 'runtime.child.execution.inspect' : 'runtime.child.inspect';
    const page = later
      ? await f.api.collaboration!.readExecutionReport(identity, 'execution:later', 'report:later', 0, 4096)
      : await f.api.collaboration!.readReport(identity, 'child:original', 'report:original', 0, 4096);
    expect(page.format).toBe('output_body');
    expect(JSON.parse(page.text).parts).toEqual([{ kind: 'media', media }]);
    expect(f.requests.mock.calls.map(([name]) => name)).toEqual(['runtime.thread.inspect', inspect, method]);
    expect(f.requests.mock.calls.at(-1)![1]).toEqual({ ...(later ? { executionId: 'execution:later' } : { operationId: 'child:original' }),
      itemId: later ? 'report:later' : 'report:original', offset: 0, maxBytes: 4096 });
    f.foreign();
    await expect(later ? f.api.collaboration!.readExecutionReport(identity, 'execution:later', 'report:later')
      : f.api.collaboration!.readReport(identity, 'child:original', 'report:original')).rejects.toMatchObject({ status: 400 });
    expect(f.requests.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
    for (const phase of ['runtime.thread.inspect', inspect, method]) {
      const stopped = fixture(); let response!: EventEmitter; let observed: AbortSignal | undefined;
      stopped.before((signal, name) => { if (name === phase) { observed = signal; response.emit('close'); } });
      await stopped.request(later ? '/api/threads/child/execution/report' : '/api/threads/child/report', {
        ...identity, ...(later ? { executionId: 'execution:later' } : { operationId: 'child:original' }),
        itemId: later ? 'report:later' : 'report:original', offset: 0, maxBytes: 4096,
      }, true, value => { response = value; });
      expect(observed?.aborted).toBe(true);
      expect(stopped.requests.mock.calls.map(([name]) => name)).toEqual(
        ['runtime.thread.inspect', inspect, method].slice(0, ['runtime.thread.inspect', inspect, method].indexOf(phase) + 1));
    }
  }
});
