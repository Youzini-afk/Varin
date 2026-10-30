import { expect, it } from 'vitest';
import { directorBodyAction } from './directorBody';
import type { DirectorPresentation } from './directorPresentation';
const project = {runtime:'agent' as const,threadId:'project-1',branchId:'branch-1'};
const view: DirectorPresentation = { interactionRoute:'bot-coordinator', inspectionRoute:'bot-coordinator', health: 'current', source: null, body: { subjectRoute:'bot-coordinator', verb: 'review-portfolio', subject: project, attentionOwner: null, attentionMode: null, attentionItem: null, edge: null }, cards: [{key:'project-1',identity:project,title:'Project',botId:'bot',lead:{role:'project-lead',identity:'lead',avatar:'slope-lilac',runId:'run',state:'executing'},status:'active',attentionKeys:[],children:[],relation:'project-task'}], overflowCards: 0, inspectedProjectKey: null, inspection: null, counts: null, coverage: null };
const completed = { key: 'result', kind: 'receive-result' as const, project, runId: 'run', outcome: 'completed' as const, workRemains: false };
it('inspects forward only with actual Bot inspection authority and available art, independent of layout', () => {
  const inspection = { ...view, inspectedProjectKey: 'project-1' };
  for (const side of ['left', 'right', null] as const) {
    expect(directorBodyAction(inspection, side)).toBe('director-supervise');
    expect(directorBodyAction(inspection, side, true, action => action === 'director-inspect')).toBe('director-inspect');
    expect(directorBodyAction(view, side, true, () => true)).toBe('director-supervise');
    expect(directorBodyAction({ ...inspection, interactionRoute: 'agent-companion' }, side, true, () => true)).toBe('director-supervise');
    expect(directorBodyAction({ ...inspection, inspectionRoute: 'unknown' }, side, true, () => true)).toBe('director-supervise');
  }
});
it('presents only completed scoped results, not missing evidence or pending attention', () => {
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'present-attention' } }, 'right')).toBe('director-open-attention');
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'receive-result' } }, 'right')).toBe('director-open-attention');
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'receive-result', edge: completed } }, 'right')).toBe('director-gather-present');
  expect(directorBodyAction({ ...view, health: 'unknown', inspectedProjectKey: 'project-1' }, 'right')).toBe('director-supervise');
});

it('receives and hands off a project without depending on inspection dock direction',()=>{
 expect(directorBodyAction({...view,body:{...view.body,verb:'receive-work'}},null)).toBe('director-intake');
});

it('keeps Agent inspection/new work separate from Bot coordination and faces the user for exact notices',()=>{
 const agent={...view,interactionRoute:'agent-companion' as const,inspectedProjectKey:'A'};
 expect(directorBodyAction(agent,'right')).toBe('director-supervise');
 expect(directorBodyAction({...agent,body:{...agent.body,verb:'receive-work'}},'right')).toBe('director-supervise');
 expect(directorBodyAction({...agent,body:{...agent.body,verb:'notify-attention'}},'right')).toBe('director-open-attention');
 expect(directorBodyAction({...agent,body:{...agent.body,verb:'notify-result'}},'left')).toBe('director-open-attention');
 expect(directorBodyAction({...agent,interactionRoute:'unknown'},'left')).toBe('director-supervise');
});

it('does not borrow the Bot workbench authority for an Agent project or a missing ownership field', () => {
 const mixed={...view,inspectedProjectKey:'agent-A',inspectionRoute:'agent-companion' as const,body:{...view.body,subjectRoute:'unknown' as const}};
 expect(directorBodyAction(mixed,'right')).toBe('director-supervise');
 expect(directorBodyAction({...mixed,body:{...mixed.body,verb:'receive-work'}},'right')).toBe('director-supervise');
 expect(directorBodyAction({...mixed,body:{...mixed.body,verb:'receive-result'}},'right')).toBe('director-open-attention');
 expect(directorBodyAction({...mixed,body:{...mixed.body,verb:'present-attention'}},'left')).toBe('director-open-attention');
});

it('keeps the Bot root request visible as user-facing attention, not an external teammate report', () => {
 const root={...view,cards:[],body:{...view.body,subject:{runtime:'agent' as const,threadId:'bot-entry',branchId:'root'},verb:'present-attention' as const}};
 expect(directorBodyAction(root,'right')).toBe('director-open-attention');
 expect(directorBodyAction({...root,body:{...root.body,verb:'receive-work'}},'right')).toBe('director-supervise');
 expect(root.body.subject.threadId).toBe('bot-entry');
});

