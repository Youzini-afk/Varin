import { expect, it } from 'vitest';
import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadAttentionTeamExecution, ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import { CompanionDirector } from './directorPresentation';
import { DirectorPortfolioProjector, directorProjectCaption, directorProjectNotice, directorToolDetail } from './directorPortfolio';
import { agentAvatarForIdentity } from '@varin/protocol';
const id=(name:string):ThreadIdentity=>({runtime:'agent',threadId:`thread-${name}`,branchId:`branch-${name}`});
const branch=(name:string,parent:string|null=null):ThreadAttentionBranch=>({...id(name),title:`private title ${name}`,botId:null,parentThreadId:parent?`thread-${parent}`:null,archived:false,deleted:false,activeRunId:`run-${name}`,currentRun:{id:`run-${name}`,state:'executing',revision:1,cancelRequested:false},latestRun:null,hasUnsettledWork:true});
const snapshot=(branches:ThreadAttentionBranch[],items:ThreadAttentionItem[]=[],teamExecutions:ThreadAttentionTeamExecution[]=[]):ThreadAttentionSnapshot=>({epoch:1,eventCursor:1,coverage:{native:'complete',external:'unsupported',scope:'host'},branches,items,teamExecutions,counts:{actionRequired:items.filter(x=>x.actionable).length,affectedBranches:new Set(items.filter(x=>x.actionable).map(x=>x.branchId)).size,unknownEffects:items.filter(x=>x.kind==='effect_unknown').length}});
const row=(parent:string,child:string):ThreadAttentionTeamExecution=>({parentThreadId:id(parent).threadId,parentBranchId:id(parent).branchId,parentRunId:`old-parent-run-${parent}`,childOperationId:`private-operation-${child}`,executionId:`private-execution-${child}`,childThreadId:id(child).threadId,childBranchId:id(child).branchId,state:'ready',childRunId:`run-${child}`,childRunState:'executing',activity:'running'});
const options={visible:true,interacting:false,cardCapacity:3};
const observe=(director:CompanionDirector,data:ThreadAttentionSnapshot,inspection:ThreadIdentity|null=null,health:'current'|'unknown'='current')=>director.observe(data,health,inspection,options);
it('keeps physical A/B/C seats stable, uses fresh opaque replacement keys, and exposes readable captions without runtime identity',()=>{
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const a=snapshot([branch('one'),branch('two'),branch('three')]);
 const initial=mapper.project(observe(director,a),a,1);const keys=initial.portfolio.projects.map(p=>p.key);
 const b=snapshot([branch('three'),branch('two'),branch('four')]);b.eventCursor++;
 const next=mapper.project(observe(director,b),b,1);
 expect(next.legend.map(x=>[x.label,x.identity.threadId])).toEqual([['A','thread-four'],['B','thread-two'],['C','thread-three']]);
 expect(next.portfolio.projects[1]?.key).toBe(keys[1]);expect(next.portfolio.projects[2]?.key).toBe(keys[2]);expect(next.portfolio.projects[0]?.key).not.toBe(keys[0]);
 const wire=JSON.stringify(next.portfolio);expect(next.portfolio.projects[0]).toMatchObject({caption:'private title four'});expect(wire).not.toContain('thread-');expect(wire).not.toContain('run-');
});
it('counts real actionable and uncertain items separately, not every attention key',()=>{
 const items:ThreadAttentionItem[]=[{...id('one'),key:'private-request',runId:'run-one',revision:1,kind:'permission',actionable:true,permissionId:'private-permission'}, {...id('one'),key:'uncertain',runId:'run-one',revision:1,kind:'effect_unknown',actionable:false}, {...id('one'),key:'failure',runId:'run-one',revision:1,kind:'run_failed',actionable:false}];
 const data=snapshot([branch('one')],items),director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const out=mapper.project(observe(director,data),data,1).portfolio;
 expect(out.mode).toBe('attention');expect(out.projects[0]).toMatchObject({requestCount:1,uncertainCount:1});expect(out.subjectKey).toBe(out.projects[0]?.key);
 expect(JSON.stringify(out)).not.toContain('private-request');expect(JSON.stringify(out)).not.toContain('private-permission');
});
it('updates exact project details independently of the body and rejects stale/wrong owner details',()=>{
 const data=snapshot([branch('one')]),director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();const view=observe(director,data);
 const detail={identity:id('one'),runId:'run-one',category:'reading' as const,health:'current' as const};
 const first=mapper.project(view,data,1,[detail]).portfolio;
 const next=mapper.project(view,data,1,[{...detail,category:'editing'}]).portfolio;
 expect(first.projects[0]?.detail).toBe('reading');expect(next.projects[0]?.detail).toBe('editing');expect(next.projects[0]?.key).toBe(first.projects[0]?.key);expect(view.body.verb).toBe('review-portfolio');
 expect(mapper.project(view,data,1,[{...detail,runId:'old-run'}]).portfolio.projects[0]?.detail).toBeUndefined();
 expect(mapper.project(view,data,1,[{...detail,identity:id('child')}]).portfolio.projects[0]?.detail).toBeUndefined();
});
it('never relabels a child inspection roster as the root lead’s direct children',()=>{
 const data=snapshot([branch('root'),branch('child','root'),branch('grandchild','child')],[],[row('root','child'),row('child','grandchild')]);
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const out=mapper.project(observe(director,data,id('child')),data,1).portfolio;
 expect(out.projects).toHaveLength(1);expect(out.teams?.[0]?.projectKey).toBe(out.projects[0]?.key);
 expect(out.teams?.[0]?.members.map(m=>m.avatar)).toEqual([agentAvatarForIdentity('thread-child')]);
 expect(out.teams?.[0]?.members).toHaveLength(1);expect(out.inspectedKey).toBe(out.projects[0]?.key);
});
it('bounds actual child seats, preserves survivors and never invents a child for a lonely lead',()=>{
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const data=snapshot([branch('root'),...['a','b','c','d'].map(x=>branch(x,'root'))],[],['a','b','c','d'].map(x=>row('root',x)));
 const first=mapper.project(observe(director,data,id('root')),data,1).portfolio;
 expect(first.teams?.[0]?.members).toHaveLength(3);expect(first.teams?.[0]?.overflowCount).toBe(1);
 const nextData={...data,eventCursor:2,teamExecutions:data.teamExecutions.slice(1)};
 const next=mapper.project(observe(director,nextData,id('root')),nextData,1).portfolio;
 expect(next.teams?.[0]?.members[0]?.key).toBe(first.teams?.[0]?.members[1]?.key);expect(next.teams?.[0]?.members[1]?.key).toBe(first.teams?.[0]?.members[2]?.key);
 const alone=snapshot([branch('root')]);alone.eventCursor=3;
 const last=mapper.project(observe(director,alone,id('root')),alone,1).portfolio;
 expect(last.projects[0]?.lead.role).toBe('project-lead');expect(last.teams?.[0]?.members).toEqual([]);expect(last.teams?.[0]?.overflowCount).toBe(0);
});
it('marks stale/mismatched snapshot counts unknown, hides team/details, and isolates Host scope tokens',()=>{
 const data=snapshot([branch('one')]),director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();const view=observe(director,data,id('one'));
 const first=mapper.project(view,data,1).portfolio;
 const stale=mapper.project(view,{...data,eventCursor:2},1,[{identity:id('one'),runId:'run-one',category:'reading',health:'current'}]).portfolio;
 expect(stale.projects[0]).toMatchObject({status:'unknown',requestCount:null,uncertainCount:null});expect(stale.overflowCards).toBeNull();expect(stale.teams).toBeUndefined();expect(stale.projects[0]?.detail).toBeUndefined();
 expect(mapper.project(view,data,2).portfolio.projects[0]?.key).not.toBe(first.projects[0]?.key);
});
it('shows a result subject card even when other active projects would otherwise fill every seat',()=>{
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();const before=snapshot(['a','b','c','d'].map(x=>branch(x)));
 director.observe(before,'current',null,options);
 const after={...before,eventCursor:2,branches:before.branches.map(x=>x.threadId==='thread-d'?{...x,activeRunId:null,currentRun:{...x.currentRun!,state:'completed' as const},latestRun:{...x.currentRun!,state:'completed' as const},hasUnsettledWork:false}:x)};
 const out=mapper.project(observe(director,after),after,1).portfolio;
 expect(out.mode).toBe('result');expect(out.subjectKey).not.toBeNull();expect(out.projects.some(x=>x.key===out.subjectKey)).toBe(true);
});
it('derives a tool detail only from matching admitted operations, not executor labels or stale run identity',()=>{
 const source={identity:id('one'),activeRun:{id:'run-one',thread_id:'thread-one',branch_id:'branch-one',state:'executing',cancel_requested:false},operations:[{run_id:'run-one',phase:'running',executor:'whatever',intent:{kind:'tool',call:{name:'file_read',schema_version:'1'},contract:{name:'file_read',schema_version:'1'}}}]} as unknown as ThreadSnapshot;
 expect(directorToolDetail(source,'current')?.category).toBe('reading');
 source.operations[0]!.phase='terminal';expect(directorToolDetail(source,'current')).toBeNull();
 source.operations[0]!.phase='running';source.operations[0]!.run_id='other-run';expect(directorToolDetail(source,'current')).toBeNull();
 expect(directorToolDetail(source,'unknown')).toBeNull();
});

