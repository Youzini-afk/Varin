import { expect, it } from 'vitest';
import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';
import { CompanionDirector } from './directorPresentation';
import { agentAvatarForIdentity } from '@varin/protocol';
const options={visible:true,interacting:false,cardCapacity:3,interactionRoute:'coordination-review' as const};
const id=(threadId:string):ThreadIdentity=>({runtime:'agent',threadId,branchId:`branch-${threadId}`});
function branch(threadId:string,state:NonNullable<ThreadAttentionBranch['currentRun']>['state']='executing',runId=`run-${threadId}`):ThreadAttentionBranch {
 const run={id:runId,state,revision:1,cancelRequested:false};
 return {...id(threadId),title:`Task ${threadId}`,parentThreadId:null,archived:false,deleted:false,activeRunId:['completed','failed','cancelled'].includes(state)?null:runId,currentRun:run,latestRun:run,hasUnsettledWork:!['completed','failed','cancelled'].includes(state)};
}
function facts(branches:ThreadAttentionBranch[],items:ThreadAttentionItem[]=[]):ThreadAttentionSnapshot {
 return {teamExecutions:[],epoch:1,eventCursor:1,coverage:{native:'complete',external:'unsupported',scope:'host'},branches,items,counts:{actionRequired:items.filter(x=>x.actionable).length,affectedBranches:new Set(items.filter(x=>x.actionable).map(x=>x.branchId)).size,unknownEffects:items.filter(x=>x.kind==='effect_unknown').length}};
}
const request=(threadId:string,kind:'permission'|'question'|'effect_unknown'='permission'):ThreadAttentionItem=>({...id(threadId),key:`${threadId}-${kind}`,runId:`run-${threadId}`,revision:1,kind,actionable:kind!=='effect_unknown'});
it('is a portfolio director without a selected task; inspection never makes her a project executor',()=>{
 const director=new CompanionDirector(),data=facts([branch('A'),branch('B')]);
 const initial=director.observe(data,'current',null,options);
 expect(initial.body.verb).toBe('review-portfolio');expect(initial.body.edge).toBeNull();
 expect(initial.cards[0]!.lead).toMatchObject({identity:'A',avatar:agentAvatarForIdentity('A'),runId:'run-A'});
 for(let i=0;i<20;i++) {
  data.eventCursor++;data.branches[0]!.currentRun!.state=i%2?'generating':'executing';
  expect(director.observe(data,'current',i%2?id('A'):id('B'),options).body.verb).toBe('review-portfolio');
 }
});
it('presents independent decisions without global approval or inspection stealing attention',()=>{
 const director=new CompanionDirector();const data=facts([branch('A'),branch('B'),branch('C')],[request('B'),request('C','question')]);
 const first=director.observe(data,'current',id('A'),options);
 expect(first.body.verb).toBe('present-attention');expect(first.body.subject).toEqual(id('B'));expect(first.counts?.actionRequired).toBe(2);
 const next=director.observe({...data,items:[request('C','question')],counts:{...data.counts,actionRequired:1,affectedBranches:1}},'current',id('A'),options);
 expect(next.body.verb).toBe('present-attention');expect(next.body.subject).toEqual(id('C'));expect(next.body.edge).toBeNull();
});
it('receives only an observed project Run result while other projects keep working',()=>{
 const director=new CompanionDirector();director.observe(facts([branch('A'),branch('B')]),'current',null,options);
 const value=director.observe(facts([branch('A','completed'),branch('B')]),'current',null,options);
 expect(value.body.verb).toBe('receive-result');expect(value.body.subject).toEqual(id('A'));expect(value.counts?.activeProjectTasks).toBe(1);
 director.consumeEdge(value.body.edge!.key);
 expect(director.observe(facts([branch('A','completed'),branch('B')]),'current',null,options).body.verb).toBe('review-portfolio');
});
it('does not replay historical/hidden results, and a newer urgent item discards a transient beat',()=>{
 const director=new CompanionDirector();
 expect(director.observe(facts([branch('A','completed')]),'current',null,options).body.edge).toBeNull();
 director.observe(facts([branch('A','accepted','run-new')]),'current',null,{...options,visible:false});
 expect(director.observe(facts([branch('A','completed','run-new')]),'current',null,options).body.edge).toBeNull();
 director.observe(facts([branch('A','accepted','run-next')]),'current',null,options);
 const urgent=facts([branch('A','accepted','run-next'),branch('B')],[request('B')]);
 expect(director.observe(urgent,'current',null,options).body.verb).toBe('present-attention');
 expect(director.observe({...urgent,items:[],counts:{actionRequired:0,affectedBranches:0,unknownEffects:0}},'current',null,options).body.edge).toBeNull();
});
it('uses a real main-agent avatar even with no children and never guesses an orphan child project',()=>{
 const director=new CompanionDirector();const child=branch('child');child.parentThreadId='missing-parent';
 const value=director.observe(facts([child]),'current',null,options);
 expect(value.cards[0]?.relation).toBe('child-task');expect(value.cards[0]?.lead.identity).toBe('child');expect(value.cards[0]?.lead.role).toBe('child-agent');
 expect(value.counts?.activeProjectTasks).toBe(0);expect(value.body.verb).toBe('review-portfolio');
 const stale=director.observe(facts([child]),'unknown',null,options);
 expect(stale.body.verb).toBe('unavailable');expect(stale.counts).toBeNull();expect(stale.cards[0]?.status).toBe('unknown');
});