it('uses distinct reminder art when available without changing local-response or coordination authority', () => {
 const agent={...view,interactionRoute:'agent-companion' as const,body:{...view.body,verb:'notify-attention' as const}};
 const before=structuredClone(agent);
 expect(directorBodyAction(agent,null,true)).toBe('director-notify-attention');
 expect(directorBodyAction(agent,null,false)).toBe('director-open-attention');
 expect(directorBodyAction({...agent,body:{...agent.body,verb:'notify-result'}},null,true)).toBe('director-notify-attention');
 expect(directorBodyAction({...agent,health:'unknown'},null,true)).toBe('director-supervise');
 expect(directorBodyAction({...view,body:{...view.body,verb:'receive-result',edge:completed}},null,true)).toBe('director-gather-present');
 expect(agent).toEqual(before);
});


it('selects available scoped question/result expressions but never celebrates cancellation or unknown outcomes', () => {
 const agent={...view,interactionRoute:'agent-companion' as const,body:{...view.body,verb:'notify-attention' as const,attentionItem:{key:'q',threadId:project.threadId,branchId:project.branchId,runId:'run',kind:'question' as const,actionable:true,revision:1}}};
 expect(directorBodyAction(agent,null,true,()=>true)).toBe('query');
 expect(directorBodyAction(agent,null,true,()=>false)).toBe('director-notify-attention');
 expect(directorBodyAction(agent,null,false,()=>true)).toBe('query');
 for(const [outcome,expected] of [['completed','completion'],['failed','failure'],['cancelled','director-notify-attention'],[null,'director-notify-attention']] as const){
  const result={...agent,body:{...agent.body,verb:'notify-result' as const,attentionItem:null,edge:{key:'r',kind:'receive-result' as const,project,runId:'run',outcome,workRemains:false}}};
  expect(directorBodyAction(result,null,true,()=>true)).toBe(expected);
  expect(directorBodyAction({...result,health:'unknown'},null,true,()=>true)).toBe('director-supervise');
 }
});

it('keeps known failure attention, unknown effects, and permission semantically distinct', () => {
 for (const [kind, expected] of [['run_failed','failure'],['preparation_failed','failure'],['mcp_error','failure'],['effect_unknown','unknown-effect-check'],['permission','permission']] as const) {
  const notice={...view,interactionRoute:'agent-companion' as const,body:{...view.body,verb:'notify-attention' as const,attentionItem:{key:'notice',threadId:project.threadId,branchId:project.branchId,runId:'run',kind,actionable:true,revision:1}}};
  expect(directorBodyAction(notice,null,true,()=>true)).toBe(expected);
  expect(directorBodyAction(notice,null,true,()=>false)).toBe('director-notify-attention');
 }
});

it('gives Bot pending attention priority over a completed result without consuming or approving it', () => {
  for (const [kind, expected] of [['question', 'query'], ['permission', 'permission'], ['run_failed', 'failure'], ['effect_unknown', 'unknown-effect-check']] as const) {
    const notice = { ...view, inspectedProjectKey: 'project-1', body: { ...view.body, verb: 'present-attention' as const, edge: completed,
      attentionItem: { key: 'pending', threadId: project.threadId, branchId: project.branchId, runId: 'run', kind, actionable: true, revision: 1 } } };
    const before = structuredClone(notice);
    expect(directorBodyAction(notice, 'left', true, () => true)).toBe(expected);
    expect(directorBodyAction(notice, 'right', true, () => false)).toBe('director-notify-attention');
    expect(directorBodyAction({ ...notice, health: 'unknown' }, null, true, () => true)).toBe('director-supervise');
    expect(notice).toEqual(before);
  }
  for (const [outcome, expected] of [['failed', 'failure'], ['cancelled', 'director-notify-attention']] as const) {
    expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'receive-result', edge: { ...completed, outcome } } }, null, true, () => true)).toBe(expected);
  }
});

it('uses working art only for explicit observed work; notices and results still win', () => {
 const working={...view,body:{...view.body,workActive:true}};
 expect(directorBodyAction(working,null,true,()=>true)).toBe('work-active');
 expect(directorBodyAction(working,null,true,()=>false)).toBe('director-supervise');
 expect(directorBodyAction({...working,health:'unknown'},null,true,()=>true)).toBe('director-supervise');
 expect(directorBodyAction({...working,body:{...working.body,verb:'notify-attention'}},null,true,()=>true)).toBe('director-notify-attention');
 expect(directorBodyAction({...working,body:{...working.body,verb:'receive-result',edge:completed}},null,true,()=>true)).toBe('director-gather-present');
 expect(directorBodyAction({...working,cards:[],body:{...working.body,subject:null}},null,true,()=>true)).toBe('work-active');
});
