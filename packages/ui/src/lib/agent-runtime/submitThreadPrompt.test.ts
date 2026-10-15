import { beforeEach, expect, it, vi } from 'vitest';
import { submitThreadPrompt } from './submitThreadPrompt';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadIdentityKey, useThreadStore } from '@/stores/useThreadStore';
import { ThreadRequestError, type ThreadIdentity } from '@varin/application-client';
const fixture = vi.hoisted(() => ({ host: 1, api: { snapshot: vi.fn(), submit: vi.fn(), sources: { resolve: vi.fn() }, prepareSource: vi.fn(), goals: { start: vi.fn() } } }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => fixture.host }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ threads: fixture.api }) }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread', branchId: 'branch' };
const model = { providerId: 'explicit', modelId: 'chosen' };
const key = () => threadIdentityKey(useThreadStore.getState().hostKey, identity);
beforeEach(() => {
  vi.clearAllMocks(); fixture.host = 1; useThreadDraftStore.setState({ drafts: {} });
  fixture.api.snapshot.mockResolvedValue({ activeRun: null, historyPage: { head: 'head' } });
  fixture.api.sources.resolve.mockResolvedValue({ resourceOwner: { kind: 'local' }, workspaceId: 'workspace' });
  fixture.api.prepareSource.mockResolvedValue({ source: { workspaceId: 'workspace' } });
  fixture.api.submit.mockResolvedValue({ run_id: 'original-run' }); fixture.api.goals.start.mockResolvedValue({});
});
it('retries an uncertain native input using the original key, source and model', async () => {
  fixture.api.submit.mockRejectedValueOnce(new Error('reply lost'));
  await expect(submitThreadPrompt(identity, 'Original prompt', model, '/project')).rejects.toThrow('reply lost');
  expect(useThreadDraftStore.getState().drafts[key()].pendingInput?.status).toBe('unknown');
  await submitThreadPrompt(identity, 'Original prompt', model, '/project');
  expect(fixture.api.submit.mock.calls[1]).toEqual(fixture.api.submit.mock.calls[0]);
  expect(fixture.api.prepareSource).toHaveBeenCalledOnce();
  expect(useThreadDraftStore.getState().drafts[key()].text).toBe('');
});
it('rejects a different pending intent without overwriting the original draft', async () => {
  fixture.api.submit.mockRejectedValueOnce(new Error('reply lost'));
  await expect(submitThreadPrompt(identity, 'Original', model)).rejects.toThrow();
  await expect(submitThreadPrompt(identity, 'Replacement', model)).rejects.toThrow('Resolve the pending input');
  expect(useThreadDraftStore.getState().drafts[key()].text).toBe('Original');
  expect(fixture.api.submit).toHaveBeenCalledOnce();
});
it('does not prepare a source on a replacement Host after a delayed snapshot', async () => {
  fixture.api.snapshot.mockImplementationOnce(async () => { fixture.host += 1; return { activeRun: null, historyPage: { head: null } }; });
  await expect(submitThreadPrompt(identity, 'Original', model, '/project')).rejects.toThrow('Application Host changed');
  expect(fixture.api.sources.resolve).not.toHaveBeenCalled(); expect(fixture.api.submit).not.toHaveBeenCalled();
});
it('retains a Goal registration intent after its receipt is lost', async () => {
  fixture.api.goals.start.mockRejectedValueOnce(new Error('goal reply lost'));
  await expect(submitThreadPrompt(identity, 'Original', model, undefined, 'Finish work')).rejects.toThrow('goal reply lost');
  expect(useThreadDraftStore.getState().drafts[key()].pendingInput?.goalObjective).toBe('Finish work');
  await submitThreadPrompt(identity, 'Original', model, undefined, 'Finish work');
  expect(fixture.api.goals.start.mock.calls[1]).toEqual(fixture.api.goals.start.mock.calls[0]);
  expect(fixture.api.submit).toHaveBeenCalledOnce();
});

it('releases a rejected first attempt so the peripheral action can correct its prompt and model', async () => {
  fixture.api.submit.mockRejectedValueOnce(new ThreadRequestError(400, 'model-images-unsupported', 'not_started'));
  await expect(submitThreadPrompt(identity, 'Original', model)).rejects.toThrow();
  expect(useThreadDraftStore.getState().drafts[key()].pendingInput).toBeUndefined();
  await submitThreadPrompt(identity, 'Corrected', { ...model, modelId: 'replacement' });
  expect(fixture.api.submit.mock.calls[1][0]).toMatchObject({ text: 'Corrected', model: { modelId: 'replacement' } });
  expect(fixture.api.submit.mock.calls[1][0].key).not.toBe(fixture.api.submit.mock.calls[0][0].key);
});
it.each([new ThreadRequestError(409, 'thread-conflict'), new ThreadRequestError(413, 'http-body-too-large')])('does not infer rejection from an HTTP status alone', async error => {
  fixture.api.submit.mockRejectedValueOnce(error);
  await expect(submitThreadPrompt(identity, 'Original', model)).rejects.toThrow();
  await submitThreadPrompt(identity, 'Original', model);
  expect(fixture.api.submit.mock.calls[1]).toEqual(fixture.api.submit.mock.calls[0]);
});
it('does not release a previously uncertain submission when a later attempt never started', async () => {
  fixture.api.submit.mockRejectedValueOnce(new Error('reply lost')).mockRejectedValueOnce(new ThreadRequestError(400, 'model-images-unsupported', 'not_started'));
  await expect(submitThreadPrompt(identity, 'Original', model)).rejects.toThrow();
  await expect(submitThreadPrompt(identity, 'Original', model)).rejects.toThrow();
  await expect(submitThreadPrompt(identity, 'Different', model)).rejects.toThrow('Resolve the pending input');
  await submitThreadPrompt(identity, 'Original', model);
  expect(fixture.api.submit.mock.calls[2]).toEqual(fixture.api.submit.mock.calls[0]);
});

it('joins an in-flight delivery instead of starting a second admission when its view is reopened', async () => {
  let reject!: (error: Error) => void;
  fixture.api.submit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const first = submitThreadPrompt(identity, 'Original', model);
  await vi.waitFor(() => expect(fixture.api.submit).toHaveBeenCalledOnce());
  const reopened = submitThreadPrompt(identity, 'Original', model);
  reject(new ThreadRequestError(400, 'model-images-unsupported', 'not_started'));
  await expect(first).rejects.toThrow(); await expect(reopened).rejects.toThrow();
  expect(fixture.api.submit).toHaveBeenCalledOnce();
  expect(useThreadDraftStore.getState().drafts[key()].pendingInput).toBeUndefined();
});
