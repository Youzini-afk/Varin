import { expect, it } from 'vitest';
import type { ThreadAttentionDelegation, ThreadAttentionSnapshot, ThreadAttentionTeamExecution } from '@varin/application-client';
import { directorBranchKey, directorProjectRelations, directorChildMembers } from './directorProjects';
const row=(overrides:Partial<ThreadAttentionTeamExecution>={}):ThreadAttentionTeamExecution=>({parentThreadId:'A',parentBranchId:'branch-A',parentRunId:'older-parent-run',childOperationId:'op-child',executionId:'execution-child',childThreadId:'child',childBranchId:'branch-child',avatar:'cove-sage',state:'ready',childRunId:'run-child',childRunState:'executing',activity:'running',...overrides});
const parent={runtime:'agent' as const,threadId:'A',branchId:'branch-A'};
const relation=(parentBranchId:string,operationId:string):ThreadAttentionDelegation=>({operationId,parentThreadId:'A',parentBranchId,parentRunId:'older-parent-run',childThreadId:'child',childBranchId:'branch-child',acceptedCursor:1,continuedCursor:null,continuedByThreadId:null,reportCursor:null,reportOutcome:null});
it('joins only exact parent branches and leaves multi-parent ambiguity ungrouped',()=>{
 const snapshot={branches:[{threadId:'A',branchId:'branch-A',parentThreadId:null,botId:null,botSessionThreadId:null},{threadId:'A',branchId:'other-A',parentThreadId:null,botId:null,botSessionThreadId:null},{threadId:'child',branchId:'branch-child',parentThreadId:'A',botId:null,botSessionThreadId:null}],teamExecutions:[row()],delegations:[relation('branch-A','op-child')]} as unknown as ThreadAttentionSnapshot;
 const child=directorBranchKey({threadId:'child',branchId:'branch-child'});
 expect(directorProjectRelations(snapshot).projectForBranch.get(child)).toBe(directorBranchKey(parent));
 snapshot.delegations.push(relation('other-A','ambiguous'));
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
