import { describe, expect, test } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { visibleSceneViewport } from './sceneViewport';
import { CompanionSceneFacts, sceneForIntent } from './sceneFacts';
const snapshot = (operations: unknown[], childActivity = {}) => ({ operations, childActivity, activeRun: null } as unknown as ThreadSnapshot);
const tool = (name: string, id = name) => ({ id, phase: 'running', intent: { kind: 'tool', call: { name, schema_version: '1' }, contract: { name, schema_version: '1' } } });
describe('companion decorative facts', () => {
  test('distinguishes all six real scene families and retains one short-event withdrawal', () => {
    const facts = new CompanionSceneFacts();
    for (const [name, kind] of [['file_read','reading'],['file_edit','editing'],['websearch','searching'],['code_retrieval','dispatch'],['materials','organize'],['office_render','verify']] as const)
      expect(facts.observe(snapshot([tool(name)]), 'current').kind).toBe(kind);
    expect(facts.observe(snapshot([{ id:'question', executor:'ask_user', phase:'waiting' }]), 'current').kind).toBe('question');
    const p={ id:'p',decision:null,call:{},scope:{} };
    expect(facts.observe(snapshot([{ id:'op',phase:'waiting',result:{kind:'control',value:{permission:p}} }]), 'current').kind).toBe('permission');
    expect(facts.observe(snapshot([tool('file_read')]), 'current').kind).toBe('reading');
    const tail=facts.observe(snapshot([]),'current');
    expect(tail).toMatchObject({kind:'reading',phase:'withdraw',outcome:null});
    expect(facts.observe(snapshot([]),'current')).toBe(tail);
    expect(facts.observe(snapshot([tool('file_edit')]),'current')).toMatchObject({kind:'editing',phase:'active'});
    expect(facts.observe(snapshot([]),'unknown').kind).toBeNull();
  });
  test('only explicit decisions or answer receipts resolve; disappearance and initial history do not', () => {
    const facts=new CompanionSceneFacts();
    const op=(decision:unknown)=>({id:'op',phase:decision===null?'waiting':'terminal',result:{kind:'control',value:{permission:{id:'p',decision,call:{},scope:{}}}}});
    expect(facts.observe(snapshot([op('allow_once')]),'current').kind).toBeNull();
    facts.observe(snapshot([op(null)]),'current');
    expect(facts.observe(snapshot([op('allow_once')]),'current')).toMatchObject({kind:'permission',phase:'resolve',outcome:'allowed'});
    facts.observe(snapshot([op(null)]),'current');
    expect(facts.observe(snapshot([]),'current')).toMatchObject({phase:'withdraw',outcome:null});
    facts.observe(snapshot([op(null)]),'current');
    expect(facts.observe(snapshot([op('deny')]),'current').outcome).toBe('denied');
    facts.observe(snapshot([{id:'q',executor:'ask_user',phase:'waiting'}]),'current');
    expect(facts.observe(snapshot([{id:'q',executor:'ask_user',phase:'terminal',outcome:'succeeded',result:{kind:'control',value:{answer_ref:'a'}}}]),'current').outcome).toBe('answered');
    facts.reset();
    expect(facts.observe(snapshot([]),'current').kind).toBeNull();
  });
  test('does not turn missing identities or mixed permission decisions into an allowance', () => {
    const facts=new CompanionSceneFacts();
    const op=(id:string, decision:unknown)=>({id,phase:decision===null?'waiting':'terminal',result:{kind:'control',value:{permission:{id:`permission-${id}`,decision,call:{},scope:{}}}}});
    facts.observe(snapshot([op('known',null)]),'current');
    expect(facts.observe(snapshot([{id:'never-shown',phase:'terminal',result:{kind:'control',value:{permission:{decision:'allow_once'}}}}]),'current'))
      .toMatchObject({phase:'withdraw',outcome:null});
    facts.observe(snapshot([op('a',null),op('b',null)]),'current');
    expect(facts.observe(snapshot([op('a','deny'),op('b','allow_once')]),'current'))
      .toMatchObject({phase:'withdraw',outcome:null});
    facts.reset();
    expect(facts.observe(snapshot([{...op('bad',null),phase:'running'}]),'current').kind).toBeNull();
  });

  test('exposes only the current identity-matched receipt after newer-scene precedence', () => {
    const facts = new CompanionSceneFacts();
    const permission = (decision: string | null, id = 'permission-1') => ({ id: 'op', phase: decision === null ? 'waiting' : 'terminal', result: { kind: 'control', value: { permission: { id, decision, call: {}, scope: {} } } } });
    const question = { id: 'question', executor: 'ask_user', phase: 'waiting' };
    facts.observe(snapshot([permission('allow_once')]), 'current');
    expect(facts.matchedReceipt).toBeNull(); // Initial history is not a live edge.
    facts.observe(snapshot([permission(null)]), 'current');
    facts.observe(snapshot([permission('allow_once', 'different-permission')]), 'current');
    expect(facts.matchedReceipt).toBeNull();
    facts.observe(snapshot([permission(null)]), 'current');
    facts.observe(snapshot([]), 'current');
    expect(facts.matchedReceipt).toBeNull(); // Disappearance proves no decision.
    facts.observe(snapshot([permission(null)]), 'current');
    facts.observe(snapshot([permission('allow_once'), question]), 'current');
    expect(facts.matchedReceipt).toBeNull(); // A newer pending request wins.
    facts.observe(snapshot([{ ...question, phase: 'terminal', outcome: 'succeeded', result: { kind: 'control', value: { answer_ref: 'answer-1' } } }]), 'current');
    expect(facts.matchedReceipt).toEqual({ kind: 'question', operationId: 'question', outcome: 'answered' });
    facts.observe(snapshot([]), 'current');
    expect(facts.matchedReceipt).toBeNull(); // Even if the decorative resolve tail persists.
    for (const [decision, outcome] of [['allow_once', 'allowed'], ['deny', 'denied']] as const) {
      facts.observe(snapshot([permission(null)]), 'current');
      const scene = facts.observe(snapshot([permission(decision)]), 'current');
      expect(facts.matchedReceipt).toEqual({ kind: 'permission', operationId: 'op', permissionId: 'permission-1', outcome });
      expect(scene).toEqual({ kind: 'permission', phase: 'resolve', outcome, count: null });
      facts.reset();
      expect(facts.matchedReceipt).toBeNull();
    }
    facts.observe(snapshot([permission(null)]), 'current');
    facts.observe(snapshot([permission('allow_once')]), 'unknown');
    expect(facts.matchedReceipt).toBeNull();
  });

  test('parallel known work stays readable, child counts stay factual, spoofed tool names stay unclassified', () => {
    const facts=new CompanionSceneFacts();
    expect(facts.observe(snapshot([tool('file_edit'),tool('websearch')],{child:{state:'running'}}),'current')).toMatchObject({kind:'editing',count:1});
    expect(facts.observe(snapshot([],{child:{state:'waiting'},failed:{state:'preparation_failed'}}),'current')).toMatchObject({kind:'dispatch',count:1});
    facts.reset();
    const spoof=tool('file_read');spoof.intent.contract.name='other';
    expect(facts.observe(snapshot([spoof]),'current').kind).toBeNull();
  });
});

