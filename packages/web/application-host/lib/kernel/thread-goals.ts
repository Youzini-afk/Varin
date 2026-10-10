import type { ThreadGoalsAPI, ThreadIdentity } from '@varin/application-client';
import type { ThreadAdapter } from './thread-adapter.js';

type GoalOwner = Pick<ThreadAdapter, 'runtime' | 'requireIdentity'>;

/** Catalog owns authorization, objective versions, inference usage and continuation admission. */
export async function listThreadGoals(owner: GoalOwner, identity: ThreadIdentity, signal?: AbortSignal) {
  await owner.requireIdentity(identity);
  return (await owner.runtime.goals(identity.threadId, signal))
    .filter(goal => goal.thread_id === identity.threadId && goal.branch_id === identity.branchId);
}

export async function startThreadGoal(owner: GoalOwner,
  input: Parameters<ThreadGoalsAPI['start']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input);
  const run = await owner.runtime.run(input.runId, signal);
  if (run.thread_id !== input.threadId || run.branch_id !== input.branchId) {
    throw new Error('Goal source Run belongs to another Thread branch');
  }
  return owner.runtime.startGoal({ key: input.key, threadId: input.threadId, branchId: input.branchId,
    runId: input.runId, objective: input.objective, budget: input.budget }, signal);
}

export async function updateThreadGoal(owner: GoalOwner,
  input: Parameters<ThreadGoalsAPI['update']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input);
  return owner.runtime.updateGoal({ goalId: input.goalId, threadId: input.threadId, branchId: input.branchId,
    expectedRevision: input.expectedRevision, objective: input.objective, budget: input.budget }, signal);
}

export async function controlThreadGoal(owner: GoalOwner,
  input: Parameters<ThreadGoalsAPI['control']>[0], signal?: AbortSignal) {
  await owner.requireIdentity(input);
  // Validate the selected scope in the same Catalog transaction as the control. Hydrating every
  // objective first would put large or damaged content in front of pause/cancel admission.
  return owner.runtime.controlGoal({ goalId: input.goalId, threadId: input.threadId, branchId: input.branchId,
    expectedRevision: input.expectedRevision, action: input.action }, signal);
}
