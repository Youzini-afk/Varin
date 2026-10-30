import {resolveCompanionSpatialLayout} from '../../../../application-client/src/companion-spatial-layout';
import {escapePortfolioText,portfolioCaption,managementDossierDock,managementDossierPose,squadWorkTiming,squadHome} from './portfolioArtwork';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AGENT_AVATAR_ART } from '../ui/agent-avatar-art';
import { mountCompanionScene, type SceneUpdate } from './sceneRenderer';

let now=0, serial=0, jobs=new Map<number,FrameRequestCallback>();
let root:HTMLElement;
const layout={character:{x:.17,y:.08,width:.67,height:.8375},visible:{x:0,y:0,width:1,height:1}};
const scene=(kind:SceneUpdate['descriptor']['kind'], extra:Partial<SceneUpdate['descriptor']>={}):SceneUpdate=>({layout,descriptor:{revision:1,scope:'thread:branch',kind,phase:'active',outcome:null,count:null,suppressed:false,reducedMotion:false,menuOpen:false,cue:'transition',...extra}});
const tick=(ms:number)=>{now=ms;const callbacks=[...jobs.values()];jobs.clear();callbacks.forEach(f=>f(ms));};
beforeEach(()=>{
 now=0;serial=0;jobs=new Map();
 vi.stubGlobal('performance',{now:()=>now});vi.stubGlobal('window',new EventTarget());
 vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false,documentElement:{dataset:{}}}));
 vi.stubGlobal('requestAnimationFrame',(f:FrameRequestCallback)=>{jobs.set(++serial,f);return serial;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>jobs.delete(id));
 // A real DOM root: the renderer keeps stable nodes and rewrites only changed layers.
 root=parseHTML('<html><body><div id="scene"></div></body></html>').document.getElementById('scene') as unknown as HTMLElement;
 Object.defineProperties(root,{clientWidth:{value:500},clientHeight:{value:400}});
});
afterEach(()=>vi.unstubAllGlobals());
describe('atelier scene renderer',()=>{
 it.each(['reading','editing','searching','dispatch','question','permission','organize','verify','status'] as const)('%s settles without a perpetual animation loop',kind=>{
  const s=mountCompanionScene(root);s.update(scene(kind,{status:kind==='status'?'queued':undefined}));tick(600);
  expect(root.innerHTML).toContain('<svg');expect(jobs.size).toBe(0);s.dispose();
 });
 it('a new authored cue gets one finite accent and reduced motion immediately settles',()=>{
  const s=mountCompanionScene(root);s.update(scene('reading',{cue:'read'}));tick(600);expect(jobs.size).toBe(0);
  s.update(scene('reading',{revision:2,cue:'page-turn',cueInstance:2}));tick(700);expect(jobs.size).toBe(1);tick(1200);expect(jobs.size).toBe(0);
  s.update(scene('reading',{revision:3,reducedMotion:true}));tick(1300);expect(jobs.size).toBe(0);s.dispose();
 });
 it('unresolved permission never opens merely because time passes',()=>{
  const s=mountCompanionScene(root);s.update(scene('permission'));tick(600);const unresolved=root.innerHTML;
  s.update(scene('permission',{revision:2,cue:'attend'}));tick(18000);expect(root.innerHTML).toBe(unresolved);
  s.update(scene('permission',{revision:3,phase:'resolve',outcome:'allowed'}));tick(18100);expect(root.innerHTML).not.toBe(unresolved);tick(19000);expect(root.innerHTML).toBe('');s.dispose();
 });
 it('keeps existing avatar identities through tool changes and retires only the leaving member',()=>{
  const s=mountCompanionScene(root), member={key:'child-a',avatar:'ribbon-blue' as const,state:'running' as const};
  s.update(scene('dispatch',{team:{members:[member],overflowCount:0}}));tick(700);expect(jobs.size).toBe(0);
  const avatarPath=AGENT_AVATAR_ART['ribbon-blue'].body;expect(root.innerHTML).toContain(avatarPath);
  s.update(scene('reading',{revision:2,team:{members:[member],overflowCount:0}}));tick(800);expect(root.innerHTML.split(avatarPath)).toHaveLength(2);tick(1400);expect(root.innerHTML).toContain(avatarPath);
  Object.assign(document,{hidden:true});document.dispatchEvent(new Event('visibilitychange'));
  Object.assign(document,{hidden:false});document.dispatchEvent(new Event('visibilitychange'));
  s.update(scene('reading',{revision:3,team:{members:[member],overflowCount:0}}));tick(1450);
  expect(root.innerHTML).toContain(avatarPath);
  s.update(scene('reading',{revision:4,team:{members:[{...member,state:'leaving'}],overflowCount:0}}));tick(1500);expect(jobs.size).toBe(1);tick(2100);expect(jobs.size).toBe(0);
  s.dispose();
 });
 it('missing identities retire neutrally for 500ms without retaining stale work',()=>{
  const s=mountCompanionScene(root), member={key:'child-a',avatar:'ribbon-blue' as const,state:'running' as const};
  s.update(scene('dispatch',{team:{members:[member],overflowCount:0}}));tick(700);
  s.update(scene('dispatch',{revision:2,team:{members:[],overflowCount:0}}));tick(800);
  expect(root.innerHTML).toContain(AGENT_AVATAR_ART['ribbon-blue'].body);
  tick(1400);expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['ribbon-blue'].body);expect(jobs.size).toBe(0);s.dispose();
 });
 it('team-only and primary withdrawal cannot expire an ongoing team',()=>{
  const s=mountCompanionScene(root), team={members:[{key:'a',avatar:'ribbon-blue' as const,state:'running' as const}],overflowCount:0};
  s.update(scene('reading',{team}));tick(700);
  s.update(scene('reading',{revision:2,phase:'withdraw',team}));tick(1500);
  expect(root.innerHTML).toContain(AGENT_AVATAR_ART['ribbon-blue'].body);expect(jobs.size).toBe(0);
  s.update(scene(null,{revision:3,phase:'withdraw',team}));tick(2300);
  expect(root.innerHTML).toContain(AGENT_AVATAR_ART['ribbon-blue'].body);expect(jobs.size).toBe(0);s.dispose();
 });
 it('suppression removes artwork and pending frames; stale revisions cannot restore it',()=>{
  const s=mountCompanionScene(root);s.update(scene('question'));tick(100);
  s.update(scene('question',{revision:3,suppressed:true}));tick(150);expect(root.innerHTML).toBe('');expect(jobs.size).toBe(0);
  s.update(scene('question',{revision:2}));expect(jobs.size).toBe(0);s.dispose();
 });
});

