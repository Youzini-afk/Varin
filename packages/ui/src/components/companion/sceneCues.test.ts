import { describe, expect, it } from 'vitest';
import { sceneCue, cueMatchesScene, directorCueMatchesPresentation } from './sceneCues';
describe('authored scene cues', () => {
  it('does not lend an old displayed action to a newly requested scene while images load', () => {
    expect(cueMatchesScene('reading', 'editing')).toBe(false);
    expect(cueMatchesScene('reading', 'reading')).toBe(true);
    expect(cueMatchesScene('permission', undefined)).toBe(false);
    expect(cueMatchesScene(null, 'reading')).toBe(false);
  });
  it('separates preparation and return from the actual activity', () => {
    expect(['PAGE_TURN_PREPARE','PAGE_TURN','PAGE_TURN_RELEASE'].map(value => sceneCue(value))).toEqual(['transition','page-turn','transition']);
    expect(['TYPE_PREPARE','TYPE_BURST','TYPE_ALTERNATE','TYPE_STOP'].map(value => sceneCue(value))).toEqual(['transition','type','type','transition']);
  });
  it('keeps legacy listening directions separate from generic management and project work', () => {
    expect(sceneCue('LISTEN', 'director-listen-left')).toBe('listen-left');
    expect(sceneCue('LISTEN', 'director-listen-right')).toBe('listen-right');
    expect(sceneCue('LISTEN', 'director-listen')).toBe('transition');
    expect(sceneCue('GATHER_IN', 'director-gather-present')).toBe('gather-in');
    expect(sceneCue('ALLOW_RECEIVED', 'director-gather-present')).toBe('transition');
    expect(cueMatchesScene('portfolio', 'reading')).toBe(false);
  });
  it('keeps pending attention and observation distinct from responses and dispatch', () => {
    expect(['SCAN_SIDE_A','GAZE_A','DISPATCH_A','DISPATCH_B'].map(value => sceneCue(value))).toEqual(['scan-left','scan-right','dispatch-right','dispatch-left']);
    expect(['OFFER','UNRESOLVED','ALLOW_RECEIVED'].map(value => sceneCue(value))).toEqual(['offer','attend','acknowledge']);
    expect(['DISPATCH_A','WATCH','RETURN_LOWER','unrecognized'].map(value => sceneCue(value))).toEqual(['dispatch-right','watch','transition','transition']);
  });
});

it('maps inward acceptance and independent presentation without claiming physical receipt', () => {
 expect(sceneCue('RECEIVE_PROJECT','director-intake')).toBe('management-receive');
 expect(sceneCue('HANDOFF_LEAD','director-intake')).toBe('management-delegate');
 expect(sceneCue('PRESENT','director-gather-present')).toBe('management-present');
 expect(sceneCue('ACCEPT_INWARD','director-intake')).toBe('management-receive');
 expect(sceneCue('ACCEPT_SETTLE','director-intake')).toBe('management-delegate');
 expect(sceneCue('PRESENT_CLEAR','director-gather-present')).toBe('address-user');
 expect(sceneCue('PRESENT_CLEAR','director-notify-attention')).toBe('transition');
});

it('uses the drawn subject and acknowledged native listening side, not the requested package',()=>{
 const b={action:'director-gather-present',cue:'gather-in' as const,context:'B'};
 expect(directorCueMatchesPresentation(b,'C','right')).toBe(false);
 expect(directorCueMatchesPresentation(b,'B','right')).toBe(true);
 const listening={action:'director-listen-right',cue:'listen-right' as const,context:'B'};
 expect(directorCueMatchesPresentation(listening,'B',null)).toBe(false);
 expect(directorCueMatchesPresentation(listening,'B','left')).toBe(false);
 expect(directorCueMatchesPresentation(listening,'B','right')).toBe(true);
});