it('shows task names by default and hides them without disturbing stable seats or exact UI navigation',()=>{
 const data=snapshot([branch('one')]),director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();const view=observe(director,data);
 const visible=mapper.project(view,data,1),hidden=mapper.project(view,data,1,[],{hideTaskNames:true});
 expect(visible.portfolio.projects[0]?.caption).toBe('private title one');
 expect(hidden.portfolio.projects[0]?.caption).toBeUndefined();
 expect(hidden.portfolio.projects[0]?.key).toBe(visible.portfolio.projects[0]?.key);
 expect(hidden.legend).toEqual(visible.legend);
 expect(mapper.project(view,data,1).portfolio.projects[0]?.caption).toBe('private title one');
});
it('normalizes display controls, bounds Unicode without splitting surrogates, and leaves markup inert text',()=>{
 expect(directorProjectCaption('  任务\n甲\u202e   待确认  ')).toBe('任务 甲 待确认');
 expect(directorProjectCaption('\u0000 \n')).toBeUndefined();
 expect(directorProjectCaption('😀'.repeat(25))).toBe('😀'.repeat(23)+'…');
 expect(Array.from(directorProjectCaption('项目'.repeat(30))!)).toHaveLength(24);
 expect(directorProjectCaption('<img src=x>')).toBe('<img src=x>');
});

