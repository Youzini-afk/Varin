import { expect, it } from 'vitest';
import type { ThreadAttentionSnapshot, ThreadAttentionTeamExecution } from '@varin/application-client';
import { directorBranchKey, directorProjectRelations, directorChildMembers } from './directorProjects';
const row=(overrides:Partial<ThreadAttentionTeamExecution>={}):ThreadAttentionTeamExecution=>({parentThreadId:'A',parentBranchId:'branch-A',parentRunId:'older-parent-run',childOperationId:'op-child',executionId:'execution-child',childThreadId:'child',childBranchId:'branch-child',avatar:'cove-sage',state:'ready',childRunId:'run-child',childRunState:'executing',activity:'running',...overrides});
const parent={runtime:'agent' as const,threadId:'A',branchId:'branch-A'};
it('joins only exact parent branches and leaves multi-parent ambiguity ungrouped',()=>{
 const snapshot={branches:[{threadId:'A',branchId:'branch-A',parentThreadId:null},{threadId:'A',branchId:'other-A',parentThreadId:null},{threadId:'child',branchId:'branch-child',parentThreadId:'A'}],teamExecutions:[row()]} as ThreadAttentionSnapshot;
 const child=directorBranchKey({threadId:'child',branchId:'branch-child'});
 expect(directorProjectRelations(snapshot).projectForBranch.get(child)).toBe(directorBranchKey(parent));
 snapshot.teamExecutions.push(row({parentBranchId:'other-A',executionId:'ambiguous'}));
 expect(directorProjectRelations(snapshot).projectForBranch.get(child)).toBe(child);
});
it('shows only real child members, retains old parent Run work, and distinguishes executor end from owner settlement',()=>{
 const initial=directorChildMembers([row()],parent);
 expect(initial).toHaveLength(1);expect(initial[0]?.avatar).toBe('cove-sage');expect(initial[0]?.state).toBe('running');
 expect(directorChildMembers([row({childRunState:'completed',activity:'running'})],parent)[0]?.state).toBe('settling');
 expect(directorChildMembers([row({state:'completed'})],parent)).toEqual([]);
 expect(directorChildMembers([row({parentBranchId:'wrong'})],parent)).toEqual([]);
 expect(directorChildMembers([],parent)).toEqual([]); // The real main agent is not invented as a child.
});
