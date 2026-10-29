import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadAttentionSnapshot } from '@varin/application-client';
import { companionAttentionEn } from '@/lib/i18n/messages/companion-attention';
import { CompanionAttentionPanel, CompanionAttentionSummary } from './CompanionAttentionPanel';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof companionAttentionEn, params: Record<string, string | number> = {}) =>
  (companionAttentionEn[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name])) }) }));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });
function environment() {
  const { window } = parseHTML('<html><body><button id="opener">Open</button><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!); cleanup = () => act(() => root.unmount());
  return root;
}
const facts: ThreadAttentionSnapshot = { teamExecutions:[], epoch:1,eventCursor:9,coverage:{scope:'host',native:'complete',external:'unsupported'},counts:{actionRequired:2,affectedBranches:2,unknownEffects:0},
 branches:['A','B'].map(threadId=>({threadId,branchId:`branch-${threadId}`,title:`Task ${threadId}`,parentThreadId:null,archived:false,deleted:false,activeRunId:'run',currentRun:null,latestRun:null,hasUnsettledWork:true})),
 items:[{key:'permission-B',threadId:'B',branchId:'branch-B',runId:'run',operationId:'op-B',permissionId:'permit-B',revision:1,kind:'permission',actionable:true},{key:'question-A',threadId:'A',branchId:'branch-A',runId:'run',operationId:'op-A',revision:1,kind:'question',actionable:true}] };
it('keeps both task-bound requests, distinguishes inspecting from following, and Escape closes', () => {
 const root=environment(), open=vi.fn(), follow=vi.fn(), close=vi.fn();
 act(()=>root.render(<CompanionAttentionPanel attention={{snapshot:facts,health:'current',refreshing:false,observationRevision:0}} identity={{runtime:'agent',threadId:'A',branchId:'branch-A'}} focusTitle="Task A" onOpenThread={open} onFocus={follow} onClose={close} onRefresh={()=>{}}/>));
 expect(document.body.textContent).toContain('Permission required'); expect(document.body.textContent).toContain('Answer required');
 const buttons=[...document.querySelectorAll('button')];
 act(()=>buttons.find(button=>button.textContent==='Open task to inspect')!.click());
 expect(open).toHaveBeenCalledWith({runtime:'agent',threadId:'B',branchId:'branch-B'});expect(follow).not.toHaveBeenCalled();
 expect(document.body.textContent).toContain('Viewed · not resolved');expect(document.body.textContent).toContain('2 requests');
 act(()=>buttons.find(button=>button.textContent==='Follow this task')!.click());
 expect(follow).toHaveBeenCalledWith({runtime:'agent',threadId:'B',branchId:'branch-B'});
 const event=new window.Event('keydown',{bubbles:true});Object.defineProperty(event,'key',{value:'Escape'});
 act(()=>document.querySelector('[role="region"]')!.dispatchEvent(event));expect(close).toHaveBeenCalledTimes(1);
});
it('does not announce last-known counts as current or let another task rename the focus', () => {
 const root=environment();
 act(()=>root.render(<CompanionAttentionSummary attention={{snapshot:facts,health:'unknown',refreshing:false,observationRevision:0}} focusTitle="Task A" focused focusStatus="Reading" onInspect={()=>{}}/>));
 expect(document.body.textContent).toContain('Following: Task A · fixed');
 expect(document.body.textContent).toContain('Last known facts');expect(document.body.textContent).not.toContain('2 requests');
});
it('bounds rendered requests with accessible paging instead of truncating the task set', () => {
 const root=environment(); const many={...facts,items:Array.from({length:45},(_,i)=>({...facts.items[0]!,key:`item-${i}`})),counts:{...facts.counts,actionRequired:45}};
 act(()=>root.render(<CompanionAttentionPanel attention={{snapshot:many,health:'current',refreshing:false,observationRevision:0}} identity={null} onOpenThread={()=>{}} onFocus={()=>{}} onClose={()=>{}} onRefresh={()=>{}}/>));
 const requestGroup=document.querySelector('[aria-label="Needs you"]')!;
 expect(requestGroup.querySelectorAll('li')).toHaveLength(20);
 act(()=>[...requestGroup.querySelectorAll('button')].find(button=>button.textContent==='Next')!.click());
 expect(requestGroup.textContent).toContain('2 / 3');
 act(()=>[...requestGroup.querySelectorAll('button')].find(button=>button.textContent==='Next')!.click());
 expect(requestGroup.querySelectorAll('li')).toHaveLength(5);
});