it('groups an exact child request under its real project card without losing the request owner',()=>{
 const director=new CompanionDirector();const child=branch('child');child.parentThreadId='A';
 const data=facts([branch('A','completed'),child],[request('child')]);
 data.teamExecutions=[{parentThreadId:'A',parentBranchId:'branch-A',parentRunId:'older-parent-run',childOperationId:'op-child',executionId:'execution-child',childThreadId:'child',childBranchId:'branch-child',state:'ready',childRunId:'run-child',childRunState:'executing',activity:'running'}];
 const view=director.observe(data,'current',id('A'),options);
 expect(view.cards).toHaveLength(1);expect(view.cards[0]?.lead.identity).toBe('A');
 expect(view.cards[0]?.children[0]?.identity.threadId).toBe('child');expect(view.cards[0]?.attentionKeys).toEqual(['child-permission']);
 expect(view.body.subject).toEqual(id('A'));expect(view.body.attentionOwner).toEqual(id('child'));expect(view.counts?.actionRequired).toBe(1);
});

it('labels a failed or cancelled round as that outcome, never a successful project or confirmed executor stop',()=>{
 for(const state of ['failed','cancelled'] as const) {
  const director=new CompanionDirector();director.observe(facts([branch('A')]),'current',null,options);
  const ended=branch('A',state);ended.hasUnsettledWork=true;
  const result=director.observe(facts([ended]),'current',null,options);
  expect(result.body.edge).toMatchObject({kind:'receive-result',outcome:state,workRemains:true});
  expect(result.cards[0]?.status).toBe('settling');
 }
});

it('defaults to unknown without invented coordination: new accepted runs and inspection do not invent Varin coordination',()=>{
 const director=new CompanionDirector(),normal={visible:true,interacting:false,cardCapacity:3};
 director.observe(facts([branch('A')]),'current',null,normal);
 const frame=director.observe(facts([branch('A'),branch('B','accepted')]),'current',id('B'),normal);
 expect(frame.interactionRoute).toBe('unknown');expect(frame.body.verb).toBe('review-portfolio');expect(frame.body.edge).toBeNull();
 expect(frame.inspection?.identity).toEqual(id('B'));
 const notified=director.observe(facts([branch('A'),branch('B','completed')]),'current',id('A'),normal);
 expect(notified.body.verb).toBe('notify-result');expect(notified.body.subject).toEqual(id('B'));expect(notified.body.edge?.runId).toBe('run-B');
});
it('agent-companion notifies exact requests and exceptions; consuming a visual edge cannot resolve them',()=>{
 const director=new CompanionDirector(),normal={visible:true,interacting:false,cardCapacity:3,interactionRoute:'agent-companion' as const};
 const data=facts([branch('A'),branch('B')],[request('B')]);
 const before=director.observe(data,'current',id('A'),normal);
 expect(before.body.verb).toBe('notify-attention');expect(before.body.attentionOwner).toEqual(id('B'));
 director.consumeEdge('not-a-request');
 expect(director.observe(data,'current',id('B'),normal).counts?.actionRequired).toBe(1);
 const failure={...request('A'),key:'failure',kind:'run_failed' as const,actionable:false};
 const after=director.observe(facts([branch('A','failed')],[failure]),'current',null,normal);
 expect(after.body.verb).toBe('notify-attention');expect(after.body.attentionItem?.kind).toBe('run_failed');expect(after.counts?.actionRequired).toBe(0);
});

