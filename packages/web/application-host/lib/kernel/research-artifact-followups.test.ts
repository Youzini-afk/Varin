import assert from 'node:assert/strict';
import { it, vi } from 'vitest';
import { createResearchRuntime } from './research-runtime.js';
import { createResearchArtifactObserver } from './research-artifact-followups.js';
import type { FollowupResearchWork, FollowupResearchObserveParams, HostJobBinding, HostJobPending } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExperimentService } from '../harness/experiments.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import type { SourceService } from '../harness/sources.js';
import type { ResourceService } from '../harness/resources.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const source = { resource_owner: { kind: 'local' as const }, workspace_id: 'observer-workspace', execution_workspace_id: 'observer-execution', mode: 'fixed_branch' as const, branch_id: 'fixed', revision: 3, live_root: null };
const binding = { operationId: 'original-job', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, subject: { kind: 'workspace', workspaceId: 'target-workspace', subjectId: 'attempt' } } satisfies HostJobBinding;
const observer: FollowupResearchWork['observer'] = { rootThreadId: 'parent', threadId: 'child', branchId: 'child-branch', sourceRunId: 'child-source', source, canSubmit: true, readThreadIds: ['parent', 'child'], controlThreadIds: ['child'] };
const work = (kind: 'artifact' | 'collection'): FollowupResearchWork => ({ key: { followupId: kind, generation: 1, sourceIndex: 0, definitionRevision: 1, ownerEpoch: 1 }, binding, observer, log: null, source: { kind, operation_id: binding.operationId } });

it('continues original research leaves after Job pending is empty and preserves hints received inside the metadata read', async () => {
  const entered = deferred(), release = deferred(); let hints = () => {}; let events = () => {}; let reads = 0, version = 1;
  let subscribed = false; const accepted = new Set<string>(); const facts: FollowupResearchObserveParams[] = []; const errors: unknown[] = [];
  const snapshot = (revision: number) => ({ attempt: { state: 'completed' }, completion: revision === 1 ? null : { recordRevision: 20, outcome: 'done' },
    artifacts: [{ artifactId: 'result', attemptId: 'attempt', name: 'result', kind: 'file', state: 'available', recordRevision: revision }], counts: { available: 1, failed: 0, expired: 0, pending: 0 } });
  const kernel = { agentRuntimeRequest: async (method: string, params: Record<string, unknown>) => {
    if (method === 'runtime.host_job.pending') return [];
    if (method === 'runtime.followup.metrics') return { works: [], nextCursor: null };
      if (method === 'runtime.followup.research') { assert.ok(subscribed); return { works: [work('artifact'), work('collection')], nextCursor: null }; }
    if (method === 'runtime.followup.research.observe') {
      const p = params as unknown as FollowupResearchObserveParams;
      const id = JSON.stringify([p.key.followupId, p.evidence.kind === 'artifact' ? p.evidence.fact : p.evidence.completion_revision]);
      if (accepted.has(id)) return { accepted: false };
      accepted.add(id); facts.push(p); events(); return { accepted: true };
    }
    throw new Error(method);
  } } as unknown as KernelClient;
  const experiments = { subscribeAttempts: (fn: () => void) => { hints = fn; subscribed = true; return () => { subscribed = false; }; },
    readArtifactObservation: async (caller: ExperimentCaller) => {
      assert.equal(caller.workspaceId, binding.subject.workspaceId); assert.equal(caller.owner.runtime, 'agent');
      if (caller.owner.runtime !== 'agent') throw new Error('actual native reader required');
      assert.deepEqual(caller.owner.source, source);
      assert.equal(caller.runId, observer.sourceRunId); assert.deepEqual(caller.access, { kind: 'family', readThreadIds: observer.readThreadIds, controlThreadIds: [] });
      const captured = version; reads++;
      if (reads === 1) { entered.resolve(); await release.promise; }
      return snapshot(captured);
    } } as unknown as ExperimentService;
  const runtime = { onReady: () => () => {}, onEvent: (fn: () => void) => { events = fn; return () => {}; }, reconcileObservations: async () => [] } as unknown as AgentRuntimeClient;
  const research = createResearchRuntime({ kernel, runtime, experiments, sources: {} as SourceService, resources: { subscribeSamples: () => () => {} } as unknown as ResourceService, onError: e => errors.push(e) });
  try {
    research.start(); await entered.promise; version = 2; hints(); release.resolve(); await research.reconcile();
    assert.deepEqual(facts.map(p => p.evidence.kind), ['artifact', 'artifact', 'collection']);
    const artifactFacts = facts.filter(p => p.evidence.kind === 'artifact').map(p => (p.evidence as Extract<typeof p.evidence, { kind: 'artifact' }>).fact);
    assert.deepEqual(artifactFacts.map(fact => 'record_revision' in fact ? fact.record_revision : 0), [1, 2]);
    assert.ok(reads >= 4); assert.deepEqual(errors, []);
  } finally { release.resolve(); await research.dispose(); }
});

