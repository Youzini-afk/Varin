import { describe, expect, test } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { visibleSceneViewport } from './sceneViewport';
import { CompanionSceneFacts } from './sceneFacts';
const snapshot = (operations: unknown[], childActivity = {}) => ({ operations, childActivity, activeRun: null } as unknown as ThreadSnapshot);
const tool = (name: string, id = name) => ({ id, phase: 'running', intent: { kind: 'tool', call: { name, schema_version: '1' }, contract: { name, schema_version: '1' } } });
describe('companion decorative facts', () => {
  test('distinguishes all six real scene families and retains one short-event withdrawal', () => {
    const facts = new CompanionSceneFacts();
    for (const [name, kind] of [['file_read','reading'],['file_edit','editing'],['websearch','searching'],['code_retrieval','dispatch']] as const)
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
