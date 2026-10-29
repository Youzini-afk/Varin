import { describe, expect, it } from 'vitest';
import { companionLocalIdle, directorLocalResponse } from './directorLocalInteraction';
const base = { event: 'tap' as const, current: true, visible: true, interacting: false, blockedUI: false, finiteHandover: false, closed: false };
describe('director local attention', () => {
  it('allows gentle attention without treating pending requests as approval', () => {
    expect(directorLocalResponse(base)).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, closed: true })).toBe('tap-response');
    expect(directorLocalResponse({ ...base, event: 'hover' })).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, event: 'hover', closed: true })).toBe('hover-response');
  });
  it('does not interrupt or queue a finite handover, hidden/dragging, or unknown state', () => {
    for (const override of [{ finiteHandover: true }, { visible: false }, { interacting: true }, { current: false }, { blockedUI: true }]) {
      expect(directorLocalResponse({ ...base, ...override })).toBeNull();
    }
  });
});

it('allows at most an idle safe-endpoint repeat variation, never a missing-art fallback replay', () => {
  const repeat = { ...base, event: 'tap-repeat' as const, idle: true, safeOpenEndpoint: true, playfulAvailable: true };
  expect(directorLocalResponse(repeat)).toBe('tap-repeat-response');
  expect(directorLocalResponse({...repeat,closed:true,safeOpenEndpoint:false,closedPlayfulAvailable:true})).toBe('tap-repeat-response');
  for (const override of [{idle:false},{responsePlaying:true},{safeOpenEndpoint:false},{playfulAvailable:false},{closed:true},{finiteHandover:true}]) expect(directorLocalResponse({...repeat,...override})).toBeNull();
  expect(directorLocalResponse({...base,responsePlaying:true})).toBeNull();
  expect(directorLocalResponse({...base,event:'hover',safeOpenEndpoint:true,openHoverAvailable:true})).toBe('open-hover-response');
  expect(directorLocalResponse({...base,event:'hover',safeOpenEndpoint:true})).toBe('director-open-attention');
});

import { createDirectorReviewFixtureSession } from './directorReviewFixtures';
it('uses fixture busy/pending/unknown facts rather than borrowing an empty live Host idle state', () => {
 const session=createDirectorReviewFixtureSession();
 const empty={...session.view().attention,branches:[],items:[],counts:{actionRequired:0,affectedBranches:0,unknownEffects:0}};
 expect(companionLocalIdle(empty,'current')).toBe(true);
 for(const step of ['portfolio','requests','unknown'] as const){session.step(step);const value=session.view();expect(companionLocalIdle(value.attention,value.presentation.health)).toBe(false);}
 expect(companionLocalIdle(empty,'unknown')).toBe(false);
});
