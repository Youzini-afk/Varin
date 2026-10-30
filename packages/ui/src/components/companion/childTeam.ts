import { COMPANION_TEAM_VISIBLE_LIMIT, type DesktopCompanionTeam, type ThreadSnapshot } from '@varin/application-client';
import { agentAvatarForIdentity } from '@varin/protocol';
import type { ObservationHealth } from './presentation';

type Member = DesktopCompanionTeam['members'][number];
const terminal = new Set(['completed', 'failed', 'cancelled']);
const rank: Record<Member['state'], number> = { running: 0, waiting: 1, preparing: 2, settling: 3, failed: 4, leaving: 5 };

/** Join the exact parent branch and original parent Run; children may outlive a newer parent Run. */
export function companionChildEvidence(snapshot: ThreadSnapshot) {
  const identity = snapshot.identity;
  const children = new Map((snapshot.children ?? []).filter(child => child.parent_thread_id === identity.threadId
      && child.parent_branch_id === identity.branchId)
      .map(child => [child.operation_id, child]));
  // The snapshot promises admission order. Last matching execution per child operation is current.
  const latest = new Map<string, NonNullable<ThreadSnapshot['childExecutions']>[number]>();
  for (const execution of snapshot.childExecutions ?? []) {
    const child = children.get(execution.child_operation_id);
    if (!child || execution.parent_thread_id !== identity.threadId || execution.parent_branch_id !== identity.branchId
        || execution.parent_run_id !== child.parent_run_id
        || execution.child_thread_id !== child.child_thread_id || execution.child_branch_id !== child.child_branch_id) continue;
    latest.set(execution.child_operation_id, execution);
  }
  return [...children.values()].map(child => {
    const execution = latest.get(child.operation_id);
    const state = execution?.state ?? child.state;
    const activity = execution ? snapshot.childActivity?.[execution.execution_id]?.state : undefined;
    return { child, execution, state, activity };
  });
}

export function hasCurrentChildWork(snapshot: ThreadSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.children === undefined || snapshot.childExecutions === undefined)
    return Object.values(snapshot.childActivity ?? {}).some(value => value.state !== 'preparation_failed');
  return companionChildEvidence(snapshot).some(row => !terminal.has(row.state)
    && row.state !== 'preparation_failed' && row.activity !== 'preparation_failed');
}

/** Stable avatar seats, exact execution facts. No execution ownership or disappearance receipts. */
export class CompanionChildTeam {
  private scope = '';
  private seats: string[] = [];
  private tokens = new Map<string, string>();
  private serial = 0;
  reset(): void { this.scope = ''; this.seats = []; this.tokens.clear(); }
  observe(snapshot: ThreadSnapshot | undefined, health: ObservationHealth, generation: number): DesktopCompanionTeam | undefined {
    if (!snapshot || health !== 'current') { this.reset(); return undefined; }
    const identity = snapshot.identity;
    const scope = JSON.stringify([generation, identity.threadId, identity.branchId]);
    if (scope !== this.scope) { this.scope = scope; this.seats = []; this.tokens.clear(); }
    const grouped = new Map<string, Member>();
    for (const { child, execution, state, activity } of companionChildEvidence(snapshot)) {
      if (terminal.has(state)) continue; // All ended executions withdraw neutrally; the attention ledger retains failure.
      // Terminal execution wins over a stale activity entry. Current family membership can outlive work.
      const visual: Member['state'] = state === 'preparation_failed' || activity === 'preparation_failed' ? 'failed'
          : activity === 'running' ? 'running' : activity === 'waiting' ? 'waiting'
            : activity === 'settling' ? 'settling' : 'preparing';
      const key = JSON.stringify([generation, identity.threadId, identity.branchId, child.parent_run_id, child.child_thread_id, child.child_branch_id]);
      if (!this.tokens.has(key)) this.tokens.set(key, `member-${++this.serial}`);
      const member: Member = { key: this.tokens.get(key)!, avatar: agentAvatarForIdentity(child.child_thread_id, child.avatar ?? execution?.avatar), state: visual };
      const existing = grouped.get(key);
      // One child can own multiple admitted operations. An old completion cannot withdraw new active work.
      if (!existing || rank[member.state] < rank[existing.state]) grouped.set(key, member);
    }
    for (const key of this.tokens.keys()) if (!grouped.has(key)) this.tokens.delete(key);
    this.seats = this.seats.filter(key => grouped.has(key));
    for (const key of grouped.keys()) if (!this.seats.includes(key)) this.seats.push(key);
    const visible = [...this.seats.filter(key => grouped.get(key)!.state !== 'failed'), ...this.seats.filter(key => grouped.get(key)!.state === 'failed')].slice(0, COMPANION_TEAM_VISIBLE_LIMIT);
    // Without both roster arrays, absence is unknown, not an exact zero count.
    const complete = snapshot.children !== undefined && snapshot.childExecutions !== undefined;
    return { members: visible.map(key => grouped.get(key)!), overflowCount: complete ? Math.max(0, grouped.size - visible.length) : null };
  }
}
