/** Algorithm preparation is pure. The original ContextJob admission is the only
 * transfer to durable execution; neither a plugin pin nor a preview owns a Run. */
import { isDeepStrictEqual } from 'node:util';
import type { ContextJob } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ContextCompactionOwner, ContextCompactionScope, ContextCompactionLease } from './context-compaction.js';
import type { ContextJobPreviewParams, ContextPersonalization, ContextResources } from './protocol.generated.js';

export function contextCompactionScope(threadId: string, personalization?: ContextPersonalization,
  resources?: ContextResources): ContextCompactionScope {
  const projectId = personalization?.projectId ?? resources?.snapshot.scope.projectId;
  const workspaceId = resources?.source?.resource_owner.kind !== 'managed_host' ? resources?.snapshot.scope.projectRoot : undefined;
  return { threadId, ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}

type Runtime = Pick<AgentRuntimeClient, 'previewContextJob' | 'createContextJob' | 'contextJobs' | 'run' | 'launch'>;
async function originalAdmission(runtime: Runtime, input: ContextJobPreviewParams, signal: AbortSignal): Promise<ContextJob | null> {
  const original = (await runtime.contextJobs(input.branchId, signal)).find(job => job.request.key === input.key);
  if (!original) return null;
  const request = original.request;
  if (request.branch_id !== input.branchId || request.through_id !== input.throughId || request.expected_revision !== input.expectedRevision
    || request.owner_run_id !== input.ownerRunId || request.effective_system_prompt !== input.effectiveSystemPrompt
    || request.memory_checkpoint !== input.memoryCheckpoint || !isDeepStrictEqual(request.instruction_sources, input.instructionSources)
    || !isDeepStrictEqual(request.summary_recipe, input.summaryRecipe) || !isDeepStrictEqual(request.personalization, input.personalization)) return null;
  const [run, launch] = await Promise.all([runtime.run(original.receipt.run_id, signal), runtime.launch(original.receipt.run_id, signal)]);
  if (!isDeepStrictEqual(run.configuration, input.configuration)
    || !isDeepStrictEqual(launch?.selection.credential_scope ?? null, input.credentialScope ?? null)) return null;
  return original;
}

/** The caller first recalls an already accepted original key. A new candidate holds
 * its exact producer pin through admission; an uncertain reply only reads that key. */
export async function admitContextJobCandidate(runtime: Runtime, owner: ContextCompactionOwner | undefined,
  scope: ContextCompactionScope, input: ContextJobPreviewParams, signal: AbortSignal,
  bindModel?: () => Promise<Pick<ContextJobPreviewParams, 'configuration' | 'credentialScope'>>): Promise<{ job: ContextJob; recovered: boolean }> {
  let lease: ContextCompactionLease | undefined;
  let enteredAdmission = false;
  let admissionInput = input;
  try {
    signal.throwIfAborted();
    if (owner && await owner.selected(scope, signal)) {
      const preview = await runtime.previewContextJob(input, signal);
      signal.throwIfAborted();
      lease = await owner.prepare(scope, preview, signal);
    }
    signal.throwIfAborted();
    lease?.assertAvailable();
    if (bindModel && lease?.candidate.plan.kind !== 'text') admissionInput = { ...input, ...await bindModel() };
    signal.throwIfAborted();
    lease?.assertAvailable();
    enteredAdmission = true;
    const job = await runtime.createContextJob({ ...admissionInput, compaction: lease?.candidate ?? null }, lease?.signal ?? signal);
    return { job, recovered: false };
  } catch (error) {
    if (enteredAdmission && !signal.aborted) {
      // A lost ACK or revocation after commit must not rerun planning or discard
      // an admitted candidate. Failed reconciliation retains the original error.
      const original = await originalAdmission(runtime, admissionInput, signal).catch(() => null);
      if (original) return { job: original, recovered: true };
    }
    throw error;
  } finally { lease?.release(); }
}