it('keeps original cancellation responsive while an independent artifact metadata reply is held', async () => {
  const entered = deferred(), held = deferred(); let event = () => {}; let requested = false, cancelled = false;
  const other = { ...binding, operationId: 'other-job', subject: { ...binding.subject, subjectId: 'other-attempt' } };
  const job: HostJobPending = { binding: other, runId: 'other-run', accepted: true, cancelRequested: true, phase: 'running', executorStopped: false, origin: { kind: 'user', key: 'other' } };
  const caller: ExperimentCaller = { workspaceId: other.subject.workspaceId, executionWorkspaceId: 'exec', owner: { runtime: 'agent', actor: { kind: 'user', key: 'other' }, rootThreadId: 'parent', threadId: 'parent', branchId: 'branch', runId: 'other-run', operationId: other.operationId, executionOwner: other.executionOwner, source }, access: { kind: 'family', readThreadIds: ['parent'], controlThreadIds: ['parent'] } };
  const errors: unknown[] = [];
  const research = createResearchRuntime({
    kernel: { agentRuntimeRequest: async (method: string) => {
      if (method === 'runtime.host_job.pending') return requested ? [job] : [];
      if (method === 'runtime.followup.metrics') return { works: [], nextCursor: null };
      if (method === 'runtime.followup.research') return { works: [work('collection')], nextCursor: null };
      throw new Error(method);
    } } as unknown as KernelClient,
    runtime: { onReady: () => () => {}, onEvent: (fn: () => void) => { event = fn; return () => {}; }, reconcileObservations: async () => [] } as unknown as AgentRuntimeClient,
    experiments: { subscribeAttempts: () => () => {}, readArtifactObservation: async () => { entered.resolve(); await held.promise; return { attempt: { state: 'running' }, completion: null, artifacts: [], counts: { available: 0, failed: 0, expired: 0, pending: 0 } }; },
      nativeReceipt: async () => ({ caller, owner: caller.owner, accepted: {}, attempt: { attemptId: other.subject.subjectId, state: 'running', cancelRequested: false }, executorStopped: false, recordRevision: 1 }),
      cancel: async () => { cancelled = true; } } as unknown as ExperimentService,
    sources: {} as SourceService, resources: { subscribeSamples: () => () => {} } as unknown as ResourceService, onError: e => errors.push(e),
  });
  try {
    research.start(); await entered.promise; requested = true; event();
    await vi.waitFor(() => assert.equal(cancelled, true));
    assert.deepEqual(errors, []);
  } finally { held.resolve(); await research.dispose(); }
});


it('discards an unstarted old-page metadata read after durable Pause and rechecks the held leaf', async () => {
  const entered = deferred(), held = deferred(); let event = () => {}; let paused = false;
  let artifactReads = 0, collectionReads = 0; const errors: unknown[] = [];
  const heldWork = (): FollowupResearchWork => ({ ...work('artifact'), source: { kind: 'artifact', operation_id: binding.operationId, name: 'held' } });
  const research = createResearchRuntime({
    kernel: { agentRuntimeRequest: async (method: string) => {
      if (method === 'runtime.host_job.pending') return [];
      if (method === 'runtime.followup.metrics') return { works: [], nextCursor: null };
      if (method === 'runtime.followup.research') return { works: paused ? [heldWork()] : [heldWork(), work('collection')], nextCursor: null };
      throw new Error(method);
    } } as unknown as KernelClient,
    runtime: { onReady: () => () => {}, onEvent: (fn: () => void) => { event = fn; return () => {}; }, reconcileObservations: async () => [] } as unknown as AgentRuntimeClient,
    experiments: { subscribeAttempts: () => () => {}, readArtifactObservation: async (_caller: ExperimentCaller, _binding: HostJobBinding, selector: { name?: string }) => {
      if (selector.name === 'held') { artifactReads++; if (artifactReads === 1) { entered.resolve(); await held.promise; } } else collectionReads++;
      return { attempt: { state: 'running' }, completion: null, artifacts: [], counts: { available: 0, failed: 0, expired: 0, pending: 0 } };
    } } as unknown as ExperimentService,
    sources: {} as SourceService, resources: { subscribeSamples: () => () => {} } as unknown as ResourceService, onError: e => errors.push(e),
  });
  // Both entries come from the original source-work page; only A starts before Pause.
  try {
    research.start(); await entered.promise; paused = true; event(); held.resolve(); await research.reconcile();
    assert.equal(collectionReads, 0); assert.ok(artifactReads >= 2); assert.deepEqual(errors, []);
  } finally { held.resolve(); await research.dispose(); }
});


it('retains a durable registration notification across scan settlement microtask orderings', async () => {
  for (let offset = 0; offset < 12; offset++) {
    let registered = false, scheduled = false, reads = 0; const errors: unknown[] = [];
    const observer = createResearchArtifactObserver({
      kernel: { agentRuntimeRequest: async (method: string) => {
        assert.equal(method, 'runtime.followup.research');
        const page = { works: registered ? [work('collection')] : [], nextCursor: null };
        if (!scheduled) {
          scheduled = true; let remaining = offset;
          const notify = () => {
            if (remaining-- > 0) queueMicrotask(notify);
            else { registered = true; void observer.reconcile().catch(error => errors.push(error)); }
          };
          queueMicrotask(notify);
        }
        return page;
      } } as unknown as KernelClient,
      experiments: { readArtifactObservation: async () => { reads++; return { attempt: { state: 'running' }, completion: null, artifacts: [], counts: { available: 0, failed: 0, expired: 0, pending: 0 } }; } } as unknown as ExperimentService,
      onError: error => errors.push(error), onAccepted: async () => {},
    });
    try {
      await observer.reconcile(); await new Promise(resolve => setImmediate(resolve));
      assert.ok(reads > 0, `registration wake lost at settlement offset ${offset}`); assert.deepEqual(errors, []);
    } finally { await observer.dispose(); }
  }
});
