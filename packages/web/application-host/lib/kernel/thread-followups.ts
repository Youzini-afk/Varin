import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { ThreadAdapter } from './thread-adapter.js';

type FollowupOwner = Pick<ThreadAdapter, 'runtime' | 'requireIdentity'>;

/** The Catalog owns definitions, waits and occurrences. The Host checks the selected branch only. */
export async function listThreadFollowups(owner: FollowupOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  await owner.requireIdentity(identity, signal);
  return (await owner.runtime.followups(identity.threadId, signal))
    .filter(followup => followup.thread_id === identity.threadId && followup.branch_id === identity.branchId);
}

export async function registerThreadFollowup(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['register']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input, signal);
  const run = await owner.runtime.run(input.runId, signal);
  if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) {
    throw new Error('Follow-up source Run belongs to another Thread branch');
  }
  // Catalog validates the trigger, original process evidence (when selected), and registration
  // identity atomically. Registration never hydrates process output or starts work in the Host.
  return owner.runtime.registerFollowup({ key: input.key, runId: run.id, trigger: input.trigger, instruction: input.instruction }, signal);
}

export async function getThreadFollowup(owner: FollowupOwner,
  identity: ThreadIdentity, followupId: string, signal?: AbortSignal) {
  const followups = await listThreadFollowups(owner, identity, signal);
  if (!followups.some(followup => followup.id === followupId)) {
    throw new Error('Follow-up does not belong to the selected Thread branch');
  }
  return owner.runtime.followup(followupId, signal);
}

export async function controlThreadFollowup(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['control']>[0], signal?: AbortSignal) {
  const followups = await listThreadFollowups(owner, input, signal);
  if (!followups.some(followup => followup.id === input.followupId)) {
    throw new Error('Follow-up does not belong to the selected Thread branch');
  }
  // Resume affects this definition only. It must never consume a Run's independent policy Pause.
  return owner.runtime.controlFollowup({ followupId: input.followupId,
    expectedRevision: input.expectedRevision, action: input.action }, signal);
}

/** Storage's original User acceptance is discoverable even if Catalog admission lost its caller. */
export async function pendingThreadFollowupRegistrations(owner: FollowupOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  await owner.requireIdentity(identity, signal);
  return owner.runtime.pendingFollowupRegistrations(identity.threadId, identity.branchId, signal);
}
export async function cancelThreadFollowupRegistration(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['cancelRegistration']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input, signal);
  const run = await owner.runtime.run(input.runId, signal);
  if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) throw new Error('Follow-up source Run belongs to another Thread branch');
  return owner.runtime.cancelFollowupRegistration({ key: input.key, runId: input.runId }, signal);
}
