import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { ThreadAdapter } from './thread-adapter.js';

type FollowupOwner = Pick<ThreadAdapter, 'runtime' | 'requireIdentity'>;

/** The Catalog owns definitions, waits and occurrences. The Host checks the selected branch only. */
export async function listThreadFollowups(owner: FollowupOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  await owner.requireIdentity(identity);
  return (await owner.runtime.followups(identity.threadId, signal))
    .filter(followup => followup.thread_id === identity.threadId && followup.branch_id === identity.branchId);
}

export async function registerThreadFollowup(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['register']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input);
  const run = await owner.runtime.run(input.runId, signal);
  if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) {
    throw new Error('Follow-up source Run belongs to another Thread branch');
  }
  // Catalog checks the operation's Run and trusted process receipt atomically. Inspecting its
  // full result here would hydrate unrelated process output before this small control request.
  return owner.runtime.registerFollowup({ key: input.key, runId: run.id, operationId: input.operationId }, signal);
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
