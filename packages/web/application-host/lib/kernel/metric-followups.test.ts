import { expect, it, vi } from 'vitest';
import { createMetricObserver, metricSnapshot } from './metric-followups.js';
import type { FollowupMetricObserveParams, FollowupMetricWork, FollowupMetricState } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import { createResourceService, type ResourceService, type ResourceSample } from '../harness/resources.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const source = { workspace_id: 'workspace', execution_workspace_id: 'execution', mode: 'fixed_branch' as const, branch_id: 'source', revision: 1, live_root: null };
const initial = (): FollowupMetricState => ({ identity: null, sample_revision: null, observed_at_ms: null, status: 'missing', failure_code: 'sample_pending', holding: null, value: null, gap: true });
const work = (): FollowupMetricWork => ({ key: { followupId: 'metric', generation: 1, sourceIndex: 0, definitionRevision: 1, ownerEpoch: 1 },
  observer: { rootThreadId: 'root', threadId: 'root', branchId: 'branch', sourceRunId: 'run', source, canSubmit: true, readThreadIds: ['root'], controlThreadIds: ['root'] },
  source: { kind: 'metric', machine_id: 'local', metric: 'cpu_percent', predicate: 'above', threshold: 90 }, metric: initial() });
const sample = (revision: number, value: number): ResourceSample => ({ machineId: 'local', recordRevision: revision, observedAt: 100, source: 'host-os',
  identity: { hostId: 'host', machineId: 'local', kind: 'local', backend: null, targetHostId: null }, machineRevision: 1, usage: { cpuPercent: value } });
const observation = (value: ResourceSample) => ({ identity: value.identity, machineRevision: 1, state: 'available', connection: 'connected', sample: value, stale: false });

it('preserves callback FIFO across a held acceptance and a lost reply, independently of delivery', async () => {
  const entered = deferred(), held = deferred(); const actual = work(); let head = sample(1, 0), lose = true;
  let listener = (_sample: ResourceSample) => {}; const errors: unknown[] = [], crossings: number[] = [];
  const resources = { subscribeSamples: (fn: typeof listener) => { listener = fn; return () => {}; }, retainSampling: () => () => {},
    observeMachine: async () => observation(head), sampleObservation: observation } as unknown as ResourceService;
  const kernel = { agentRuntimeRequest: async (method: string, input: unknown) => {
    if (method === 'runtime.followup.metrics') return { works: [structuredClone(actual)], nextCursor: null };
    if (method !== 'runtime.followup.metric.observe') throw new Error(method);
    const p = input as FollowupMetricObserveParams;
    if (lose) { entered.resolve(); await held.promise; }
    if (JSON.stringify(actual.metric) !== JSON.stringify(p.expected)) return { accepted: false, metric: structuredClone(actual.metric) };
    const previous = actual.metric;
    const holding = p.snapshot.status === 'available' ? p.snapshot.value! > 90 : previous.holding;
    actual.metric = { identity: p.snapshot.identity, sample_revision: p.snapshot.sample_revision, observed_at_ms: p.snapshot.observed_at_ms,
      value: p.snapshot.value, status: p.snapshot.status, failure_code: p.snapshot.failure_code, holding, gap: p.gap };
    if (holding && !previous.holding) crossings.push(p.snapshot.sample_revision!);
    if (lose) { lose = false; throw new Error('accepted metric reply lost'); }
    return { accepted: JSON.stringify(previous) !== JSON.stringify(actual.metric), metric: structuredClone(actual.metric) };
  } } as unknown as KernelClient;
  const observer = createMetricObserver({ kernel, resources, onError: error => errors.push(error), onAccepted: async () => {} });
  observer.start(); const first = observer.reconcile(); await entered.promise;
  for (const [revision, value] of [[2, 95], [3, 0], [4, 99]]) { head = sample(revision!, value!); listener(head); }
  held.resolve(); await first; await observer.reconcile();
  expect(crossings).toEqual([2, 4]); expect(actual.metric.sample_revision).toBe(4);
  expect(errors.map(String)).toEqual(['Error: accepted metric reply lost']); await observer.dispose();
});

