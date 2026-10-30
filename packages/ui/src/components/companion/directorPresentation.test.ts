import { expect, it } from 'vitest';
import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';
import { CompanionDirector } from './directorPresentation';
import { agentAvatarForIdentity } from '@varin/protocol';
const options={visible:true,interacting:false,cardCapacity:3,interactionRoute:'coordination-review' as const};
const id=(threadId:string):ThreadIdentity=>({runtime:'agent',threadId,branchId:`branch-${threadId}`});
function branch(threadId:string,state:NonNullable<ThreadAttentionBranch['currentRun']>['state']='executing',runId=`run-${threadId}`):ThreadAttentionBranch {
 const run={id:runId,state,revision:1,cancelRequested:false};
 return {...id(threadId),title:`Task ${threadId}`,botId:null,parentThreadId:null,archived:false,deleted:false,activeRunId:['completed','failed','cancelled'].includes(state)?null:runId,currentRun:run,latestRun:run,hasUnsettledWork:!['completed','failed','cancelled'].includes(state)};
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
 expect(value.cards[0]?.relation).toBe('unclassified-task');expect(value.cards[0]?.lead.identity).toBe('child');expect(value.cards[0]?.lead.role).toBe('task');
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

const botOptions={...options,interactionRoute:'bot-coordinator' as const};
function botFacts(cursor:number, children:ThreadAttentionBranch[], items:ThreadAttentionItem[]=[], acceptedCursor=1):ThreadAttentionSnapshot {
 const root={...branch('E'),botId:'bot'};
 const owned=children.map(child=>({...child,botId:'bot',parentThreadId:child.parentThreadId??'E'}));
 return {...facts([root,...owned],items),eventCursor:cursor,
  botEntries:[{botId:'bot',threadId:'E',branchId:'branch-E',profileRevision:1}],
  delegations:owned.map(child=>({operationId:`op-${child.threadId}`,parentThreadId:child.parentThreadId!,parentBranchId:`branch-${child.parentThreadId}`,parentRunId:`run-${child.parentThreadId}`,childThreadId:child.threadId,childBranchId:child.branchId,acceptedCursor}))};
}
it('uses verified Bot entry as Varin, its direct tasks as leads and their children as small agents',()=>{
 const director=new CompanionDirector(),child={...branch('a-child'),parentThreadId:'A'};
 const data=botFacts(10,[branch('A'),branch('B'),child]);
 data.teamExecutions=[{parentThreadId:'A',parentBranchId:'branch-A',parentRunId:'run-A',childOperationId:'op-a-child',executionId:'exec-child',childThreadId:'a-child',childBranchId:'branch-a-child',state:'ready',childRunId:'run-a-child',childRunState:'executing',activity:'running'}];
 const view=director.observe(data,'current',id('A'),botOptions);
 expect(view.cards.map(card=>card.identity.threadId)).toEqual(['A','B']);
 expect(view.cards.every(card=>card.lead.role==='project-lead')).toBe(true);
 expect(view.cards[0]?.children.map(member=>member.identity.threadId)).toEqual(['a-child']);
 expect(view.counts?.activeProjectTasks).toBe(2);expect(view.body.edge).toBeNull();
 const endedChild={...data,eventCursor:11,teamExecutions:[]};
 expect(director.observe(endedChild,'current',id('A'),botOptions).cards.map(card=>card.identity.threadId)).toEqual(['A','B']);
});
it('detects new dispatch cursor even after execution starts, once, not initial/reconnect/newly verified history',()=>{
 const director=new CompanionDirector();director.observe(botFacts(10,[]),'current',null,botOptions);
 const data=botFacts(20,[branch('A','executing')],[],15);
 const incoming=director.observe(data,'current',id('A'),botOptions);
 expect(incoming.body.verb).toBe('receive-work');expect(incoming.body.edge).toMatchObject({dispatchOperationId:'op-A',runId:'run-A'});
 director.consumeEdge(incoming.body.edge!.key);expect(director.observe(data,'current',null,botOptions).body.edge).toBeNull();
 director.observe(data,'unknown',null,botOptions);expect(director.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const fresh=new CompanionDirector();expect(fresh.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const late=new CompanionDirector();late.observe({...botFacts(10,[]),botEntries:[]},'current',null,botOptions);
 expect(late.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const finished=new CompanionDirector();finished.observe(botFacts(10,[]),'current',null,botOptions);
 expect(finished.observe(botFacts(20,[branch('A','completed')],[],15),'current',null,botOptions).body.edge).toBeNull();
});
it('allows dispatch intake before a child Run exists without borrowing the parent Run identity',()=>{
 const director=new CompanionDirector();director.observe(botFacts(10,[]),'current',null,botOptions);
 const next=botFacts(20,[{...branch('A'),currentRun:null,latestRun:null,activeRunId:null}],[],15);
 expect(director.observe(next,'current',null,botOptions).body.edge).toMatchObject({kind:'receive-work',dispatchOperationId:'op-A',runId:null});
});
it('keeps root requests exact and visible to the body without rendering another Varin lead',()=>{
 const view=new CompanionDirector().observe(botFacts(10,[branch('A')],[request('E')]),'current',null,botOptions);
 expect(view.cards.map(card=>card.identity.threadId)).toEqual(['A']);
 expect(view.body.subject).toEqual(id('E'));expect(view.body.attentionOwner).toEqual(id('E'));expect(view.body.verb).toBe('notify-attention');expect(view.counts?.actionRequired).toBe(1);
});
it('keeps mixed Agent work notification-only in Bot view while actual Bot requests coordinate',()=>{
 const director=new CompanionDirector();const data=botFacts(10,[branch('B')],[request('A'),request('B','question')]);data.branches.push(branch('A'));
 const first=director.observe(data,'current',id('A'),botOptions);
 expect(first.body.verb).toBe('notify-attention');expect(first.inspectionRoute).toBe('unknown');expect(first.counts?.actionRequired).toBe(2);
 const second=director.observe({...data,eventCursor:11,items:[request('B','question')]},'current',id('B'),botOptions);
 expect(second.body.verb).toBe('present-attention');expect(second.inspectionRoute).toBe('bot-coordinator');
 const agent=director.observe(data,'current',id('B'),{...botOptions,interactionRoute:'agent-companion'});
 expect(agent.body.verb).toBe('notify-attention');expect(agent.inspectionRoute).toBe('agent-companion');
});
it('does not guess roles or coordination with absent/conflicting root evidence',()=>{
 const data=botFacts(10,[branch('A')],[request('A')]);
 const missing=new CompanionDirector().observe({...data,botEntries:undefined},'current',id('A'),botOptions);
 expect(missing.cards.every(card=>card.lead.role==='task')).toBe(true);expect(missing.body.verb).toBe('notify-attention');expect(missing.counts?.actionRequired).toBe(1);
 const conflicting={...data,botEntries:[...data.botEntries!,{botId:'bot',threadId:'A',branchId:'branch-A',profileRevision:1}]};
 const view=new CompanionDirector().observe(conflicting,'current',id('A'),botOptions);
 expect(view.body.subjectRoute).toBe('unknown');expect(view.cards.some(card=>card.identity.threadId==='A')).toBe(true);
});

it('expresses observed Agent execution, not preparation, waits, unsettled effects or unknown ownership', () => {
 const director = new CompanionDirector(), agent = {...options, interactionRoute:'agent-companion' as const};
 const observe = (data:ThreadAttentionSnapshot) => director.observe(data,'current',null,agent).body.workActive;
 for (const state of ['generating','executing'] as const) expect(observe(facts([branch('A',state)]))).toBe(true);
 for (const state of ['accepted','preparing','runnable','waiting','completed','failed','cancelled'] as const) expect(observe(facts([branch('A',state)]))).toBe(false);
 for (const patch of [{botId:undefined},{botId:'bot'},{parentThreadId:'missing'}, {archived:true},{deleted:true}, {activeRunId:null},{activeRunId:'another'},{currentRun:null}]) expect(observe(facts([{...branch('A'),...patch}]))).toBe(false);
 const cancelling=branch('A');cancelling.currentRun!.cancelRequested=true;
 expect(observe(facts([cancelling]))).toBe(false);
 const settling=branch('A','completed');settling.hasUnsettledWork=true;
 expect(observe(facts([settling]))).toBe(false);
 // A parked process observer may outlive its executor. Compact attention has
 // no independent process phase: unsettled work alone is not active execution.
 const parked=branch('A','waiting');parked.hasUnsettledWork=true;
 expect(observe(facts([parked]))).toBe(false);
});

it('uses verified Bot entry execution without inventing an external project or child', () => {
 const director = new CompanionDirector(), bot={...options,interactionRoute:'bot-coordinator' as const};
 const root={...branch('root'),botId:'bot'}, data=facts([root]);
 expect(director.observe(data,'current',null,bot).body.workActive).toBe(false);
 data.botEntries=[{botId:'bot',threadId:'root',branchId:'branch-root',profileRevision:1}];
 const result=director.observe(data,'current',null,bot);
 expect(result.body.workActive).toBe(true);expect(result.cards).toEqual([]);expect(result.body.edge).toBeNull();
 const child={...branch('child'),botId:'bot',parentThreadId:'root'};
 data.branches=[{...root,currentRun:null,activeRunId:null,hasUnsettledWork:false},child];
 expect(director.observe(data,'current',null,bot).body.workActive).toBe(false);
 data.delegations=[{operationId:'dispatch',parentThreadId:'root',parentBranchId:'branch-root',parentRunId:'run-root',childThreadId:'child',childBranchId:'branch-child',acceptedCursor:1}];
 expect(director.observe(data,'current',null,bot).body.workActive).toBe(true);
});

it('exits expressive work on attention, lost health, hidden/drag and resumes only the newest facts', () => {
 const director=new CompanionDirector(),agent={...options,interactionRoute:'agent-companion' as const};
 const data=facts([branch('A')]);
 const observe=(value=data,health:'current'|'unknown'|'synchronizing'='current',opts=agent)=>director.observe(value,health,null,opts).body.workActive;
 expect(observe()).toBe(true);
 for (const kind of ['permission','question','computer_permission','mcp_elicitation','mcp_sampling_request','mcp_sampling_output','run_failed','preparation_failed','mcp_error','effect_unknown','cancelling'] as const) {
  const item={...request('A'),kind,actionable:!['run_failed','preparation_failed','mcp_error','effect_unknown','cancelling'].includes(kind)};
  expect(observe(facts([branch('A')],[item]))).toBe(false);
 }
 expect(observe(data,'unknown')).toBe(false);expect(observe(data,'synchronizing')).toBe(false);
 expect(observe(data,'current',{...agent,visible:false})).toBe(false);
 expect(observe(data,'current',{...agent,interacting:true})).toBe(false);
 expect(observe(facts([branch('A','waiting')]))).toBe(false);
 expect(observe()).toBe(true);
 expect(director.observe(data,'current',null,{...agent,interactionRoute:'unknown'}).body.workActive).toBe(false);
});