test('suppresses the last legal scene while scrolling and restores only a fully visible canvas', () => {
  const rect = { x:0, y:40, width:360, height:360 };
  const first = visibleSceneViewport(rect,360,480,null);
  expect(first.visible).toBe(true);
  const scrolled = visibleSceneViewport({...rect,y:-60},360,480,first.viewport);
  expect(scrolled).toEqual({viewport:first.viewport,visible:false});
  expect(visibleSceneViewport({...rect,y:-60},360,480,null)).toEqual({viewport:null,visible:false});
  expect(visibleSceneViewport(rect,360,300,first.viewport).visible).toBe(false);
  expect(visibleSceneViewport({...rect,y:20},360,480,first.viewport)).toMatchObject({visible:true,viewport:{y:20}});
});

test('current uncertainty replaces old work but never impersonates a permission receipt', () => {
 const prior = { kind: 'editing' as const, phase: 'active' as const, outcome: null, count: null };
 expect(sceneForIntent(prior, 'E04')).toMatchObject({kind:'status',status:'disconnected',outcome:null});
 const permission = {kind:'permission' as const,phase:'active' as const,outcome:null,count:null};
 expect(sceneForIntent(permission,'W02')).toBe(permission);
 expect(sceneForIntent(prior,'W05')).toMatchObject({kind:'status',status:'retry',outcome:null});
});