it('keeps simultaneous permission and question notices task-bound and clears only the resolved task',()=>{
 const permission:ThreadAttentionItem={...id('b'),key:'perm',runId:'run-b',revision:1,kind:'permission',actionable:true};
 const question:ThreadAttentionItem={...id('c'),key:'ask',runId:'run-c',revision:1,kind:'question',actionable:true};
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const data=snapshot([branch('b'),branch('c')],[permission,question]);
 const first=mapper.project(observe(director,data),data,1);
 const bKey=first.legend.find(x=>x.identity.threadId==='thread-b')!.key,cKey=first.legend.find(x=>x.identity.threadId==='thread-c')!.key;
 expect(first.portfolio.projects.find(x=>x.key===bKey)).toMatchObject({notice:'permission',requestCount:1});
 expect(first.portfolio.projects.find(x=>x.key===cKey)).toMatchObject({notice:'question',requestCount:1});
 const after={...data,eventCursor:2,items:[question]};
 const next=mapper.project(observe(director,after),after,1).portfolio;
 expect(next.projects.find(x=>x.key===bKey)?.notice).toBeUndefined();
 expect(next.projects.find(x=>x.key===cKey)).toMatchObject({notice:'question',requestCount:1});
});
it('uses mixed for actual categories and never turns failures or unknown effects into answer requests',()=>{
 const item:ThreadAttentionItem={...id('a'),key:'one',runId:'run-a',revision:1,kind:'permission',actionable:true};
 expect(directorProjectNotice([item,{...item,key:'two',kind:'question'}],true)).toBe('mixed');
 expect(directorProjectNotice([{...item,kind:'effect_unknown',actionable:false}],true)).toBe('inspect');
 expect(directorProjectNotice([{...item,kind:'run_failed',actionable:false}],true)).toBe('inspect');
 expect(directorProjectNotice([{...item,kind:'mcp_sampling_output'}],true)).toBe('inspect');
 expect(directorProjectNotice([item],false)).toBe('unknown');
 expect(directorProjectNotice([],true)).toBeUndefined();
});

it('projects independent exact squads for every visible lead without inspection, keeping survivor keys and filtering terminals',()=>{
 const data=snapshot([branch('a'),branch('b'),branch('a1','a'),branch('b1','b')],[],[row('a','a1'),row('b','b1')]);
 const director=new CompanionDirector(),mapper=new DirectorPortfolioProjector();
 const first=mapper.project(observe(director,data),data,1);
 const key=(name:string)=>first.legend.find(x=>x.identity.threadId===`thread-${name}`)!.key;
 const a=first.portfolio.teams!.find(team=>team.projectKey===key('a'))!,b=first.portfolio.teams!.find(team=>team.projectKey===key('b'))!;
 expect(a.members.map(member=>member.avatar)).toEqual([agentAvatarForIdentity('thread-a1')]);
 expect(b.members.map(member=>member.avatar)).toEqual([agentAvatarForIdentity('thread-b1')]);
 expect(a.members[0]?.key).not.toBe(b.members[0]?.key);
 const next={...data,eventCursor:2,teamExecutions:[{...data.teamExecutions[0]!,state:'completed'},data.teamExecutions[1]!]};
 const after=mapper.project(observe(director,next,id('b')),next,1).portfolio;
 expect(after.teams!.find(team=>team.projectKey===key('a'))?.members).toEqual([]);
 expect(after.teams!.find(team=>team.projectKey===key('b'))?.members[0]?.key).toBe(b.members[0]?.key);
 expect(mapper.project(observe(director,next,null,'unknown'),next,1).portfolio.teams).toBeUndefined();
});
