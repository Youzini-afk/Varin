import type { ThreadAttentionSnapshot, ThreadIdentity, ThreadAttentionTeamExecution } from '@varin/application-client';
import { agentAvatarForIdentity, type AgentAvatarId } from '@varin/protocol';
export const directorBranchKey = (branch: { threadId: string; branchId: string }) => JSON.stringify([branch.threadId, branch.branchId]);
export interface DirectorChildMember {
  key: string;
  identity: ThreadIdentity;
  avatar: AgentAvatarId;
  executionIds: string[];
  state: 'preparing' | 'running' | 'waiting' | 'settling' | 'failed';
}
const ended = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
const rank: Record<DirectorChildMember['state'], number> = { running: 0, waiting: 1, preparing: 2, settling: 3, failed: 4 };

/** Only exact owner relations may attach a child branch to a project; ambiguity stays ungrouped. */
export function directorProjectRelations(snapshot: ThreadAttentionSnapshot) {
  const branches = new Map(snapshot.branches.map(branch => [directorBranchKey(branch), branch]));
  const parents = new Map<string, Set<string>>();
  for (const row of snapshot.teamExecutions) {
    const childKey = directorBranchKey({ threadId: row.childThreadId, branchId: row.childBranchId });
    const parentKey = directorBranchKey({ threadId: row.parentThreadId, branchId: row.parentBranchId });
    const child = branches.get(childKey);
    if (!child || !branches.has(parentKey) || child.parentThreadId !== row.parentThreadId || childKey === parentKey) continue;
    const owners = parents.get(childKey) ?? new Set<string>(); owners.add(parentKey); parents.set(childKey, owners);
  }
  const projectForBranch = new Map<string, string>();
  for (const key of branches.keys()) {
    let current = key;
    const seen = new Set<string>();
    while (parents.get(current)?.size === 1 && !seen.has(current)) {
      seen.add(current); current = [...parents.get(current)!][0]!;
    }
    // A cycle or a multi-parent relation is not proof of any single project owner.
    if (seen.has(current) || (parents.get(current)?.size ?? 0) > 1) current = key;
    projectForBranch.set(key, current);
  }
  return { projectForBranch };
}

/** A project lead is deliberately absent here: these are only real delegated executions. */
export function directorChildMembers(rows: ThreadAttentionTeamExecution[], parent: ThreadIdentity): DirectorChildMember[] {
  const children = new Map<string, DirectorChildMember>();
  for (const row of rows) {
    if (row.parentThreadId !== parent.threadId || row.parentBranchId !== parent.branchId || ended(row.state)) continue;
    const state: DirectorChildMember['state'] = row.state === 'preparation_failed' || row.activity === 'preparation_failed' ? 'failed'
      : row.childRunState && ended(row.childRunState) ? 'settling'
        : row.activity === 'running' ? 'running' : row.activity === 'waiting' ? 'waiting'
          : row.activity === 'settling' ? 'settling' : 'preparing';
    const key = JSON.stringify([row.parentThreadId, row.parentBranchId, row.parentRunId, row.childThreadId, row.childBranchId]);
    const previous = children.get(key);
    if (previous) {
      if (!previous.executionIds.includes(row.executionId)) previous.executionIds.push(row.executionId);
      if (rank[state] < rank[previous.state]) previous.state = state;
    } else children.set(key, { key, identity: { runtime: 'agent', threadId: row.childThreadId, branchId: row.childBranchId },
      avatar: agentAvatarForIdentity(row.childThreadId, row.avatar), state, executionIds: [row.executionId] });
  }
  return [...children.values()];
}
