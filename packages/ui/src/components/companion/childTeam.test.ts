import { expect, it } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { agentAvatarForIdentity } from '@varin/protocol';
import { CompanionChildTeam } from './childTeam';
function facts(rows: { child: string; operation?: string; state?: string; activity?: string; avatar?: string; execution?: string; parent?: string }[]): ThreadSnapshot {
  return { identity: { runtime: 'agent', threadId: 'parent', branchId: 'branch' }, activeRun: { id: 'run' },
    children: rows.map(row => ({ operation_id: row.operation ?? row.child, parent_thread_id: 'parent', parent_branch_id: 'branch', parent_run_id: row.parent ?? 'run', child_thread_id: row.child, child_branch_id: `${row.child}-branch`, avatar: row.avatar, state: 'ready' })),
    childExecutions: rows.map(row => ({ execution_id: row.execution ?? `execution-${row.operation ?? row.child}`, child_operation_id: row.operation ?? row.child, parent_thread_id: 'parent', parent_branch_id: 'branch', parent_run_id: row.parent ?? 'run', child_thread_id: row.child, child_branch_id: `${row.child}-branch`, state: row.state ?? 'ready' })),
    childActivity: Object.fromEntries(rows.map(row => [row.execution ?? `execution-${row.operation ?? row.child}`, { state: row.activity ?? 'running' }])) } as unknown as ThreadSnapshot;
}
it('keeps actual avatars and seats, and terminal execution wins over stale activity', () => {
  const team = new CompanionChildTeam(); const first = team.observe(facts([{child:'a',avatar:'cove-sage'},{child:'b'},{child:'c'},{child:'d'}]), 'current', 1)!;
  expect(first.members.map(row=>row.avatar)).toEqual(['cove-sage',agentAvatarForIdentity('b'),agentAvatarForIdentity('c')]);
  expect(first.overflowCount).toBe(1);
  const next = team.observe(facts([{child:'d'},{child:'c'},{child:'b'},{child:'a',state:'completed',activity:'running'}]),'current',1)!;
  expect(next.members.map(row=>row.key)).toEqual([first.members[1]!.key, first.members[2]!.key, 'member-4']);
  expect(next.members.every(row=>row.state==='running')).toBe(true);
});
it('does not let an old failed operation override active work for the same child', () => {
  const team = new CompanionChildTeam(); const value=team.observe(facts([{child:'a',operation:'old',state:'failed'},{child:'a',operation:'new',activity:'waiting'}]),'current',1)!;
  expect(value.members).toHaveLength(1); expect(value.members[0]!.state).toBe('waiting');
});
it('rejects wrong parent, withdraws unknown without victory and does not infer running from ready', () => {
  const team = new CompanionChildTeam();
  const older = facts([{child:'a',parent:'older-run'}]);
  expect(team.observe(older,'current',1)?.members[0]?.state).toBe('running');
  older.children![0]!.parent_branch_id = 'wrong';
  expect(team.observe(older,'current',1)?.members).toEqual([]);
  const snapshot=facts([{child:'a',activity:'settling'}]);
  expect(team.observe(snapshot,'current',1)?.members[0]?.state).toBe('settling');
  expect(team.observe(snapshot,'unknown',1)).toBeUndefined();
  delete snapshot.childActivity;
  expect(team.observe(snapshot,'current',2)?.members[0]?.state).toBe('preparing');
  delete snapshot.childExecutions;
  expect(team.observe(snapshot,'current',2)?.overflowCount).toBeNull();
});
