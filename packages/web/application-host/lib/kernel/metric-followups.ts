/** Transient observer of the original ResourceService. Catalog alone evaluates and retains edges. */
import { isDeepStrictEqual } from 'node:util';
import type { ResourceService, ResourceSample, ResourceMachineObservation } from '../harness/resources.js';
import type { KernelClient } from './kernel-client.js';
import type { FollowupMetricWork, FollowupMetricWorksResult, FollowupMetricSnapshot, FollowupMetricState, MetricMachineIdentity } from './protocol.generated.js';

const identity = (value: ResourceSample['identity']): MetricMachineIdentity => ({ host_id: value.hostId,
  machine_id: value.machineId, kind: value.kind, backend: value.backend, target_host_id: value.targetHostId });
export function metricSnapshot(source: FollowupMetricWork['source'], observed: ResourceMachineObservation): FollowupMetricSnapshot {
  if (source.kind !== 'metric') throw new Error('Original metric source changed');
  const sample = observed.sample;
  const base: FollowupMetricSnapshot = { identity: observed.identity ? identity(observed.identity) : null,
    machine_revision: observed.machineRevision, sample_revision: sample?.recordRevision ?? null,
    observed_at_ms: sample?.observedAt ?? null, status: 'missing', failure_code: null, value: null };
  const unavailable = (code: string, status: FollowupMetricSnapshot['status'] = 'unavailable') => ({ ...base, status, failure_code: code });
  if (!observed.identity) return unavailable('machine_missing', 'missing');
  if (observed.state === 'offline' || observed.state === 'retired' || observed.connection === 'offline' || observed.connection === 'unknown') return unavailable('machine_unavailable');
  if (observed.identity.kind !== 'local') return unavailable('machine_sampling_unsupported');
  if (!sample) return unavailable('sample_missing', 'missing');
  if (!isDeepStrictEqual(sample.identity, observed.identity)) return unavailable('source_identity_changed');
  if (observed.stale) return unavailable('sample_stale', 'stale');
  let value: number | undefined;
  if (source.metric === 'cpu_percent') value = sample.usage.cpuPercent;
  else if (source.metric === 'memory_mb') value = sample.usage.memoryMb;
  else {
    if (sample.gpuProbe?.status !== 'available') return unavailable(`gpu_${sample.gpuProbe?.reason?.replaceAll('-', '_') ?? 'unavailable'}`);
    const device = sample.usage.gpus?.find(gpu => gpu.uuid === source.gpu_uuid);
    if (!device) return unavailable('gpu_missing', 'missing');
    value = source.metric === 'gpu_percent' ? device.utilizationPercent : device.usedMemoryMb;
  }
  if (value === undefined || !Number.isFinite(value)) return unavailable('dimension_missing', 'missing');
  return { ...base, status: 'available', failure_code: null, value };
}
export function createMetricObserver(options: { kernel: KernelClient; resources: ResourceService;
  onError: (error: unknown) => void; onAccepted: () => Promise<unknown> }) {
  const controller = new AbortController();
  const demand = new Map<string, () => void>();
  type Pending = { work: FollowupMetricWork; samples: FollowupMetricSnapshot[]; observed: boolean; controller: AbortController };
  const readers = new Map<string, AbortController>();
  const queues = new Map<string, Pending>();
  const request = options.kernel.agentRuntimeRequest.bind(options.kernel);
  let dirty = false, started = false, discoveryDirty = false;
  let discovery: Promise<void> | undefined;
  let flight: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  const key = (work: FollowupMetricWork) => JSON.stringify([work.key.ownerEpoch, work.key.followupId, work.key.generation, work.key.sourceIndex, work.key.definitionRevision]);
  const publish = async (pending: Pending, snapshot: FollowupMetricSnapshot): Promise<boolean> => {
    controller.signal.throwIfAborted();
    pending.controller.signal.throwIfAborted();
    const work = pending.work;
    const result = await request<{ accepted: boolean; metric: FollowupMetricState | null }, 'runtime.followup.metric.observe'>(
      'runtime.followup.metric.observe', { key: work.key, expected: work.metric, snapshot, gap: !pending.observed }, AbortSignal.any([controller.signal, pending.controller.signal]));
    if (result.metric) work.metric = result.metric;
    if (result.accepted) void options.onAccepted().catch(options.onError);
    // An uncertain response never discards a callback. A later discovery can prove
    // that the original durable cursor already includes it; identity rejection is
    // also a durable diagnostic, not permission to bind a replacement machine.
    const consumed = result.accepted || (snapshot.sample_revision !== null && work.metric.sample_revision !== null
      && work.metric.sample_revision >= snapshot.sample_revision)
      || (work.metric.failure_code === 'source_identity_changed' && snapshot.identity !== null
        && work.metric.identity !== null && !isDeepStrictEqual(snapshot.identity, work.metric.identity));
    if (consumed) pending.observed = true;
    return consumed;
  };
  const discover = async () => {
    let after: string | undefined;
    const works: FollowupMetricWork[] = [];
    do {
      const page = await request<FollowupMetricWorksResult, 'runtime.followup.metrics'>('runtime.followup.metrics', after ? { after } : {}, controller.signal);
      works.push(...page.works);
      if (page.nextCursor !== null && page.nextCursor === after) throw new Error('Metric observation cursor did not advance');
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    const current = new Set(works.map(key));
    for (const [value, pending] of queues) if (!current.has(value)) { pending.controller.abort(); queues.delete(value); }
    // Each leaf's callback window starts before its first snapshot/demand. A new
    // registration cannot inherit another leaf's older buffered sample history.
    for (const work of works) {
      const old = queues.get(key(work));
      if (old) old.work.metric = work.metric;
      else queues.set(key(work), { work, samples: [], observed: false, controller: new AbortController() });
    }
    const machines = new Set(works.map(work => {
      if (work.source.kind !== 'metric') throw new Error('Original metric source changed');
      return work.source.machine_id;
    }));
    for (const [machine, release] of demand) if (!machines.has(machine)) { release(); demand.delete(machine); readers.get(machine)?.abort(); }
    for (const machine of machines) if (!demand.has(machine)) demand.set(machine, options.resources.retainSampling(machine));
  };
  const refresh = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    discoveryDirty = true;
    if (discovery) return discovery;
    discovery = (async () => { while (discoveryDirty && !controller.signal.aborted) { discoveryDirty = false; await discover(); } })()
      .finally(() => { discovery = undefined; if (discoveryDirty && !controller.signal.aborted) void refresh().then(observe).catch(options.onError); });
    return discovery;
  };
  const scan = async () => {
    const machines = [...demand.keys()];
    for (const machine of machines) {
      if (!demand.has(machine)) continue;
      const reading = new AbortController(); readers.set(machine, reading);
      let head: ResourceMachineObservation | undefined;
      let failed = false;
      try { head = await options.resources.observeMachine(machine, AbortSignal.any([controller.signal, reading.signal])); }
      catch (error) { if (!reading.signal.aborted && !controller.signal.aborted) { failed = true; options.onError(error); } }
      finally { if (readers.get(machine) === reading) readers.delete(machine); }
      if (reading.signal.aborted || !demand.has(machine)) continue;
      controller.signal.throwIfAborted();
      for (const pending of queues.values()) {
        const { work } = pending;
        if (pending.controller.signal.aborted) continue;
        if (work.source.kind !== 'metric' || work.source.machine_id !== machine) continue;
        const candidates = pending.samples.map(snapshot => ({ snapshot, queued: true }));
        if (head?.sample && !candidates.some(c => c.snapshot.sample_revision === head.sample!.recordRevision)) candidates.push({ snapshot: metricSnapshot(work.source, head), queued: false });
        candidates.sort((a, b) => (a.snapshot.sample_revision ?? 0) - (b.snapshot.sample_revision ?? 0));
        let stopped = false;
        try {
        for (const candidate of candidates) {
          const snapshot = candidate.snapshot;
          if (pending.controller.signal.aborted) { stopped = true; break; }
          if ((snapshot.sample_revision ?? 0) > (work.metric.sample_revision ?? 0)) {
            if (!await publish(pending, snapshot)) { await refresh(); dirty = true; stopped = true; break; }
          }
          // Only remove this leaf's exact callback after the original cursor/receipt
          // confirmed it. An exception or lost reply preserves every later sample.
          if (candidate.queued) {
            const index = pending.samples.indexOf(snapshot);
            if (index !== -1) pending.samples.splice(index, 1);
          }
        }
        if (stopped) continue;
        if (head && (!head.sample || head.sample.recordRevision >= (work.metric.sample_revision ?? 0))) {
          await publish(pending, metricSnapshot(work.source, head));
        } else if (failed) {
          await publish(pending, { identity: work.metric.identity, machine_revision: null,
            sample_revision: work.metric.sample_revision, observed_at_ms: work.metric.observed_at_ms,
            status: 'unavailable', failure_code: 'sample_read_failed', value: null });
        }
        } catch (error) { if (!pending.controller.signal.aborted && !controller.signal.aborted) options.onError(error); }
      }
    }
  };
  const observe = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    dirty = true;
    if (flight) return flight;
    flight = (async () => { while (dirty && !controller.signal.aborted) { dirty = false; await scan(); } })()
      .finally(() => { flight = undefined; if (dirty && !controller.signal.aborted) void observe().catch(options.onError); });
    return flight;
  };
  const reconcile = async () => { await refresh(); await observe(); };
  return { reconcile,
    start() {
      if (started || controller.signal.aborted) return; started = true;
      unsubscribe = options.resources.subscribeSamples(sample => {
        // Freshness is an original-owner fact at callback receipt. A slow read or
        // acceptance cannot age already observed crossings out of this transient FIFO.
        const observed = options.resources.sampleObservation(sample);
        for (const pending of queues.values()) {
          if (pending.work.source.kind === 'metric' && pending.work.source.machine_id === sample.machineId) pending.samples.push(metricSnapshot(pending.work.source, observed));
        }
        void observe().catch(error => { if (!controller.signal.aborted) options.onError(error); });
      });
    },
    async dispose() {
      controller.abort(); unsubscribe?.(); for (const release of demand.values()) release(); demand.clear();
      for (const pending of queues.values()) pending.controller.abort();
      for (const reading of readers.values()) reading.abort();
      await Promise.allSettled([...(flight ? [flight] : []), ...(discovery ? [discovery] : [])]); queues.clear();
    },
  };
}
