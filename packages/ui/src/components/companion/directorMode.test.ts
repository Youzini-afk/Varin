import { expect, it } from 'vitest';
import { companionDirectorMode, hasAcceptedDirectorAssets } from './directorMode';
import type { CompanionPackage } from './sequencePackage';
const actions = ['director-supervise','director-listen-left','director-listen-right','director-gather-present','director-intake','director-open-attention','idle-closed'];
const bundle = actions.map(action => ({ id: action, action, reviewStatus:'accepted', stage:'motion-candidate', geometryReference:'varin-upright-v2', entryPose:'A',exitPose:'A', frames:[{}] } as CompanionPackage));
it('uses selected accepted management assets in normal mode without candidate admission', () => {
  expect(companionDirectorMode(bundle,false,false)).toBe(true);
  expect(hasAcceptedDirectorAssets(bundle.map(asset=>({...asset,reviewStatus:'candidate'})))).toBe(false);
  expect(hasAcceptedDirectorAssets(bundle.slice(0,-1))).toBe(false);
  expect(companionDirectorMode([],false,true)).toBe(false);
});
it('keeps legacy and manual development review separate from explicit candidate review', () => {
  expect(companionDirectorMode([],false,false)).toBe(false);
  expect(companionDirectorMode(bundle,true,false)).toBe(false);
  expect(companionDirectorMode([],true,true)).toBe(true);
});

it('does not require obsolete spatial inspection art to keep the role-safe director route', () => {
  expect(hasAcceptedDirectorAssets(bundle.filter(asset => !asset.action?.startsWith('director-listen-')))).toBe(true);
});