describe('review-only director portfolio',()=>{
 const portfolio={mode:'inspection' as const,projects:[{key:'opaque-a',label:'A' as const,lead:{avatar:'ribbon-blue' as const,role:'project-lead' as const},status:'active' as const,requestCount:0,uncertainCount:0,detail:'reading' as const}],inspectedKey:'opaque-a',subjectKey:null,overflowCards:2,teams:[{projectKey:'opaque-a',members:[{key:'child',avatar:'scoop-pistachio' as const,state:'running' as const}],overflowCount:1}]};
 it.each(['left','right'] as const)('uses native %s inspection side, real identities and exact overflow',side=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio});v.layout={...layout,inspectionSide:side};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-project-slot="A"');expect(root.innerHTML).toContain(AGENT_AVATAR_ART['ribbon-blue'].body);expect(root.innerHTML).toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);expect(root.innerHTML).toContain('+2');expect(root.innerHTML).toContain('+1');expect(root.innerHTML).not.toContain('opaque-a');expect(jobs.size).toBe(0);s.dispose();
 });
 it('does not guess inspection side or show a mismatched child squad',()=>{
  const s=mountCompanionScene(root);s.update(scene('portfolio',{portfolio}));tick(700);expect(root.innerHTML).not.toContain('data-project-slot');
  const v=scene('portfolio',{revision:2,portfolio:{...portfolio,teams:[{...portfolio.teams[0]!,projectKey:'other'}]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(1400);expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });
 it('tool details update without body tool cues, have bounded accents, and unknown clears child evidence',()=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  const next={...v,descriptor:{...v.descriptor,revision:2,portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,detail:'searching' as const}]}}};s.update(next);tick(800);expect(jobs.size).toBe(1);tick(1300);expect(jobs.size).toBe(0);
  s.update({...next,descriptor:{...next.descriptor,revision:3,portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,status:'unknown'}]}}});tick(1400);expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });
 it('routes a new B result to B while A remains inspected without lending A children to B',()=>{
  const s=mountCompanionScene(root),b={...portfolio.projects[0]!,key:'opaque-b',label:'B' as const,status:'result' as const};
  const v=scene('portfolio',{portfolio:{...portfolio,mode:'result',subjectKey:b.key,projects:[...portfolio.projects,b]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-project-slot="B"');expect(root.innerHTML).toContain('data-project-slot="A"');expect(root.innerHTML).toContain('data-child-owner="A"');expect(root.innerHTML).toContain('推进');expect(root.innerHTML).toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });

 it('renders bounded task names as escaped inert text and respects omitted captions',()=>{
  expect(escapePortfolioText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  expect(portfolioCaption('重构登录页面并修复布局')).toBe('重构登录…');
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,caption:'<svg/&'}]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('&lt;svg/&amp;');expect(root.innerHTML).not.toContain('<svg/&');
  s.update({...v,descriptor:{...v.descriptor,revision:2,portfolio}});tick(1400);expect(root.innerHTML).not.toContain('&lt;svg/');s.dispose();
 });

 it.each(['left','right'] as const)('unfolds one independent dossier with continuous phase endpoints (%s)',side=>{
  const dock=managementDossierDock(side)!;
  expect(managementDossierPose('gather-out',180,dock)).toEqual(managementDossierPose('gather-in',0,dock));
  expect(managementDossierPose('gather-in',340,dock)).toEqual(managementDossierPose('address-user',0,dock));
  expect(managementDossierPose('management-release',180,dock)?.opacity).toBe(0);
  expect(managementDossierPose('type',0,dock)).toBeNull();
  expect(managementDossierPose('address-user',0,dock,true)?.open).toBe(1);
 });

 it.each([false,true])('continues a short gather phase from its actual visible shape (spatial=%s)',spatial=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'transition',portfolio:{...portfolio,mode:'result',subjectKey:'opaque-a'}});
  v.layout={...layout,inspectionSide:'right',...(spatial?{spatial:resolveCompanionSpatialLayout()}:{} )};
  if(spatial)v.descriptor.layout='spatial-b-v1';
  const set=(cue:SceneUpdate['descriptor']['cue'],revision:number)=>s.update({...v,descriptor:{...v.descriptor,cue,revision}});
  const card=()=>root.innerHTML.match(/<g data-summary-project="A"[\s\S]*?<\/g>/)?.[0];
  set('transition',1);tick(700);set('gather-out',2);tick(880);set('gather-in',3);tick(1040);
  const before=card();expect(before).toBeDefined();
  set('address-user',4);tick(1040);expect(card()).toBe(before);
  tick(1300);expect(card()).not.toBe(before);
  // Current attention still clears the carried pose, even with stale body cues.
  s.update({...v,descriptor:{...v.descriptor,revision:5,cue:'address-user',portfolio:{...v.descriptor.portfolio!,mode:'attention'}}});
  tick(1400);expect(card()).toBeUndefined();s.dispose();
 });

 it('keeps B permission and C question distinct and removes only the resolved notice',()=>{
  const s=mountCompanionScene(root),b={...portfolio.projects[0]!,key:'b',label:'B' as const,status:'needs-user' as const,notice:'permission' as const,requestCount:1},c={...b,key:'c',label:'C' as const,notice:'question' as const};
  const v=scene('portfolio',{portfolio:{...portfolio,mode:'attention',inspectedKey:null,projects:[b,c]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-notice="permission"');expect(root.innerHTML).toContain('data-notice="question"');expect(root.innerHTML).toContain('待授权');expect(root.innerHTML).toContain('待回答');
  s.update({...v,descriptor:{...v.descriptor,revision:2,portfolio:{...v.descriptor.portfolio!,projects:[{...b,status:'active',notice:undefined,requestCount:0},c]}}});tick(1400);
  expect(root.innerHTML).not.toContain('data-notice="permission"');expect(root.innerHTML).toContain('data-notice="question"');s.dispose();
 });

 it('holds an identified summary through authored preparation gaps and clears it on scope change',()=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'address-user',portfolio:{...portfolio,mode:'result',subjectKey:'opaque-a'}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-summary-project="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:2,cue:'transition'}});tick(830);expect(root.innerHTML).toContain('data-summary-project="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:3,scope:'other',cue:'transition'}});tick(1400);expect(root.innerHTML).not.toContain('data-summary-project');s.dispose();
 });

 it.each(['transition','management-present','address-user'] as const)('current attention suppresses the same subject result despite lagging %s body cue',cue=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'management-present',portfolio:{...portfolio,mode:'result',subjectKey:'opaque-a'}});v.layout={...layout,inspectionSide:'right'};
  s.update(v);tick(700);expect(root.innerHTML).toContain('data-summary-project="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:2,cue,portfolio:{...v.descriptor.portfolio!,mode:'attention'}}});tick(1000);expect(root.innerHTML).not.toContain('data-summary-project');
  s.update({...v,descriptor:{...v.descriptor,revision:3,suppressed:true}});tick(1300);expect(root.innerHTML).toBe('');s.dispose();
 });

 it.each(['overview','inspection','result'] as const)('does not borrow a stale intake drawing for current %s facts',mode=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'management-receive',portfolio:{...portfolio,mode,subjectKey:'opaque-a'}});v.layout={...layout,inspectionSide:'right'};
  s.update(v);tick(700);expect(root.innerHTML).not.toContain('data-summary-project');expect(root.innerHTML).toContain('data-project-slot="A"');s.dispose();
 });

 it.each(['left','right'] as const)('acceptance and result cards never attach to the actor (%s)',side=>{
  const dock=managementDossierDock(side)!;
  for(const cue of ['management-receive','management-delegate','gather-in','address-user','management-present'])for(let age=0;age<=500;age+=20){
   const pose=managementDossierPose(cue,age,dock)!;
   expect(pose.x).toBe(dock.x);expect(pose.y).toBe(dock.y);
   expect(pose.x+pose.width/2<46||pose.x-pose.width/2>254||pose.y+pose.height/2<18||pose.y-pose.height/2>229).toBe(true);
  }
 });

 it('does not reintroduce a large dossier during handoff or return',()=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'management-delegate',portfolio:{...portfolio,mode:'intake',subjectKey:'opaque-a'}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(100);
  expect(root.innerHTML).not.toContain('data-brief-project');expect(root.innerHTML).toContain('data-project-slot="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:2,cue:'transition'}});tick(400);expect(root.innerHTML).not.toContain('data-brief-project');s.dispose();
 });

 it('shows independent A/C child ownership and only removes the changed team member',()=>{
  const s=mountCompanionScene(root),c={...portfolio.projects[0]!,key:'c',label:'C' as const,lead:{avatar:'overlap-coral' as const,role:'project-lead' as const}},teams=[portfolio.teams[0]!,{projectKey:'c',members:[{key:'cc',avatar:'pillar-lilac' as const,state:'running' as const}],overflowCount:0}];
  const v=scene('portfolio',{portfolio:{...portfolio,projects:[...portfolio.projects,c],teams}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-child-owner="A"');expect(root.innerHTML).toContain('data-child-owner="C"');
  s.update({...v,descriptor:{...v.descriptor,revision:2,portfolio:{...v.descriptor.portfolio!,teams:[{...teams[0]!,members:[]},teams[1]!]}}});tick(1400);expect(root.innerHTML).not.toContain('data-child-owner="A"');expect(root.innerHTML).toContain('data-child-owner="C"');expect(root.innerHTML).toContain(AGENT_AVATAR_ART['pillar-lilac'].body);s.dispose();
 });
 it.each(['left','right'] as const)('only the real inspected lead approaches and returns from %s listen dock',side=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio});v.layout={...layout,inspectionSide:side};s.update(v);tick(700);
  const home=squadHome('A',side);expect(root.innerHTML).toContain(`data-center="${home.x},${home.y}"`);
  s.update({...v,descriptor:{...v.descriptor,revision:2,cue:side==='right'?'listen-right':'listen-left'}});tick(860);expect(root.innerHTML).toContain(`data-center="${side==='right'?250:42},128"`);expect(root.innerHTML).toContain('data-child-owner="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:3,cue:'transition'}});tick(1060);expect(root.innerHTML).toContain(`data-center="${home.x},${home.y}"`);s.dispose();
 });
 it('active work has finite motion windows and sleeps between them; waiting/unknown/reduced cannot work',()=>{
  const d=scene('portfolio',{portfolio}).descriptor;expect(squadWorkTiming(d,300,0).animate).toBe(true);expect(squadWorkTiming(d,700,0)).toEqual({animate:false,wakeIn:4500});
  for(const status of ['needs-user','unknown','uncertain','settling','result','available'] as const)expect(squadWorkTiming({...d,portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,status}]}},300,0)).toEqual({animate:false,wakeIn:null});
  expect(squadWorkTiming({...d,reducedMotion:true},300,0).animate).toBe(false);
 });

 it.each([false,true])('retains the lead and its artwork across working frames (spatial=%s)',spatial=>{
  const mounted=mountCompanionScene(root),value=scene('portfolio',{portfolio,...(spatial?{layout:'spatial-b-v1' as const}:{})});
  value.layout={...layout,inspectionSide:'right',...(spatial?{spatial:resolveCompanionSpatialLayout()}: {})};
  mounted.update(value);tick(100);
  const selector=spatial?'[data-lead-position="A"]':'[data-project-slot="A"]';
  const lead=root.querySelector(selector)!,art=lead.querySelector('svg')!,before=lead.innerHTML;
  expect(art).not.toBeNull();
  tick(200);
  expect(root.querySelector(selector)).toBe(lead);
  expect(lead.querySelector('svg')).toBe(art);
  expect(lead.innerHTML).not.toBe(before); // The existing nodes still animate.
  mounted.dispose();
 });

});

