import { describe, expect, it } from 'vitest';
import { CompanionProgressFacts, withCompanionProgress } from './progressPresentation';
describe('companion provider activity', () => {
  it('uses new scoped growth, not initial/replayed cumulative text, and expires without completing work', () => {
    const facts = new CompanionProgressFacts();
    expect(facts.observe([{ type: 'text', id: 'a', text: 'old' }], { runId: 'run' }, 100)).toBeNull();
    const progress = facts.observe([{ type: 'text', id: 'a', text: 'old new' }], { runId: 'run' }, 200);
    expect(withCompanionProgress({ state: 'C04', reason: '' }, progress, 'current', { id: 'run', state: 'generating' }, 201).state).toBe('C05');
    expect(facts.observe([{ type: 'text', id: 'a', text: 'old new' }], { runId: 'run' }, 2000)).toBeNull();
    facts.reset();
    expect(facts.observe([{ type: 'text', id: 'a', text: 'old new' }], { runId: 'run' }, 2200)).toBeNull();
    facts.reset();
    expect(facts.observe([{type:'text',id:'one',text:'short'}],{runId:'new',activity:'text'},2300)?.kind).toBe('output');
  });
  it('rejects stale run/health and never overrides a tool or unresolved question', () => {
    const p = { runId: 'old', kind: 'output' as const, until: 1000 };
    const base = { state: 'C04', reason: 'generating' };
    expect(withCompanionProgress(base, p, 'current', { id: 'new', state: 'generating' }, 20)).toBe(base);
    expect(withCompanionProgress(base, p, 'unknown', { id: 'old', state: 'generating' }, 20)).toBe(base);
    for (const state of ['T01', 'W02', 'W03', 'E02', 'C06']) expect(withCompanionProgress({ state, reason: '' }, p, 'current', { id: 'old', state: 'generating' }, 20).state).toBe(state);
  });
  it('shows real retry delay, ignores invalid dates and does not resurrect it after new progress', () => {
    const facts = new CompanionProgressFacts(), retry = { type: 'retry' as const, attempt: 2, retryAt: 900 };
    const p = facts.observe([retry], { runId: 'r' }, 100);
    expect(withCompanionProgress({ state: 'C04', reason: '' }, p, 'current', { id: 'r', state: 'generating' }, 200).state).toBe('W05');
    expect(facts.observe([{ type: 'text', id: 'x', text: 'x' }, retry], { runId: 'r' }, 300)?.kind).toBe('output');
    expect(facts.observe([{ type: 'text', id: 'x', text: 'x' }, retry], { runId: 'r' }, 2000)).toBeNull();
    facts.reset();
    expect(facts.observe([{ ...retry, retryAt: Infinity }], { runId: 'r' }, 1)).toBeNull();
  });
});

it('honors the actual last batch event and clears backoff on a real new provider event/request', () => {
 const facts=new CompanionProgressFacts(); const text={type:'text' as const,id:'x',text:'one'};const retry={type:'retry' as const,attempt:1,retryAt:1000};
 expect(facts.observe([text,retry],{runId:'r',requestId:'q',activity:'retry'},100)?.kind).toBe('retry');
 expect(facts.observe([{...text,text:'one two'},retry],{runId:'r',requestId:'q',activity:'text'},200)?.kind).toBe('output');
 expect(facts.observe([{...text,text:'one two'},retry],{runId:'r',requestId:'q'},300)?.until).toBe(1600);
 facts.observe([text,retry],{runId:'r',requestId:'q',activity:'retry'},400);
 expect(facts.observe([text,retry],{runId:'r',requestId:'q',activity:'provider'},500)).toBeNull();
 expect(facts.observe([text],{runId:'r',requestId:'next'},600)).toBeNull();
});