it('preserves explicit Bot coordination while mode changes never replay past intake',()=>{
 const director=new CompanionDirector(),bot={visible:true,interacting:false,cardCapacity:3,interactionRoute:'bot-coordinator' as const};
 director.observe(facts([branch('A')]),'current',null,bot);
 const incoming=facts([branch('A'),{...branch('B','accepted'),botId:'bot-B'}]);
 expect(director.observe(incoming,'current',null,bot).body.verb).toBe('receive-work');
 const agent=director.observe(incoming,'current',id('B'),{...bot,interactionRoute:'agent-companion'});
 expect(agent.body.edge).toBeNull();expect(agent.body.verb).toBe('review-portfolio');
 expect(director.observe(incoming,'current',null,bot).body.edge).toBeNull();
});

it('Bot workspace never coordinates unrelated Agent background work but still coordinates actual Bot work',()=>{
 const director=new CompanionDirector(),bot={...options,interactionRoute:'bot-coordinator' as const};
 const a=branch('A'),b={...branch('B'),botId:'bot-B'};
 director.observe(facts([a,b]),'current',id('A'),bot);
 const started=director.observe(facts([{...branch('A','accepted','new-A'),botId:null},b]),'current',id('A'),bot);
 expect(started.body.edge).toBeNull();expect(started.inspectionRoute).toBe('unknown');
 const result=director.observe(facts([{...branch('A','completed','new-A'),botId:null},b]),'current',id('A'),bot);
 expect(result.body.verb).toBe('notify-result');expect(result.body.subject).toEqual(id('A'));expect(result.body.subjectRoute).toBe('unknown');
 const botStart=director.observe(facts([a,{...branch('B','accepted','new-B'),botId:'bot-B'}]),'current',id('B'),bot);
 expect(botStart.body.verb).toBe('receive-work');expect(botStart.body.subjectRoute).toBe('bot-coordinator');expect(botStart.inspectionRoute).toBe('bot-coordinator');
});
it('mixed requests choose the exact subject route without losing other tasks or treating old Host metadata as ownership',()=>{
 const director=new CompanionDirector(),bot={...options,interactionRoute:'bot-coordinator' as const};
 const branches=[{...branch('A'),botId:null},{...branch('B'),botId:'bot-B'},branch('old-host')];
 const data=facts(branches,[request('A'),request('B','question'),request('old-host')]);
 const first=director.observe(data,'current',id('B'),bot);
 expect(first.body.verb).toBe('notify-attention');expect(first.body.subject).toEqual(id('A'));expect(first.counts?.actionRequired).toBe(3);expect(first.cards).toHaveLength(3);
 const second=director.observe(facts(branches,[request('B','question'),request('old-host')]),'current',id('A'),bot);
 expect(second.body.verb).toBe('present-attention');expect(second.body.subjectRoute).toBe('bot-coordinator');expect(second.inspectionRoute).toBe('unknown');expect(second.counts?.actionRequired).toBe(2);
 const agent=director.observe(data,'current',id('B'),{...bot,interactionRoute:'agent-companion'});
 expect(agent.body.verb).toBe('notify-attention');expect(agent.inspectionRoute).toBe('agent-companion');
 const old=director.observe(facts(branches,[request('old-host')]),'current',id('old-host'),bot);
 expect(old.body.verb).toBe('notify-attention');expect(old.inspectionRoute).toBe('unknown');
});

it('does not borrow root Bot ownership for a mismatched nested request or retain a withdrawn intake',()=>{
 const director=new CompanionDirector(),bot={...options,interactionRoute:'bot-coordinator' as const};
 const root={...branch('A'),botId:'bot-A'},child={...branch('child'),parentThreadId:'A',botId:null};
 const data=facts([root,child],[request('child')]);
 data.teamExecutions=[{parentThreadId:'A',parentBranchId:'branch-A',parentRunId:'run-A',childOperationId:'op-child',executionId:'execution-child',childThreadId:'child',childBranchId:'branch-child',state:'ready',childRunId:'run-child',childRunState:'executing',activity:'running'}];
 const mismatch=director.observe(data,'current',id('A'),bot);
 expect(mismatch.body.subject).toEqual(id('A'));expect(mismatch.body.attentionOwner).toEqual(id('child'));expect(mismatch.body.subjectRoute).toBe('unknown');
 const incoming=facts([{...branch('A','accepted','next-A'),botId:'bot-A'}]);
 expect(director.observe(incoming,'current',null,bot).body.verb).toBe('receive-work');
 const withdrawn={...incoming,branches:incoming.branches.map(row=>({...row,botId:null}))};
 expect(director.observe(withdrawn,'current',null,bot).body.edge).toBeNull();
});
