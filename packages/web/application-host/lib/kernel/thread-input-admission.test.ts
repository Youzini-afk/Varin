import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, ThreadRequestError, type ThreadSubmit } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { KernelClientError, KernelRequestError } from './kernel-error.js';
import { SourceAdmissionError } from './source-admission-error.js';
const identity = { runtime: 'agent' as const, threadId: 'thread:fixture', branchId: 'branch:fixture' };
const input: ThreadSubmit = { ...identity, key: 'input', expectedHead: null, text: 'Original', images: [{ mimeType: 'image/png', data: 'AQID' }], model: { providerId: 'provider', modelId: 'model' } };
function fixture() {
  const configuration = { providerId: 'provider', providerFamily: 'fixture', model: 'model', endpoint: 'http://fixture.invalid', credentialEnvironment: null, allowAnonymous: true, acceptsImages: true, configurationGeneration: 1, maxOutputTokens: null };
  const credentialOwner = new ExistingHostCredentialOwner({ runtime: { getAuth: async () => undefined }, providerId: 'provider', providerFamily: 'fixture',
    currentScope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }), endpoint: configuration.endpoint, allowAnonymous: true });
  const runtime = {
    thread: vi.fn(async () => ({ thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, active_run_id: 'run', latest_run: { id: 'run', configuration } }] })),
    submit: vi.fn(async () => ({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'run', input_id: 'input', cursor: 1 })),
  };
  const queued = {
    modelSelections: vi.fn(async () => ({ desired: null, active: null })), launch: vi.fn(async () => null), run: vi.fn(async () => ({ id: 'run', configuration })),
    enqueue: vi.fn(async () => ({ input_id: 'queued', run_id: 'run', mode: 'boundary' as const, cursor: 2 })),
    childForThread: vi.fn(async () => ({ child_branch_id: identity.branchId, operation_id: 'child' })),
    acceptChildContinuation: vi.fn(async () => ({ execution_id: 'continued' })),
  };
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })), rebindModel: vi.fn(async () => credentialOwner) };
  const source = vi.fn(async () => {});
  const adapter = new ThreadAdapter({ ...runtime, ...queued } as unknown as AgentRuntimeClient, models, source, vi.fn());
  vi.spyOn(adapter, 'continueLaunch').mockResolvedValue();
  const app = express(); app.use(express.json()); registerThreadRoutes(app, adapter, (_req, _res, next) => next());
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await request(app).post(new URL(url, 'http://fixture.invalid').pathname).send(JSON.parse(String(init.body)));
    return Response.json(response.body, { status: response.status });
  });
  return { api: createThreadsHttpAPI(), runtime, queued, models, source, configuration };
}
afterEach(() => vi.unstubAllGlobals());
it('reports model rejection before native acceptance, so the original draft can be corrected', async () => {
  const f = fixture(); f.configuration.acceptsImages = false;
  await expect(f.api.submit(input)).rejects.toMatchObject({ status: 400, code: 'model-images-unsupported', admission: 'not_started' });
  expect(f.runtime.submit).not.toHaveBeenCalled();
  expect(await f.api.submit({ ...input, images: [], key: 'corrected' })).toMatchObject({ run_id: 'run' });
});
it('preserves source-owner classification together with non-admission evidence', async () => {
  const f = fixture(); f.source.mockRejectedValueOnce(new SourceAdmissionError('source_authority_denied'));
  await expect(f.api.submit({ ...input, source: { mode: 'fixed_branch', resourceOwner: { kind: 'local' }, workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'source', revision: 0, tools: [] } })).rejects.toMatchObject({ status: 403, code: 'source_authority_denied', admission: 'not_started' });
  expect(f.runtime.submit).not.toHaveBeenCalled();
});
it('only accepts original method-matched transport evidence after entering native admission', async () => {
  const f = fixture();
  for (const [failure, admission] of [
    [new KernelRequestError({ code: 'unavailable', message: 'not dispatched' }, 'runtime.input.submit', 'not_dispatched'), 'not_started'],
    [new KernelRequestError({ code: 'unavailable', message: 'different request' }, 'runtime.thread.inspect', 'not_dispatched'), undefined],
    [new KernelRequestError({ code: 'operation-error', message: 'operation error: conflict: changed head' }, 'runtime.input.submit', 'response'), undefined],
    [new KernelClientError({ code: 'kernel-frame-too-large', message: 'unclassified write failure' }), undefined],
    [new Error('reply lost'), undefined],
  ] as const) {
    f.runtime.submit.mockRejectedValueOnce(failure);
    try { await f.api.submit(input); throw new Error('expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(ThreadRequestError); expect((error as ThreadRequestError).admission).toBe(admission); }
  }
});
it('classifies malformed input before calling the adapter rather than treating arbitrary 400 responses as rejected input', async () => {
  const f = fixture();
  await expect(f.api.submit({ ...input, images: [{ mimeType: 'image/png', data: 'invalid-base64' }] })).rejects.toMatchObject({ status: 400, admission: 'not_started' });
  expect(f.runtime.thread).not.toHaveBeenCalled(); expect(f.runtime.submit).not.toHaveBeenCalled();
});

it('applies the same pre-admission boundary to queue and delegated child sends', async () => {
  const f = fixture(); f.configuration.acceptsImages = false;
  const queued = { ...identity, key: 'queued', text: 'Original', ...(input.images ? { images: input.images } : {}), mode: 'boundary' as const };
  await expect(f.api.enqueue(queued)).rejects.toMatchObject({ code: 'model-images-unsupported', admission: 'not_started' });
  expect(f.queued.enqueue).not.toHaveBeenCalled();
  f.configuration.acceptsImages = true;
  f.queued.enqueue.mockRejectedValueOnce(new Error('lost native queue receipt'));
  await expect(f.api.enqueue(queued)).rejects.toMatchObject({ admission: undefined });
  f.queued.acceptChildContinuation.mockRejectedValueOnce(new KernelRequestError({ code: 'unavailable', message: 'not sent' }, 'runtime.child.continuation.accept', 'not_dispatched'));
  const continuation = { ...identity, key: 'continue', text: 'Original', previousRunId: 'old-run', expectedHead: null };
  await expect(f.api.collaboration!.continueChild(continuation)).rejects.toMatchObject({ admission: 'not_started' });
  f.queued.acceptChildContinuation.mockRejectedValueOnce(new Error('lost continuation receipt'));
  await expect(f.api.collaboration!.continueChild(continuation)).rejects.toMatchObject({ admission: undefined });
});
