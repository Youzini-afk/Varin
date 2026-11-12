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
import { BrokeredHostUnavailableError } from '@varin/extension-host';
const identity = { runtime: 'agent' as const, threadId: 'thread:fixture', branchId: 'branch:fixture' };
const input: ThreadSubmit = { ...identity, key: 'input', expectedHead: null, text: 'Original', images: [{ mimeType: 'image/png', data: 'AQID' }], model: { providerId: 'provider', modelId: 'model' } };
function fixture() {
  const configuration = { providerId: 'provider', providerFamily: 'fixture', model: 'model', endpoint: 'http://fixture.invalid', credentialEnvironment: null, allowAnonymous: true, acceptsImages: true, configurationGeneration: 1, maxOutputTokens: null };
  const credentialOwner = new ExistingHostCredentialOwner({ runtime: { getAuth: async () => undefined }, providerId: 'provider', providerFamily: 'fixture',
    currentScope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }), endpoint: configuration.endpoint, allowAnonymous: true });
  const runtime = {
    createThread: vi.fn<AgentRuntimeClient['createThread']>(async (threadId, branchId) => ({ threadId, branchId })),
    inputReceipt: vi.fn<AgentRuntimeClient['inputReceipt']>(async () => null),
    inheritedInputReceipt: vi.fn<AgentRuntimeClient['inheritedInputReceipt']>(async () => null),
    thread: vi.fn(async () => ({ thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, active_run_id: 'run', latest_run: { id: 'run', configuration } }] })),
    submit: vi.fn(async () => ({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'run', input_id: 'input', cursor: 1 })),
  };
  const queued = {
    enqueueReceipt: vi.fn(async () => null), childExecutions: vi.fn(async () => []),
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
  return { api: createThreadsHttpAPI(), adapter, runtime, queued, models, source, configuration };
}
afterEach(() => vi.unstubAllGlobals());
it('supplies a device default for source-less sends while keeping explicit sources and inheritance intent', async () => {
  const f = fixture();
  const fallback = { resourceOwner: { kind: 'local' as const }, workspaceId: 'device', executionWorkspaceId: 'device',
    mode: 'live_root' as const, liveRoot: { hostId: 'host', rootId: 'home-root', canonicalRoot: '/home/user' }, tools: ['file_read', 'process_spawn'] };
  const prepare = vi.fn(async () => fallback);
  f.adapter.bindDefaultDeviceSource(prepare);
  await f.api.submit(input);
  expect(f.runtime.submit).toHaveBeenLastCalledWith(expect.objectContaining({ launch: expect.objectContaining({
    inheritSource: true, source: expect.objectContaining({ workspaceId: 'device' }), enabledTools: fallback.tools,
  }) }));
  const project = { ...fallback, workspaceId: 'project', executionWorkspaceId: 'project' };
  await f.api.submit({ ...input, source: project });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(f.runtime.submit).toHaveBeenLastCalledWith(expect.objectContaining({ launch: expect.objectContaining({
    inheritSource: false, source: expect.objectContaining({ workspaceId: 'project' }),
  }) }));
});
it('reports an unavailable extension process as a service failure before admission', async () => {
  const f = fixture();
  f.models.resolveModel.mockRejectedValueOnce(new BrokeredHostUnavailableError('private process diagnostic'));
  await expect(f.api.submit(input)).rejects.toMatchObject({
    status: 503, code: 'extension-host-unavailable', admission: 'not_started',
    message: 'The local extension process is unavailable. Restart Varin; if it persists, reinstall the application.',
  });
  expect(f.runtime.submit).not.toHaveBeenCalled();
});
it('attaches sending-device or selected-zone time only when enabled, across submit, queue and continuation', async () => {
  const f = fixture();
  const settings = { enabled: false, timeZone: null as string | null };
  f.adapter.bindMessageTime(async () => settings);
  const timed = { ...input, clientTime: { sentAt: '2026-01-01T16:05:06Z', timeZone: 'Asia/Shanghai' } };
  await f.api.submit(timed);
  expect(f.runtime.submit).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.not.objectContaining({ sentTime: expect.anything() }) }));
  settings.enabled = true;
  await f.api.submit(timed);
  expect(f.runtime.submit).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ sentTime: '2026-01-02T00:05:06+08:00 [Asia/Shanghai]' }) }));
  settings.timeZone = 'America/New_York';
  const content = { ...identity, key: 'timed-send', text: timed.text, ...(timed.images ? { images: timed.images } : {}), clientTime: timed.clientTime };
  await f.api.enqueue({ ...content, mode: 'boundary' });
  expect(f.queued.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ sentTime: '2026-01-01T11:05:06-05:00 [America/New_York]' }) }));
  await f.api.collaboration!.continueChild({ ...content, expectedHead: null, previousRunId: 'old-run' });
  expect(f.queued.acceptChildContinuation).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ sentTime: '2026-01-01T11:05:06-05:00 [America/New_York]' }) }), expect.any(AbortSignal));
});
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
    [new KernelRequestError({ code: 'operation-error', message: 'operation error: conflict: changed head' }, 'runtime.input.submit', 'response'), 'not_started'],
    [new KernelClientError({ code: 'kernel-frame-too-large', message: 'unclassified write failure' }), undefined],
    [new Error('reply lost'), undefined],
  ] as const) {
    f.runtime.submit.mockRejectedValueOnce(failure);
    try { await f.api.submit(input); throw new Error('expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(ThreadRequestError); expect((error as ThreadRequestError).admission).toBe(admission); }
  }
});
it('recovers an accepted native receipt after an explicit failure, and keeps a failed receipt observation unknown', async () => {
  const f = fixture();
  const failure = new KernelRequestError({ code: 'operation-error', message: 'native reply failed' }, 'runtime.input.submit', 'response');
  const receipt = { thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'run', input_id: 'input', cursor: 1 };
  f.runtime.submit.mockRejectedValueOnce(failure);
  f.runtime.inputReceipt.mockResolvedValueOnce(receipt);
  await expect(f.api.submit(input)).resolves.toEqual(receipt);
  expect(f.runtime.submit).toHaveBeenCalledOnce();
  f.runtime.submit.mockRejectedValueOnce(failure);
  f.runtime.inputReceipt.mockRejectedValueOnce(new Error('receipt unavailable'));
  await expect(f.api.submit(input)).rejects.toMatchObject({ admission: undefined });
});
it('keeps context preparation conflicts as conflicts before input admission', async () => {
  const f = fixture();
  f.models.resolveModel.mockRejectedValueOnce(new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: active context checkpoint changed' }));
  await expect(f.api.submit(input)).rejects.toMatchObject({ status: 409, code: 'thread-conflict', admission: 'not_started' });
  expect(f.runtime.submit).not.toHaveBeenCalled();
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

it('replays an accepted inherited-source input before consulting a now-offline project owner', async () => {
  const f = fixture(); const receipt = { thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'run', input_id: 'input', cursor: 1 };
  f.runtime.inheritedInputReceipt.mockResolvedValue(receipt);
  const offline = vi.fn(async (): Promise<never> => { throw new Error('Original project is now offline'); }); f.adapter.bindDefaultDeviceSource(offline);
  expect(await f.api.submit(input)).toEqual(receipt); expect(offline).not.toHaveBeenCalled(); expect(f.runtime.submit).not.toHaveBeenCalled();
  expect(f.runtime.inheritedInputReceipt).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ text: 'Original' }), launch: expect.objectContaining({ inheritSource: true, source: null }) }));
});
it('does not treat an original-source intent mismatch as authorization to accept a replacement', async () => {
  const f = fixture(); f.runtime.inheritedInputReceipt.mockRejectedValue(new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: idempotency key has different input' }));
  const prepare = vi.fn(); f.adapter.bindDefaultDeviceSource(prepare);
  await expect(f.api.submit(input)).rejects.toMatchObject({ code: 'thread-conflict' }); expect(prepare).not.toHaveBeenCalled(); expect(f.runtime.submit).not.toHaveBeenCalled();
});

it('preserves explicit chat-only source through HTTP without applying creation defaults', async () => {
  const f = fixture(); const prepare = vi.fn(async (): Promise<never> => { throw new Error('Project offline'); });
  f.adapter.bindDefaultDeviceSource(prepare);
  await expect(f.api.submit({ ...input, source: null })).resolves.toMatchObject({ run_id: 'run' });
  expect(prepare).not.toHaveBeenCalled(); expect(f.runtime.inheritedInputReceipt).not.toHaveBeenCalled();
  expect(f.runtime.submit).toHaveBeenCalledWith(expect.objectContaining({ launch: expect.objectContaining({ inheritSource: false, source: null, enabledTools: [] }) }));
});

it('accepts the selected organization placement through the public create HTTP allowlist', async () => {
  const f = fixture();
  const result = await f.api.create('organized-draft', { organization: { containerId: 'project-group' } });
  expect(f.runtime.createThread).toHaveBeenCalledWith(result.threadId, result.branchId, undefined, undefined, { containerId: 'project-group' }, undefined);
  await f.api.create('explicit-root', { organization: { containerId: null } });
  expect(f.runtime.createThread.mock.calls.at(-1)?.[4]).toEqual({ containerId: null });
  await expect(f.api.create('malformed', { organization: { containerId: 'group', principalId: 'forged' } as never })).rejects.toMatchObject({ status: 400 });
  expect(f.runtime.createThread).toHaveBeenCalledTimes(2);
});
