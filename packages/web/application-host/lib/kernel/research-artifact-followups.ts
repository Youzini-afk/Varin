/** Transient consumer of original Catalog leaves and ExperimentService facts. No domain state or scheduler. */
import { createResearchLogReader } from './research-log-followups.js';
import type { ExperimentService } from '../harness/experiments.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import type { KernelClient } from './kernel-client.js';
import type { FollowupResearchEvidence, FollowupResearchWorksResult, FollowupResearchWork } from './protocol.generated.js';

export function createResearchArtifactObserver(options: { kernel: KernelClient; experiments: ExperimentService; onError: (error: unknown) => void; onAccepted: () => Promise<unknown> }) {
  const seen = new Set<string>();
  const controller = new AbortController();
  const request = options.kernel.agentRuntimeRequest.bind(options.kernel);
  const logs = createResearchLogReader({ ...options, signal: controller.signal });
  const observe = async (work: FollowupResearchWork): Promise<boolean> => {
    const { observer, binding, source, key } = work;
    const subject = binding.subject;
    if (subject.kind !== 'workspace') throw new Error('Original research observation requires a workspace subject');
    const caller: ExperimentCaller = {
      workspaceId: subject.workspaceId,
      executionWorkspaceId: observer.source.execution_workspace_id,
      threadId: observer.threadId, runId: observer.sourceRunId,
      owner: { runtime: 'agent', actor: { kind: 'reader' }, rootThreadId: observer.rootThreadId,
        threadId: observer.threadId, branchId: observer.branchId, runId: observer.sourceRunId, source: observer.source },
      access: { kind: 'family', readThreadIds: observer.readThreadIds, controlThreadIds: [] },
    };
    if (source.kind === 'log_literal' || source.kind === 'log_end') return logs.observe(work, caller);
    if (source.kind !== 'artifact' && source.kind !== 'collection') throw new Error('Original research leaf changed');
    const selector = source.kind === 'artifact' ? { ...(source.artifact_id ? { artifactId: source.artifact_id } : {}), ...(source.name ? { name: source.name } : {}) } : {};
    const snapshot = await options.experiments.readArtifactObservation(caller, binding, selector, controller.signal);
    controller.signal.throwIfAborted();
    const identity = JSON.stringify([key.ownerEpoch, key.followupId, key.generation, key.sourceIndex]);
    const gap = !seen.has(identity);
    const publish = async (evidence: FollowupResearchEvidence, content: unknown) => {
      controller.signal.throwIfAborted();
      const result = await request<{ accepted: boolean }, 'runtime.followup.research.observe'>('runtime.followup.research.observe', { key, evidence, content }, controller.signal);
      if (result.accepted) await options.onAccepted();
    };
    if (source.kind === 'collection') {
      if (snapshot.completion) await publish({ kind: 'collection', binding, completion_revision: snapshot.completion.recordRevision,
        outcome: snapshot.completion.outcome, counts: snapshot.counts, gap }, {
        attemptId: subject.subjectId, attemptState: snapshot.attempt.state, collection: snapshot.completion,
        counts: snapshot.counts, reader: { method: 'research_get', attemptId: subject.subjectId, workspaceId: subject.workspaceId },
      });
    } else {
      const relevant = snapshot.artifacts.filter(artifact => artifact.state !== 'pending');
      for (const artifact of relevant) {
        const kind = artifact.state === 'available' ? 'artifact_available' : artifact.state === 'expired' ? 'artifact_expired' : 'artifact_failed';
        await publish({ kind: 'artifact', binding, fact: { kind, artifact_id: artifact.artifactId, record_revision: artifact.recordRevision }, gap }, {
          attemptId: subject.subjectId, artifact,
          reader: { method: 'research_artifact', attemptId: subject.subjectId, artifactId: artifact.artifactId, workspaceId: subject.workspaceId,
            semantics: 'Reads the current domain record, which may differ from the observed record revision. Frozen historical metadata is not an immutable byte snapshot.' },
        });
      }
      // Absence is a stable completed collection observation, never a Job terminal inference.
      if (snapshot.artifacts.length === 0 && snapshot.completion) {
        const outcome = snapshot.completion.outcome;
        await publish({ kind: 'artifact', binding, fact: { kind: outcome === 'failed' ? 'artifact_absent' : 'artifact_missing',
          completion_revision: snapshot.completion.recordRevision, outcome }, gap }, {
          attemptId: subject.subjectId, selector, collection: snapshot.completion,
          status: outcome === 'failed' ? 'No matching collected record after this failed collection' : 'No matching collected record in this completed collection',
        });
      }
    }
    seen.add(identity);
    return false;
  };
  const scan = async () => {
      const current = new Set<string>();
      let moreLogBytes = false;
      let after: string | undefined;
      do {
        controller.signal.throwIfAborted();
        const page = await request<FollowupResearchWorksResult, 'runtime.followup.research'>('runtime.followup.research', after ? { after } : {}, controller.signal);
        for (const work of page.works) {
          // A committed hint can revoke another leaf while this page's prior read is held.
          // Discard unstarted metadata reads and recheck the original Catalog projection.
          if (dirty) return;
          current.add(JSON.stringify([work.key.ownerEpoch, work.key.followupId, work.key.generation, work.key.sourceIndex]));
          try { moreLogBytes = await observe(work) || moreLogBytes; } catch (error) { if (controller.signal.aborted) throw error; options.onError(error); }
        }
        if (page.nextCursor !== null && page.nextCursor === after) throw new Error('Research observation cursor did not advance');
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      for (const identity of seen) if (!current.has(identity)) seen.delete(identity);
      logs.retain(current);
      if (moreLogBytes) dirty = true;
  };
  let dirty = false;
  let work: Promise<void> | undefined;
  const reconcile = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    dirty = true;
    if (work) return work;
    work = (async () => {
      while (dirty && !controller.signal.aborted) { dirty = false; await scan(); }
    })().finally(() => {
      work = undefined;
      // A notification can arrive after the loop settles but before this cleanup runs.
      if (dirty && !controller.signal.aborted) void reconcile().catch(error => {
        if (!controller.signal.aborted) options.onError(error);
      });
    });
    return work;
  };
  return { reconcile, async dispose() { controller.abort(); await Promise.allSettled(work ? [work] : []); } };
}