// Rear exact-alpha clipping must be final: a parent drop shadow would leak back into Varin.
it('B spatial layers do not receive a second parent shadow after alpha clipping',()=>{
 const mounted=mountCompanionScene(root);
 mounted.update(scene('portfolio',{layout:'spatial-b-v1'}));tick(600);
 expect(root.innerHTML).not.toContain('clip-path="url(#outside-face)" filter="url(#paper-depth)"');
 mounted.dispose();
});


it('hides old rear DOM on a warm exact-frame change and repaints its prepared mask on the next RAF', async () => {
 const epoch = 'aa'.repeat(32), decodes: Array<() => void> = [];
 let blob = 0, hides = 0;
 // Observe the actual rear layer of the stable surface, and count synchronous hides of it.
 const rear = () => root.querySelector('[data-spatial-behind]');
 const query = root.querySelector.bind(root), wrapped = new WeakSet<Element>();
 root.querySelector = ((selector: string) => {
  const found = query(selector);
  if (selector === '[data-spatial-behind]' && found && !wrapped.has(found)) { wrapped.add(found); const set = found.setAttribute.bind(found); found.setAttribute = (name: string, value: string) => { if (name === 'visibility') hides++; set(name, value); }; }
  return found;
 }) as typeof root.querySelector;
 const state = { get hidden() { return rear()?.getAttribute('visibility') === 'hidden'; } };
 const data = { packages: [{ id: 'mask-pair', canvas: [4, 4], geometryReference: 'review', stage: 'motion-candidate', reviewStatus: 'candidate', entryPose: 'rest', exitPose: 'rest', pages: [{ file: 'first.png' }, { file: 'next.png' }], frames: [
  { page: 0, rect: [0, 0, 2, 2], offset: [1, 1], durationMs: 100 },
  { page: 1, rect: [2, 2, 2, 2], offset: [1, 1], durationMs: 100 },
 ] }] };
 vi.stubGlobal('fetch', async (input: string) => input.endsWith('bundle.json') ? new Response(JSON.stringify(data)) : input.endsWith('occlusion.json') ? new Response('', { status: 404 }) : new Response('png'));
 vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).fill(170).buffer } });
 vi.stubGlobal('URL', { createObjectURL: () => `blob:mask-${blob++}`, revokeObjectURL() {} });
 vi.stubGlobal('Image', class { naturalWidth = 8; naturalHeight = 8; src = ''; removeAttribute() {} decode() { return new Promise<void>(resolve => decodes.push(resolve)); } });
 const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
 const mounted = mountCompanionScene(root);
 const value = scene('portfolio', { layout: 'spatial-b-v1', drawing: { epoch, packageId: 'mask-pair', frameIndex: 0, bundle: 'review' } });
 value.layout = { ...layout, spatial: resolveCompanionSpatialLayout() };
 mounted.update(value); tick(600); expect(state.hidden).toBe(true);
 await flush(); decodes[0]!(); await flush(); tick(620);
 expect(state.hidden).toBe(false); expect(root.innerHTML).toContain('href="blob:mask-0"');
 await flush(); const beforePrefetch = hides; decodes[1]!(); await flush();
 expect(hides).toBe(beforePrefetch); expect(state.hidden).toBe(false); expect(root.innerHTML).toContain('href="blob:mask-0"');
 mounted.update({ ...value, descriptor: { ...value.descriptor, revision: 2, drawing: { ...value.descriptor.drawing!, frameIndex: 1 } } });
 expect(state.hidden).toBe(true); expect(hides).toBe(beforePrefetch + 1); // Old DOM is never visible with old alpha after drawing receipt.
 tick(640); // No awaiting another fetch/decode/microtask between update and this RAF.
 expect(state.hidden).toBe(false); expect(root.innerHTML).toContain('href="blob:mask-1"'); expect(root.innerHTML).toContain('viewBox="2 2 2 2"');
 expect(root.innerHTML).not.toContain('href="blob:mask-0"'); expect(decodes).toHaveLength(2);
 mounted.dispose();
});