it('retains callback-time freshness through a long backlog while recovery heads and already stale callbacks stay unknown', async () => {
  const entered = deferred(), held = deferred(); const actual = work(); let now = 100, reads = 0, head = sample(1, 0);
  let listener = (_sample: ResourceSample) => {}; const crossings: number[] = [], published: FollowupMetricObserveParams[] = [];
  // Use the original owner's freshness policy; only the read and Catalog ports are controlled.
  const owner = createResourceService({ now: () => now, client: {
    subscribeExit: () => () => {}, subscribeReady: () => () => {},
  } as unknown as KernelClient });
  const resources = { subscribeSamples: (fn: typeof listener) => { listener = fn; return () => { listener = () => {}; }; },
    retainSampling: () => () => {}, sampleObservation: owner.sampleObservation,
    observeMachine: async () => { if (++reads === 1) { entered.resolve(); await held.promise; } return owner.sampleObservation(head); },
  } as unknown as ResourceService;
  const kernel = { agentRuntimeRequest: async (method: string, input: unknown) => {
    if (method === 'runtime.followup.metrics') return { works: [structuredClone(actual)], nextCursor: null };
    if (method !== 'runtime.followup.metric.observe') throw new Error(method);
    const p = input as FollowupMetricObserveParams; const previous = actual.metric;
    if (JSON.stringify(previous) !== JSON.stringify(p.expected)) return { accepted: false, metric: structuredClone(previous) };
    const holding = p.snapshot.status === 'available' ? p.snapshot.value! > 90 : previous.holding;
    actual.metric = { identity: p.snapshot.identity, sample_revision: p.snapshot.sample_revision, observed_at_ms: p.snapshot.observed_at_ms,
      value: p.snapshot.value, status: p.snapshot.status, failure_code: p.snapshot.failure_code, holding, gap: p.gap };
    const accepted = JSON.stringify(previous) !== JSON.stringify(actual.metric);
    if (accepted) published.push(structuredClone(p));
    if (holding && !previous.holding) crossings.push(p.snapshot.sample_revision!);
    return { accepted, metric: structuredClone(actual.metric) };
  } } as unknown as KernelClient;
  const create = () => createMetricObserver({ kernel, resources, onError: error => { throw error; }, onAccepted: async () => {} });
  let observer = create();
  try {
    observer.start(); const first = observer.reconcile(); await entered.promise;
    for (const [revision, value] of [[1, 0], [2, 95], [3, 0], [4, 99]]) { head = sample(revision!, value!); listener(head); }
    now += 120_001; held.resolve(); await first;
    expect(published.slice(0, 4).map(p => [p.snapshot.sample_revision, p.snapshot.status, p.snapshot.value]))
      .toEqual([[1, 'available', 0], [2, 'available', 95], [3, 'available', 0], [4, 'available', 99]]);
    expect(crossings).toEqual([2, 4]);
    await observer.dispose(); head = sample(5, 0); actual.key.ownerEpoch++;
    observer = create(); observer.start(); await observer.reconcile();
    expect(published.find(p => p.snapshot.sample_revision === 5)).toMatchObject({ gap: true,
      snapshot: { status: 'stale', failure_code: 'sample_stale', value: null } });
    head = sample(6, 99); listener(head); await observer.reconcile();
    expect(actual.metric).toMatchObject({ sample_revision: 6, status: 'stale', value: null, holding: true });
    expect(crossings).toEqual([2, 4]);
  } finally { held.resolve(); await observer.dispose(); await owner.dispose(); }
});

it('releases original demand while an independent sample read is held and does not let a later registration consume older callbacks', async () => {
  const entered = deferred(), held = deferred(); let active = true, demand = 0, reads = 0, publications = 0;
  const actual = work(); let listener = (_sample: ResourceSample) => {};
  const resources = { subscribeSamples: (fn: typeof listener) => { listener = fn; return () => {}; },
    retainSampling: () => { demand++; return () => { demand--; }; },
    observeMachine: async () => { reads++; if (reads === 1) { entered.resolve(); await held.promise; } return observation(sample(3, 0)); }, sampleObservation: observation } as unknown as ResourceService;
  const kernel = { agentRuntimeRequest: async (method: string, input: unknown) => {
    if (method === 'runtime.followup.metrics') return { works: active ? [structuredClone(actual)] : [], nextCursor: null };
    publications++; const p = input as FollowupMetricObserveParams;
    actual.metric = { ...actual.metric, identity: p.snapshot.identity, sample_revision: p.snapshot.sample_revision, observed_at_ms: p.snapshot.observed_at_ms,
      status: p.snapshot.status, failure_code: p.snapshot.failure_code, value: p.snapshot.value, holding: false, gap: p.gap };
    return { accepted: true, metric: structuredClone(actual.metric) };
  } } as unknown as KernelClient;
  const observer = createMetricObserver({ kernel, resources, onError: error => { throw error; }, onAccepted: async () => {} });
  observer.start(); const first = observer.reconcile(); await entered.promise; listener(sample(1, 99));
  active = false; const paused = observer.reconcile(); await vi.waitFor(() => expect(demand).toBe(0));
  listener(sample(2, 99)); held.resolve(); await Promise.all([first, paused]); expect(publications).toBe(0);
  active = true; actual.key.definitionRevision++; await observer.reconcile();
  expect(actual.metric.sample_revision).toBe(3); expect(actual.metric.holding).toBe(false); await observer.dispose();
});

it('selects stable GPU UUIDs and preserves source unavailable, missing and stale facts', () => {
  const gpu = { ...work().source, kind: 'metric' as const, machine_id: 'local', metric: 'gpu_percent' as const, gpu_uuid: 'GPU-a', predicate: 'above' as const, threshold: 90 };
  const value = sample(1, 99); value.gpuProbe = { status: 'available' }; value.usage.gpus = [{ index: 7, uuid: 'GPU-a', utilizationPercent: 98 }, { index: 0, uuid: 'GPU-b', utilizationPercent: 0 }];
  expect(metricSnapshot(gpu, observation(value))).toMatchObject({ status: 'available', value: 98 });
  value.usage.gpus = [{ index: 7, uuid: 'GPU-b', utilizationPercent: 99 }];
  expect(metricSnapshot(gpu, observation(value))).toMatchObject({ status: 'missing', failure_code: 'gpu_missing', value: null });
  expect(metricSnapshot(gpu, { ...observation(value), stale: true })).toMatchObject({ status: 'stale', value: null });
  expect(metricSnapshot(gpu, { ...observation(value), connection: 'offline' })).toMatchObject({ status: 'unavailable', value: null });
});
