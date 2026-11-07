import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { ThreadAdapter } from './thread-adapter.js';

type FollowupOwner = Pick<ThreadAdapter, 'runtime' | 'requireIdentity'>;

export async function listThreadFollowupJobs(owner: FollowupOwner, identity: ThreadIdentity, runId: string, signal?: AbortSignal) {
  await owner.requireIdentity(identity, signal);
  const run = await owner.runtime.run(runId, signal);
  if (run.thread_id !== identity.threadId || run.branch_id !== identity.branchId) throw new Error('Job observer Run belongs to another Thread branch');
  return owner.runtime.hostJobSources(run.id, signal);
}

/** The Catalog owns definitions, waits and occurrences. The Host checks the selected branch only. */
export async function listThreadFollowups(owner: FollowupOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  await owner.requireIdentity(identity, signal);
  return (await owner.runtime.followups(identity.threadId, signal))
    .filter(followup => followup.thread_id === identity.threadId && followup.branch_id === identity.branchId);
}

/** Bot ownership survives a deleted or moved receiving Thread. Ordinary work keeps exact branch scope. */
async function manageableFollowups(owner: FollowupOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  const thread = await owner.requireIdentity(identity, signal);
  const local = await listThreadFollowups(owner, identity, signal);
  if (!thread.bot_id) return local;
  const owned = await owner.runtime.botArrangements({ botId: thread.bot_id, principalId: thread.principal_id ?? null }, signal);
  return [...new Map([...local, ...owned].map(item => [item.id, item])).values()];
}

export async function registerThreadFollowup(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['register']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input, signal);
  const run = await owner.runtime.run(input.runId, signal);
  if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) {
    throw new Error('Follow-up source Run belongs to another Thread branch');
  }
  // Catalog validates the trigger, original accepted operation evidence (when selected), and registration
  // identity atomically. Registration never hydrates process output or starts work in the Host.
  return owner.runtime.registerFollowup({ key: input.key, runId: run.id, trigger: input.trigger, instruction: input.instruction,
    ...(input.repeat === undefined ? {} : { repeat: input.repeat }) }, signal);
}

export async function getThreadFollowup(owner: FollowupOwner,
  identity: ThreadIdentity, followupId: string, signal?: AbortSignal) {
  const followups = await manageableFollowups(owner, identity, signal);
  if (!followups.some(followup => followup.id === followupId)) {
    throw new Error('Follow-up does not belong to the selected Thread branch');
  }
  return owner.runtime.followup(followupId, signal);
}

export async function listThreadFollowupOccurrences(owner: FollowupOwner,
  identity: ThreadIdentity, followupId: string, after?: number, signal?: AbortSignal) {
  const followups = await manageableFollowups(owner, identity, signal);
  if (!followups.some(followup => followup.id === followupId)) {
    throw new Error('Follow-up does not belong to the selected Thread branch');
  }
  // Authorize from short definition metadata, without hydrating the original instruction.
  return owner.runtime.followupOccurrences(followupId, after, signal);
}

export async function getThreadFollowupOccurrence(owner: FollowupOwner,
  identity: ThreadIdentity, followupId: string, occurrenceId: string, signal?: AbortSignal) {
  const followups = await manageableFollowups(owner, identity, signal);
  if (!followups.some(followup => followup.id === followupId)) {
    throw new Error('Follow-up does not belong to the selected Thread branch');
  }
  // The original occurrence owner validates membership and hydrates only its accepted source facts.
  // Neither the latest occurrence nor the instruction body participates in this authorization.
  return owner.runtime.followupOccurrence(followupId, occurrenceId, signal);
}

export async function controlThreadFollowup(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['control']>[0], signal?: AbortSignal) {
  const followups = await manageableFollowups(owner, input, signal);
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


/** Long-lived definitions authorize their actual original and replacement targets, not the open UI. */
export async function putThreadArrangement(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['putArrangement']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input, signal);
  const arrangement = input.arrangement;
  if (arrangement.expectedRevision !== undefined) {
    const definitions = await manageableFollowups(owner, input, signal);
    if (!definitions.some(value => value.id === arrangement.key)) {
      throw new Error('Arrangement does not belong to the original Thread branch');
    }
  }
  await owner.requireIdentity({ runtime: 'agent', threadId: arrangement.threadId, branchId: arrangement.branchId }, signal);
  return owner.runtime.putArrangement(arrangement, signal);
}

export async function controlThreadBacklog(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['backlog']>[0], signal?: AbortSignal) {
  const definitions = await manageableFollowups(owner, input, signal);
  if (!definitions.some(value => value.id === input.followupId)) {
    throw new Error('Arrangement does not belong to the selected Thread branch');
  }
  return owner.runtime.followupBacklog({ followupId: input.followupId,
    expectedRevision: input.expectedRevision, action: input.action }, signal);
}

export async function listThreadSourceRoutes(owner: FollowupOwner, identity: ThreadIdentity, followupId: string, signal?: AbortSignal) {
  const definitions = await manageableFollowups(owner, identity, signal);
  if (!definitions.some(value => value.id === followupId)) throw new Error('Arrangement does not belong to the selected Thread branch');
  return owner.runtime.followupSourceRoutes(followupId, signal);
}

export async function putThreadSourceRoute(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['putSourceRoute']>[0], signal?: AbortSignal) {
  const definitions = await manageableFollowups(owner, input, signal);
  if (!definitions.some(value => value.id === input.route.followupId)) throw new Error('Arrangement does not belong to the selected Thread branch');
  await owner.requireIdentity({ runtime: 'agent', threadId: input.route.threadId, branchId: input.route.branchId }, signal);
  return owner.runtime.putFollowupSourceRoute(input.route, signal);
}

export async function removeThreadSourceRoute(owner: FollowupOwner,
  input: Parameters<ThreadFollowupsAPI['removeSourceRoute']>[0], signal?: AbortSignal) {
  const definitions = await manageableFollowups(owner, input, signal);
  if (!definitions.some(value => value.id === input.followupId)) throw new Error('Arrangement does not belong to the selected Thread branch');
  return owner.runtime.removeFollowupSourceRoute({ followupId: input.followupId, expectedRevision: input.expectedRevision, objectId: input.objectId }, signal);
}
