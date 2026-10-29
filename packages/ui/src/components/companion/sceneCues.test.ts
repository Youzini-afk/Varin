import { describe, expect, it } from 'vitest';
import { sceneCue, cueMatchesScene } from './sceneCues';
describe('authored scene cues', () => {
  it('does not lend an old displayed action to a newly requested scene while images load', () => {
    expect(cueMatchesScene('reading', 'editing')).toBe(false);
    expect(cueMatchesScene('reading', 'reading')).toBe(true);
    expect(cueMatchesScene('permission', undefined)).toBe(false);
    expect(cueMatchesScene(null, 'reading')).toBe(false);
  });
  it('separates preparation and return from the actual activity', () => {
    expect(['PAGE_TURN_PREPARE','PAGE_TURN','PAGE_TURN_RELEASE'].map(sceneCue)).toEqual(['transition','page-turn','transition']);
    expect(['TYPE_PREPARE','TYPE_BURST','TYPE_ALTERNATE','TYPE_STOP'].map(sceneCue)).toEqual(['transition','type','type','transition']);
  });
  it('keeps pending attention and observation distinct from responses and dispatch', () => {
    expect(['SCAN_SIDE_A','GAZE_A','DISPATCH_A','DISPATCH_B'].map(sceneCue)).toEqual(['scan-left','scan-right','dispatch-right','dispatch-left']);
    expect(['OFFER','UNRESOLVED','ALLOW_RECEIVED'].map(sceneCue)).toEqual(['offer','attend','acknowledge']);
    expect(['DISPATCH_A','WATCH','RETURN_LOWER','unrecognized'].map(sceneCue)).toEqual(['dispatch-right','watch','transition','transition']);
  });
});
