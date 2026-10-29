import {describe,it,expect} from 'vitest';
import {resolveCompanionSpatialLayout} from '../../../../application-client/src/companion-spatial-layout';
import {portfolioArtwork} from './portfolioArtwork';
import {agentAvatarSvg} from '../ui/agent-avatar-art';
import {spatialArtwork} from './spatialArtwork';
import type {DesktopCompanionScene} from '@varin/application-client';
const d={kind:'portfolio',phase:'active',reducedMotion:true,portfolio:{mode:'inspection',inspectedKey:'a',subjectKey:null,overflowCards:0,projects:[{key:'a',label:'A',caption:'<unsafe>',lead:{avatar:'ribbon-blue',role:'project-lead'},status:'active',requestCount:0,uncertainCount:0},{key:'b',label:'B',lead:{avatar:'scoop-pistachio',role:'project-lead'},status:'unknown',requestCount:null,uncertainCount:null}],teams:[{projectKey:'a',members:[{key:'child',avatar:'lens-lilac',state:'running'}],overflowCount:0}]}} as DesktopCompanionScene;
describe('B spatial presentation',()=>{
 it('keeps stable sectors and full decorated bounds inside protected floors/edges',()=>{
  for(const available of [{left:5,top:-15,right:295,bottom:285},{left:5,top:-15,right:295,bottom:225},{left:50,top:-15,right:295,bottom:225},{left:5,top:-15,right:250,bottom:225}]){
   const l=resolveCompanionSpatialLayout({available});expect(l.seats.map(s=>s.label)).toEqual(['A','B','C']);expect(l.seats[1]!.home.x).toBeLessThan(150);expect(l.seats[2]!.home.x).toBeGreaterThan(150);
   expect(l.bounds.left).toBeGreaterThanOrEqual(available.left);expect(l.bounds.right).toBeLessThanOrEqual(available.right);expect(l.bounds.bottom).toBeLessThanOrEqual(available.bottom);
  }
 });
 it('separates rear portraits, keeps caption escaped, and binds children only to their real owner',()=>{
  const a=spatialArtwork(d,resolveCompanionSpatialLayout(),'right',1000,0,null);expect(a.behind).toContain('data-spatial-squad="A"');expect(a.front).toContain('&lt;unsafe&gt;');expect(a.behind).toContain('data-child-owner="A"');expect(a.front).not.toContain('data-child-owner="B"');
  const cleared=spatialArtwork({...d,portfolio:{...d.portfolio!,teams:[]}},resolveCompanionSpatialLayout(),'right',1000,0,null);expect(cleared.behind).not.toContain('data-child-owner');
 });
});

it('plain task retains its saved avatar without inventing captain clothing or child membership in either stage',()=>{
 const plain:DesktopCompanionScene={...d,cue:'transition',portfolio:{...d.portfolio!,projects:[{...d.portfolio!.projects[0]!,lead:{avatar:'ribbon-blue',role:'task'}}],teams:[]}};
 const spatial=spatialArtwork(plain,resolveCompanionSpatialLayout(),'right',1000,0,null);
 const original=agentAvatarSvg('ribbon-blue').replace('<svg ','<svg width="40" height="40" ');
 for(const output of [spatial.behind+spatial.front,portfolioArtwork(plain,'right',1000,0,new Map())]){
  expect(output).toContain(original);
  expect(output).not.toContain('-cloth');
  expect(output).not.toContain('data-child-owner');
  expect(output).not.toContain('data-summary-project');
 }
});
