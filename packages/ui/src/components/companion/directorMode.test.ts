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

import { readCompanionEndpoints } from './sequencePackage';
it('admits an explicitly verified independent geometry only with the required accepted actions',()=>{
  const open='a'.repeat(64),closed='b'.repeat(64);
  const assets=bundle.map(asset=>{const isClosed=asset.action==='idle-closed',pose=isClosed?'closed-canonical':'open-canonical';return {...asset,geometryReference:'independent-drawings',entryPose:pose,exitPose:pose,frames:[{...asset.frames[0]!,pose,sha256:isClosed?closed:open}]};});
  const endpoints=readCompanionEndpoints({geometryReference:'independent-drawings',open:{pose:'open-canonical',sourceSha256:open},closed:{pose:'closed-canonical',sourceSha256:closed},closedSourceSha256:[closed]},assets);
  expect(hasAcceptedDirectorAssets(assets)).toBe(false);
  expect(hasAcceptedDirectorAssets(assets,endpoints)).toBe(true);
  expect(hasAcceptedDirectorAssets(assets.map(asset=>({...asset,reviewStatus:'candidate'})),endpoints)).toBe(false);
  expect(hasAcceptedDirectorAssets(assets.filter(asset=>asset.action!=='director-supervise'),endpoints)).toBe(false);
});

it('allows explicit selected-assets developer review only through accepted asset capability, never candidate admission', () => {
  expect(companionDirectorMode(bundle, true, false, null, true)).toBe(true);
  expect(companionDirectorMode([], true, false, null, true)).toBe(false);
  expect(companionDirectorMode(bundle.map(asset => ({ ...asset, reviewStatus: 'candidate' })), true, false, null, true)).toBe(false);
  expect(companionDirectorMode(bundle.slice(0, -1), true, false, null, true)).toBe(false);
  expect(companionDirectorMode([], false, false, null, true)).toBe(false);
});
