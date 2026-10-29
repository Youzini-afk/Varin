import { expect, it } from 'vitest';
import { directorBodyAction } from './directorBody';
import type { DirectorPresentation } from './directorPresentation';
const project = {runtime:'agent' as const,threadId:'project-1',branchId:'branch-1'};
const view: DirectorPresentation = { interactionRoute:'bot-coordinator', inspectionRoute:'bot-coordinator', health: 'current', source: null, body: { subjectRoute:'bot-coordinator', verb: 'review-portfolio', subject: project, attentionOwner: null, attentionMode: null, attentionItem: null, edge: null }, cards: [{key:'project-1',identity:project,title:'Project',botId:'bot',lead:{role:'project-lead',identity:'lead',avatar:'slope-lilac',runId:'run',state:'executing'},status:'active',attentionKeys:[],children:[],relation:'project-task'}], overflowCards: 0, inspectedProjectKey: null, inspection: null, counts: null, coverage: null };
it('uses direction only for actual managerial attention, not project tool changes', () => {
  expect(directorBodyAction(view, 'left')).toBe('director-supervise');
  const inspection = { ...view, inspectedProjectKey: 'project-1' };
  expect(directorBodyAction(inspection, 'left')).toBe('director-listen-left');
  expect(directorBodyAction(inspection, 'right')).toBe('director-listen-right');
  expect(directorBodyAction(inspection, null)).toBe('director-supervise');
});
it('presents scoped results/attention without a global success or approval action', () => {
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'present-attention' } }, 'right')).toBe('director-gather-present');
  expect(directorBodyAction({ ...view, body: { ...view.body, verb: 'receive-result' } }, 'right')).toBe('director-gather-present');
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
 expect(directorBodyAction({...view,body:{...view.body,verb:'receive-result'}},null,true)).toBe('director-gather-present');
 expect(agent).toEqual(before);
});


it('selects available scoped question/result expressions but never celebrates cancellation or unknown outcomes', () => {
 const agent={...view,interactionRoute:'agent-companion' as const,body:{...view.body,verb:'notify-attention' as const,attentionItem:{key:'q',threadId:project.threadId,branchId:project.branchId,runId:'run',kind:'question' as const,actionable:true,revision:1}}};
 expect(directorBodyAction(agent,null,true,()=>true)).toBe('query');
 expect(directorBodyAction(agent,null,true,()=>false)).toBe('director-notify-attention');
 expect(directorBodyAction(agent,null,false,()=>true)).toBe('director-open-attention');
 for(const [outcome,expected] of [['completed','completion'],['failed','failure'],['cancelled','director-notify-attention'],[null,'director-notify-attention']] as const){
  const result={...agent,body:{...agent.body,verb:'notify-result' as const,attentionItem:null,edge:{key:'r',kind:'receive-result' as const,project,runId:'run',outcome,workRemains:false}}};
  expect(directorBodyAction(result,null,true,()=>true)).toBe(expected);
  expect(directorBodyAction({...result,health:'unknown'},null,true,()=>true)).toBe('director-supervise');
 }
});

it('keeps known failure attention, unknown effects, and permission semantically distinct', () => {
 for (const [kind, expected] of [['run_failed','failure'],['preparation_failed','failure'],['mcp_error','failure'],['effect_unknown','unknown-effect-check'],['permission','director-notify-attention']] as const) {
  const notice={...view,interactionRoute:'agent-companion' as const,body:{...view.body,verb:'notify-attention' as const,attentionItem:{key:'notice',threadId:project.threadId,branchId:project.branchId,runId:'run',kind,actionable:true,revision:1}}};
  expect(directorBodyAction(notice,null,true,()=>true)).toBe(expected);
  expect(directorBodyAction(notice,null,true,()=>false)).toBe('director-notify-attention');
 }
});
