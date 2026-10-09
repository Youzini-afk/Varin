import { expect, it } from 'vitest';
import { createRetrievalPipelineOwner, type RetrievalPipelineConfiguration } from './retrieval-pipeline.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const configuration = (name: string, selected: number): RetrievalPipelineConfiguration => ({ configurationId: name,
  model: { providerId: name, configurationId: name, status: 'ready', implementation: async () => [selected] } });
const invoke = (owner: ReturnType<typeof createRetrievalPipelineOwner>['capture']) => owner().model!({ question: 'pick code', snippets: [] }, new AbortController().signal);

it('a newer prepared candidate wins and superseded preparation cannot reactivate the previous selection', async () => {
  const owner = createRetrievalPipelineOwner(configuration('initial', 0));
  const slow = deferred<RetrievalPipelineConfiguration>();
  const pending = owner.replace(() => slow.promise);
  const rejected = expect(pending).rejects.toThrow(/superseded/);
  const current = await owner.replace(async () => configuration('newest', 2));
  slow.resolve(configuration('late-old-candidate', 1)); await rejected;
  expect(await invoke(owner.capture)).toEqual([2]);
  expect(owner.capture().plan).toBe(current);
});

it('invalid prepared stage leaves the previous callable selection active without advancing its generation', async () => {
  const owner = createRetrievalPipelineOwner(configuration('valid', 3));
  const before = owner.capture();
  await expect(owner.replace(async () => ({ configurationId: 'broken', semantic: { providerId: 'selected-missing', configurationId: 'broken', status: 'ready' } }))).rejects.toThrow(/no implementation/);
  expect(await invoke(owner.capture)).toEqual([3]); expect(owner.capture()).toBe(before);
  expect((await owner.replace(async () => configuration('valid-next', 4))).configurationGeneration).toBe(before.plan.configurationGeneration + 1);
});

it('captured semantic method handles do not follow a later mutation of the configuration object', async () => {
  const oldSearch = async () => ({ status: 'empty' as const, coverage: 'empty' as const, lifecycle: 'idle' as const, hits: [] });
  let newCalls = 0;
  const implementation = { search: oldSearch };
  const owner = createRetrievalPipelineOwner({ configurationId: 'mutable-input', semantic: { providerId: 'index', configurationId: 'v1', status: 'ready', implementation } });
  const captured = owner.capture();
  implementation.search = async () => { newCalls++; return oldSearch(); };
  await captured.semantic!.search('query');
  expect(newCalls).toBe(0);
  const next = await owner.replace(async () => ({ configurationId: 'replace-input', semantic: { providerId: 'index', configurationId: 'v2', status: 'ready', implementation } }));
  await owner.capture().semantic!.search('query'); expect(newCalls).toBe(1);
  await captured.semantic!.search('query'); expect(newCalls).toBe(1);
  expect(captured.plan.id).not.toBe(next.id);
});
