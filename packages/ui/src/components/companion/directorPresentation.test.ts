import { expect, it } from 'vitest';
import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';
import { CompanionDirector } from './directorPresentation';
import { agentAvatarForIdentity } from '@varin/protocol';
const options={visible:true,interacting:false,cardCapacity:3,interactionRoute:'coordination-review' as const};
const id=(threadId:string):ThreadIdentity=>({runtime:'agent',threadId,branchId:`branch-${threadId}`});
function branch(threadId:string,state:NonNullable<ThreadAttentionBranch['currentRun']>['state']='executing',runId=`run-${threadId}`):ThreadAttentionBranch {
 const run={id:runId,state,revision:1,cancelRequested:false,visibleOutput:null};
 return {...id(threadId),title:`Task ${threadId}`,botId:null,botSessionThreadId:null,parentThreadId:null,archived:false,deleted:false,activeRunId:['completed','failed','cancelled'].includes(state)?null:runId,currentRun:run,latestRun:run,hasUnsettledWork:!['completed','failed','cancelled'].includes(state)};
}
function facts(branches:ThreadAttentionBranch[],items:ThreadAttentionItem[]=[]):ThreadAttentionSnapshot {
 return {teamExecutions:[],delegations:[],follows:[],epoch:1,eventCursor:1,coverage:{native:'complete',external:'unsupported',scope:'host'},branches,items,counts:{actionRequired:items.filter(x=>x.actionable).length,affectedBranches:new Set(items.filter(x=>x.actionable).map(x=>x.branchId)).size,unknownEffects:items.filter(x=>x.kind==='effect_unknown').length}};
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
 data.delegations=[{...relation(child,1),operationId:'op-child',parentRunId:'older-parent-run'}];
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

const botOptions={...options,interactionRoute:'bot-coordinator' as const,botId:'bot'};
const relation=(child:ThreadAttentionBranch,acceptedCursor:number|null)=>({operationId:`op-${child.threadId}`,parentThreadId:child.parentThreadId!,parentBranchId:`branch-${child.parentThreadId}`,parentRunId:`run-${child.parentThreadId}`,childThreadId:child.threadId,childBranchId:child.branchId,acceptedCursor,continuedCursor:null,continuedByThreadId:null,reportCursor:null,reportOutcome:null});
function botFacts(cursor:number, children:ThreadAttentionBranch[], items:ThreadAttentionItem[]=[], acceptedCursor=1, bot='bot', session='E'):ThreadAttentionSnapshot {
 const root={...branch(session),botId:bot,botSessionThreadId:session};
 const owned=children.map(child=>({...child,botId:bot,botSessionThreadId:session,parentThreadId:child.parentThreadId??session}));
 return {...facts([root,...owned],items),eventCursor:cursor,delegations:owned.map(child=>relation(child,acceptedCursor))};
}
it('uses Bot sessions as Varin, their direct tasks as leads and their children as small agents',()=>{
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
 expect(incoming.body.verb).toBe('dispatch-work');expect(incoming.body.edge).toMatchObject({dispatchOperationId:'op-A',runId:'run-A'});
 director.consumeEdge(incoming.body.edge!.key);expect(director.observe(data,'current',null,botOptions).body.edge).toBeNull();
 director.observe(data,'unknown',null,botOptions);expect(director.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const fresh=new CompanionDirector();expect(fresh.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const unbound=botFacts(10,[]);unbound.branches=unbound.branches.map(value=>({...value,botSessionThreadId:null}));
 const late=new CompanionDirector();late.observe(unbound,'current',null,botOptions);
 expect(late.observe(data,'current',null,botOptions).body.edge).toBeNull();
 const finished=new CompanionDirector();finished.observe(botFacts(10,[]),'current',null,botOptions);
 expect(finished.observe(botFacts(20,[branch('A','completed')],[],15),'current',null,botOptions).body.edge).toBeNull();
});
it('allows a dispatch beat before a child Run exists without borrowing the parent Run identity',()=>{
 const director=new CompanionDirector();director.observe(botFacts(10,[]),'current',null,botOptions);
 const next=botFacts(20,[{...branch('A'),currentRun:null,latestRun:null,activeRunId:null}],[],15);
 expect(director.observe(next,'current',null,botOptions).body.edge).toMatchObject({kind:'dispatch-work',dispatchOperationId:'op-A',runId:null});
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
it('does not guess roles or coordination without a Catalog session binding',()=>{
 const data=botFacts(10,[branch('A')],[request('A')]);
 const missing=new CompanionDirector().observe({...data,branches:data.branches.map(value=>({...value,botSessionThreadId:null}))},'current',id('A'),botOptions);
 expect(missing.cards.every(card=>card.lead.role==='task')).toBe(true);expect(missing.body.verb).toBe('notify-attention');expect(missing.counts?.actionRequired).toBe(1);
 // Neither the shell nor a missing choice can make her coordinate for some Bot.
 const unchosen=new CompanionDirector().observe(data,'current',id('A'),{...botOptions,botId:null});
 expect(unchosen.interactionRoute).toBe('unknown');expect(unchosen.body.verb).toBe('notify-attention');
});
it('treats every session of a Bot as its own root and keeps another Bot neutral',()=>{
 const first=botFacts(10,[branch('A')]),second=botFacts(10,[branch('B')],[request('B','question')],1,'bot','F'),other=botFacts(10,[branch('C')],[],1,'other','G');
 const data={...first,branches:[...first.branches,...second.branches,...other.branches],items:second.items,delegations:[...first.delegations,...second.delegations,...other.delegations],counts:second.counts};
 // Her own Bot's work comes first; another Bot's lead is still shown, after it.
 const view=new CompanionDirector().observe(data,'current',null,botOptions);
 expect(view.cards.map(card=>[card.identity.threadId,card.lead.role])).toEqual([['B','project-lead'],['A','project-lead'],['C','project-lead']]);
 expect(view.body.verb).toBe('present-attention');expect(view.body.subject).toEqual(id('B'));
 expect(new CompanionDirector().observe(data,'current',id('C'),botOptions).inspectionRoute).toBe('unknown');
 const asOther=new CompanionDirector().observe(data,'current',id('C'),{...botOptions,botId:'other'});
 expect(asOther.body.verb).toBe('notify-attention');expect(asOther.inspectionRoute).toBe('bot-coordinator');
});
it('takes in work asked again by a session, not a user continuing it in the workbench',()=>{
 const director=new CompanionDirector();
 const before=botFacts(10,[branch('A','completed')]);director.observe(before,'current',null,botOptions);
 const redispatch=botFacts(20,[branch('A','executing','run-again')]);redispatch.delegations[0]!.continuedCursor=15;redispatch.delegations[0]!.continuedByThreadId='E';
 const intake=director.observe(redispatch,'current',null,botOptions);
 expect(intake.body.verb).toBe('dispatch-work');expect(intake.body.edge).toMatchObject({dispatchOperationId:'op-A',runId:'run-again'});
 expect(intake.body.edge?.key).toContain('15');
 director.consumeEdge(intake.body.edge!.key);expect(director.observe(redispatch,'current',null,botOptions).body.edge).toBeNull();
 const user=new CompanionDirector();user.observe(before,'current',null,botOptions);
 const continued=botFacts(20,[branch('A','executing','run-user')]);continued.delegations[0]!.continuedCursor=15;continued.delegations[0]!.continuedByThreadId='workbench-user';
 expect(user.observe(continued,'current',null,botOptions).body.edge).toBeNull();
});
it('waits for the Bot to reply publicly; a dispatched Run end or quiet round is no presentation',()=>{
 const director=new CompanionDirector();
 director.observe(botFacts(10,[branch('A')]),'current',null,botOptions);
 const reported=botFacts(11,[branch('A','completed')]);reported.delegations[0]!.reportCursor=11;reported.delegations[0]!.reportOutcome='succeeded';
 const afterReport=director.observe(reported,'current',null,botOptions);
 expect(afterReport.body.edge).toBeNull();expect(afterReport.cards[0]?.status).toBe('result');
 const quiet=botFacts(12,[branch('A','completed')]);quiet.branches[0]={...quiet.branches[0]!,...branch('E','completed','run-quiet'),botId:'bot',botSessionThreadId:'E'};
 director.observe({...quiet,branches:[{...quiet.branches[0]!,...branch('E','executing','run-quiet'),botId:'bot',botSessionThreadId:'E'},...quiet.branches.slice(1)]},'current',null,botOptions);
 quiet.branches[0]!.latestRun={...quiet.branches[0]!.latestRun!,visibleOutput:false};
 expect(director.observe(quiet,'current',null,botOptions).body.edge).toBeNull();
 const replying=botFacts(13,[branch('A','completed')]);replying.branches[0]={...branch('E','executing','run-reply'),botId:'bot',botSessionThreadId:'E'};
 director.observe(replying,'current',null,botOptions);
 const replied=botFacts(14,[branch('A','completed')]);replied.branches[0]={...branch('E','completed','run-reply'),botId:'bot',botSessionThreadId:'E'};
 replied.branches[0]!.latestRun={...replied.branches[0]!.latestRun!,visibleOutput:true};
 const view=director.observe(replied,'current',null,botOptions);
 expect(view.body.verb).toBe('present-reply');expect(view.body.edge).toMatchObject({kind:'present-reply',runId:'run-reply',project:id('E')});
 expect(view.body.subjectRoute).toBe('bot-coordinator');
 // As the Agent companion, the same Bot reply is not her beat.
 const agent=new CompanionDirector(),agentOptions={...options,interactionRoute:'agent-companion' as const};
 agent.observe(replying,'current',null,agentOptions);expect(agent.observe(replied,'current',null,agentOptions).body.edge).toBeNull();
});
it('shows followed ordinary tasks as followed, never as dispatched work',()=>{
 const director=new CompanionDirector();
 const data=botFacts(10,[branch('A')]);data.branches.push(branch('T'));data.follows=[{botId:'bot',matterId:'release',threadId:'T',branchId:'branch-T'}];
 director.observe(data,'current',null,botOptions);
 const view=director.observe({...data,eventCursor:20},'current',null,botOptions);
 expect(view.cards.find(card=>card.identity.threadId==='T')?.relation).toBe('followed-task');
 expect(view.cards.find(card=>card.identity.threadId==='A')?.relation).toBe('project-task');
 expect(view.body.edge).toBeNull();
 const other=director.observe({...data,follows:[{botId:'other',matterId:'m',threadId:'T',branchId:'branch-T'}]},'current',null,botOptions);
 expect(other.cards.find(card=>card.identity.threadId==='T')?.relation).toBe('project-task');
});

it('expresses observed Agent execution, not preparation, waits, unsettled effects or unknown ownership', () => {
 const director = new CompanionDirector(), agent = {...options, interactionRoute:'agent-companion' as const};
 const observe = (data:ThreadAttentionSnapshot) => director.observe(data,'current',null,agent).body.workActive;
 for (const state of ['generating','executing'] as const) expect(observe(facts([branch('A',state)]))).toBe(true);
 for (const state of ['accepted','preparing','runnable','waiting','completed','failed','cancelled'] as const) expect(observe(facts([branch('A',state)]))).toBe(false);
 for (const patch of [{botId:'bot'},{parentThreadId:'missing'}, {archived:true},{deleted:true}, {activeRunId:null},{activeRunId:'another'},{currentRun:null}]) expect(observe(facts([{...branch('A'),...patch}]))).toBe(false);
 const cancelling=branch('A');cancelling.currentRun!.cancelRequested=true;
 expect(observe(facts([cancelling]))).toBe(false);
 const settling=branch('A','completed');settling.hasUnsettledWork=true;
 expect(observe(facts([settling]))).toBe(false);
 // A parked process observer may outlive its executor. Compact attention has
 // no independent process phase: unsettled work alone is not active execution.
 const parked=branch('A','waiting');parked.hasUnsettledWork=true;
 expect(observe(facts([parked]))).toBe(false);
});

it('types only for her own Bot session rounds; dispatched Agents work on their cards', () => {
 const director = new CompanionDirector(), bot={...options,interactionRoute:'bot-coordinator' as const,botId:'bot'};
 const root={...branch('root'),botId:'bot'}, data=facts([root]);
 expect(director.observe(data,'current',null,bot).body.workActive).toBe(false);
 data.branches=[{...root,botSessionThreadId:'root'}];
 const result=director.observe(data,'current',null,bot);
 expect(result.body.workActive).toBe(true);expect(result.cards).toEqual([]);expect(result.body.edge).toBeNull();
 expect(director.observe(data,'current',null,{...bot,botId:'other'}).body.workActive).toBe(false);
 const child={...branch('child'),botId:'bot',botSessionThreadId:'root',parentThreadId:'root'};
 data.branches=[{...root,botSessionThreadId:'root',currentRun:null,activeRunId:null,hasUnsettledWork:false},child];
 data.delegations=[relation(child,1)];
 const dispatched=director.observe(data,'current',null,bot);
 expect(dispatched.body.workActive).toBe(false);expect(dispatched.cards[0]?.status).toBe('active');
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

it('separates new Bot-root intake from child dispatch without replaying restored roots or hidden work', () => {
 const start=botFacts(10,[]); const next=botFacts(20,[]);
 next.branches[0]={...next.branches[0]!,activeRunId:'new-root',currentRun:{id:'new-root',state:'preparing',revision:2,cancelRequested:false,visibleOutput:null}};
 const director=new CompanionDirector();director.observe(start,'current',null,botOptions);
 const view=director.observe(next,'current',null,botOptions);
 expect(view.body.verb).toBe('receive-work');expect(view.body.subject).toEqual(id('E'));
 expect(view.body.edge).toMatchObject({kind:'receive-work',runId:'new-root',rootProfileRevision:expect.any(String)});
 expect(view.body.subjectRoute).toBe('bot-coordinator');expect(view.cards).toEqual([]);
 director.consumeEdge(view.body.edge!.key);expect(director.observe(next,'current',null,botOptions).body.edge).toBeNull();
 const restored=new CompanionDirector();restored.observe({...start,branches:start.branches.map(branch=>({...branch,botSessionThreadId:null}))},'current',null,botOptions);
 expect(restored.observe(next,'current',null,botOptions).body.edge).toBeNull();
 const hidden=new CompanionDirector();hidden.observe(start,'current',null,botOptions);hidden.observe(next,'current',null,{...botOptions,visible:false});
 expect(hidden.observe(next,'current',null,botOptions).body.edge).toBeNull();
 const changedProfile=new CompanionDirector();changedProfile.observe(start,'current',null,botOptions);
 expect(changedProfile.observe({...next,branches:next.branches.map(branch=>({...branch,botId:'another-bot'}))},'current',null,botOptions).body.edge).toBeNull();
});

it('uses content-free reasoning phase only for the exact Bot root, not generic generation or a child', () => {
 const data=botFacts(20,[branch('A','generating')]); const root=data.branches[0]!;
 root.currentRun={id:root.activeRunId!,state:'generating',revision:2,cancelRequested:false,visibleOutput:null,generation:{requestId:'request-current',phase:'reasoning',revision:19}};
 const observe=(value:ThreadAttentionSnapshot, route=botOptions)=>new CompanionDirector().observe(value,'current',null,route);
 expect(observe(data).body.activity).toMatchObject({kind:'thinking',subject:id('E')});
 for(const phase of ['output','tool-call'] as const) {
  const copy=structuredClone(data);copy.branches[0]!.currentRun!.generation!.phase=phase;
  expect(observe(copy).body.activity).toBeUndefined();expect(observe(copy).body.workActive).toBe(true);
 }
 for(const patch of [{generation:undefined},{generation:{requestId:'stale',phase:'reasoning' as const,revision:21}},{cancelRequested:true},{state:'executing' as const}]) {
  const copy=structuredClone(data);Object.assign(copy.branches[0]!.currentRun!,patch);expect(observe(copy).body.activity).toBeUndefined();
 }
 const child=structuredClone(data);delete child.branches[0]!.currentRun!.generation;
 child.branches[1]!.currentRun!.generation={requestId:'child-request',phase:'reasoning',revision:19};expect(observe(child).body.activity).toBeUndefined();
 expect(new CompanionDirector().observe(data,'unknown',null,botOptions).body.activity).toBeUndefined();
 expect(observe({...data,items:[request('A')],counts:{actionRequired:1,affectedBranches:1,unknownEffects:0}}).body.activity).toBeUndefined();
});

it('presents generic root readiness and actual waits without turning preparation into work or parked uncertainty into execution', () => {
 const preparing=botFacts(20,[]);preparing.branches[0]!.currentRun!.state='preparing';
 const view=new CompanionDirector().observe(preparing,'current',null,botOptions);
 expect(view.body.activity?.kind).toBe('preparing');expect(view.body.workActive).toBe(false);
 const childPreparation=botFacts(20,[branch('A','preparing')]);expect(new CompanionDirector().observe(childPreparation,'current',null,botOptions).body.activity).toBeUndefined();
 const agentOptions={...options,interactionRoute:'agent-companion' as const};
 expect(new CompanionDirector().observe(facts([branch('A','waiting')]),'current',null,agentOptions).body.activity?.kind).toBe('waiting');
 expect(new CompanionDirector().observe(facts([branch('A','waiting'),branch('B')]),'current',null,agentOptions).body.activity).toBeUndefined();
 const unsettled=branch('A','completed');unsettled.hasUnsettledWork=true;
 expect(new CompanionDirector().observe(facts([unsettled]),'current',null,agentOptions).body.activity).toBeUndefined();
});

it('keeps a proven retry in waiting until its owner clears it, not until the clock reaches its deadline', () => {
 const data=botFacts(50,[]);const run=data.branches[0]!.currentRun!;run.state='generating';
 run.retry={requestId:'request-retry',attempt:2,scheduledAtMs:1,retryAtMs:2,revision:40};
 const director=new CompanionDirector();const view=director.observe(data,'current',null,botOptions);
 expect(view.body.activity?.kind).toBe('retry');expect(view.body.workActive).toBe(false);
 const concurrent=botFacts(50,[branch('A')]);concurrent.branches[0]!.currentRun=structuredClone(run);
 const working=new CompanionDirector().observe(concurrent,'current',null,botOptions);
 expect(working.body.workActive).toBe(false);expect(working.body.activity?.kind).toBe('retry');
 expect(director.observe(data,'current',null,botOptions).body.activity?.key).toBe(view.body.activity?.key);
 delete run.retry;expect(director.observe({...data,eventCursor:51},'current',null,botOptions).body.activity).toBeUndefined();
 run.retry={requestId:'future-unseen',attempt:3,scheduledAtMs:1,retryAtMs:2,revision:52};
 expect(director.observe(data,'current',null,botOptions).body.activity).toBeUndefined();
});

it('hears only a fresh delivered report for the exact receiving root Run, never a ready or restored report', () => {
 const initial=botFacts(10,[branch('A')]);const delivered=botFacts(20,[branch('A','completed')]);
 delivered.deliveredReports=[{parentThreadId:'E',parentBranchId:'branch-E',parentRunId:'run-E',receivingRunId:'run-E',childOperationId:'op-A',executionId:'execution-A',childThreadId:'A',childBranchId:'branch-A',deliveredCursor:15}];
 const director=new CompanionDirector();director.observe(initial,'current',null,botOptions);
 const view=director.observe(delivered,'current',null,botOptions);
 expect(view.body.verb).toBe('receive-report');expect(view.body.edge).toMatchObject({kind:'receive-report',receiptOperationId:'op-A',receivingRunId:'run-E',outcome:null});
 director.consumeEdge(view.body.edge!.key);expect(director.observe(delivered,'current',null,botOptions).body.edge).toBeNull();
 expect(new CompanionDirector().observe(delivered,'current',null,botOptions).body.edge).toBeNull();
 for(const patch of [{receivingRunId:'old-root'},{parentRunId:'wrong-original'},{childOperationId:'wrong-op'},{deliveredCursor:10},{deliveredCursor:21}]) {
  const copy=structuredClone(delivered);Object.assign(copy.deliveredReports![0]!,patch);
  const fresh=new CompanionDirector();fresh.observe(initial,'current',null,botOptions);
  expect(fresh.observe(copy,'current',null,botOptions).body.edge?.kind).not.toBe('receive-report');
 }
});

it('reacts only to original fresh executor-stop receipts and never treats a cancelled Run as stop proof', () => {
 const agentOptions={...options,interactionRoute:'agent-companion' as const};
 const initial={...facts([branch('A')]),eventCursor:10};
 const stopped={...facts([branch('A','cancelled')]),eventCursor:20,stoppedExecutors:[{threadId:'A',branchId:'branch-A',runId:'run-A',operationId:'operation-A',revision:3,stoppedCursor:15}]};
 stopped.branches[0]!.hasUnsettledWork=true;
 const director=new CompanionDirector();director.observe(initial,'current',null,agentOptions);
 const result=director.observe(stopped,'current',null,agentOptions);
 expect(result.body.verb).toBe('executor-stopped');expect(result.body.edge).toMatchObject({receiptOperationId:'operation-A',outcome:null,workRemains:true});
 expect(result.cards[0]?.status).toBe('settling');
 const resumed=director.observe({...stopped,eventCursor:21,branches:[branch('A','generating','new-run')]},'current',null,agentOptions);
 expect(resumed.body.edge).toBeNull();expect(resumed.body.workActive).toBe(true);
 expect(director.observe({...stopped,eventCursor:22},'current',null,agentOptions).body.edge?.kind).not.toBe('executor-stopped');
 expect(new CompanionDirector().observe(stopped,'current',null,agentOptions).body.edge).toBeNull();
 const stillRunning=new CompanionDirector();stillRunning.observe(initial,'current',null,agentOptions);
 const active={...stopped,branches:[stopped.branches[0]!,branch('B')]};
 expect(stillRunning.observe(active,'current',null,agentOptions).body.edge?.kind).not.toBe('executor-stopped');
 const noReceipt=new CompanionDirector();noReceipt.observe(initial,'current',null,agentOptions);
 expect(noReceipt.observe({...stopped,stoppedExecutors:[]},'current',null,agentOptions).body.edge?.kind).not.toBe('executor-stopped');
});

it('shows the real next-run queue without confusing its predecessor or accepted-but-unqueued runs', () => {
 const agentOptions={...options,interactionRoute:'agent-companion' as const};
 const queued={...branch('A','completed'),activeRunId:null,currentRun:null,queuedRunCount:2};
 const value=new CompanionDirector().observe(facts([queued]),'current',null,agentOptions);
 expect(value.body.verb).toBe('review-portfolio');expect(value.body.activity?.kind).toBe('queued');expect(value.body.workActive).toBe(false);
 expect(value.cards[0]?.status).toBe('active');
 const live={...branch('A'),queuedRunCount:2};
 const current=new CompanionDirector().observe(facts([live]),'current',null,agentOptions);
 expect(current.body.workActive).toBe(true);expect(current.body.activity).toBeUndefined();
 const cleared=new CompanionDirector().observe(facts([{...queued,queuedRunCount:0}]),'current',null,agentOptions);
 expect(cleared.body.verb).toBe('available');expect(cleared.body.activity).toBeUndefined();
});


it('receives a promoted Bot root task once even when the queued successor was already the latest Run', () => {
 const queued=botFacts(10,[]);queued.branches[0]!.queuedRunCount=1;
 queued.branches[0]!.latestRun={id:'queued-successor',state:'accepted',revision:1,cancelRequested:false,visibleOutput:null};
 const director=new CompanionDirector();director.observe(queued,'current',null,botOptions);
 const promoted=structuredClone(queued);promoted.eventCursor=20;promoted.branches[0]!.queuedRunCount=0;
 promoted.branches[0]!.activeRunId='queued-successor';promoted.branches[0]!.currentRun=promoted.branches[0]!.latestRun;
 const next=director.observe(promoted,'current',null,botOptions);
 expect(next.body.edge).toMatchObject({kind:'receive-work',runId:'queued-successor'});
 const restored=new CompanionDirector();restored.observe(queued,'current',null,botOptions);restored.observe(promoted,'unknown',null,botOptions);
 expect(restored.observe(promoted,'current',null,botOptions).body.edge).toBeNull();
 director.consumeEdge(next.body.edge!.key);expect(director.observe(promoted,'current',null,botOptions).body.edge).toBeNull();
});
