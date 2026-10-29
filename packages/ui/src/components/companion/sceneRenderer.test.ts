import {escapePortfolioText,portfolioCaption,managementPacketPose} from './portfolioArtwork';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 root={style:{},clientWidth:500,clientHeight:400,innerHTML:'',setAttribute(){},replaceChildren(){root.innerHTML='';}} as unknown as HTMLElement;
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
 const portfolio={mode:'inspection' as const,projects:[{key:'opaque-a',label:'A' as const,lead:{avatar:'ribbon-blue' as const,role:'project-lead' as const},status:'active' as const,requestCount:0,uncertainCount:0,detail:'reading' as const}],inspectedKey:'opaque-a',subjectKey:null,overflowCards:2,team:{projectKey:'opaque-a',members:[{key:'child',avatar:'scoop-pistachio' as const,state:'running' as const}],overflowCount:1}};
 it.each(['left','right'] as const)('uses native %s inspection side, real identities and exact overflow',side=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio});v.layout={...layout,inspectionSide:side};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-project-slot="A"');expect(root.innerHTML).toContain(AGENT_AVATAR_ART['ribbon-blue'].body);expect(root.innerHTML).toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);expect(root.innerHTML).toContain('+2');expect(root.innerHTML).toContain('+1');expect(root.innerHTML).not.toContain('opaque-a');expect(jobs.size).toBe(0);s.dispose();
 });
 it('does not guess inspection side or show a mismatched child squad',()=>{
  const s=mountCompanionScene(root);s.update(scene('portfolio',{portfolio}));tick(700);expect(root.innerHTML).not.toContain('data-project-slot');
  const v=scene('portfolio',{revision:2,portfolio:{...portfolio,team:{...portfolio.team,projectKey:'other'}}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(1400);expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });
 it('tool details update without body tool cues, have bounded accents, and unknown clears child evidence',()=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  const next={...v,descriptor:{...v.descriptor,revision:2,portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,detail:'searching' as const}]}}};s.update(next);tick(800);expect(jobs.size).toBe(1);tick(1300);expect(jobs.size).toBe(0);
  s.update({...next,descriptor:{...next.descriptor,revision:3,portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,status:'unknown'}]}}});tick(1400);expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });
 it('routes a new B result to B while A remains inspected without lending A children to B',()=>{
  const s=mountCompanionScene(root),b={...portfolio.projects[0]!,key:'opaque-b',label:'B' as const,status:'result' as const};
  const v=scene('portfolio',{portfolio:{...portfolio,mode:'result',subjectKey:b.key,projects:[...portfolio.projects,b]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('data-brief-project="B"');expect(root.innerHTML).toContain('data-project-slot="A"');expect(root.innerHTML).toContain('队2');expect(root.innerHTML).toContain('推进');expect(root.innerHTML).not.toContain(AGENT_AVATAR_ART['scoop-pistachio'].body);s.dispose();
 });

 it('renders bounded task names as escaped inert text and respects omitted captions',()=>{
  expect(escapePortfolioText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  expect(portfolioCaption('重构登录页面并修复布局')).toBe('重构登录…');
  const s=mountCompanionScene(root),v=scene('portfolio',{portfolio:{...portfolio,projects:[{...portfolio.projects[0]!,caption:'<svg/&'}]}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(700);
  expect(root.innerHTML).toContain('&lt;svg/&amp;');expect(root.innerHTML).not.toContain('<svg/&');
  s.update({...v,descriptor:{...v.descriptor,revision:2,portfolio}});tick(1400);expect(root.innerHTML).not.toContain('&lt;svg/');s.dispose();
 });

 it.each(['left','right'] as const)('gathers the same summary to fixed laptop on %s, with continuous stage endpoints',side=>{
  const out=managementPacketPose('gather-out',180,side)!;
  const start=managementPacketPose('gather-in',0,side)!;
  expect(out).toEqual(start);
  expect(managementPacketPose('gather-in',340,side)).toMatchObject({x:166,y:147,opacity:1});
  expect(managementPacketPose('address-user',0,side)).toMatchObject({x:166,y:147});
  expect(managementPacketPose('management-release',130,side)?.opacity).toBe(0);
  expect(managementPacketPose('type',0,side)).toBeNull();
  expect(managementPacketPose('gather-in',0,side,true)).toMatchObject({x:166,y:147});
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

 it.each(['left','right'] as const)('receives then delegates through the actual right palm without crossing the face (%s dock)',side=>{
  expect(managementPacketPose('management-receive',420,side)).toMatchObject({x:166,y:147});
  const lead={x:side==='right'?230:22,y:21};
  expect(managementPacketPose('management-delegate',180,side,false,lead)).toMatchObject({x:231,y:96});
  expect(managementPacketPose('management-delegate',400,side,false,lead)).toMatchObject({...lead,opacity:0});
  for(let age=0;age<=400;age+=10){const point=managementPacketPose('management-delegate',age,side,false,lead)!;expect(point.x+13>=82&&point.x-13<=216&&point.y+9>=18&&point.y-9<=108).toBe(false);}
 });

 it('yields the large dossier to the handoff and restores it during real return',()=>{
  const s=mountCompanionScene(root),v=scene('portfolio',{cue:'management-delegate',portfolio:{...portfolio,mode:'intake',subjectKey:'opaque-a'}});v.layout={...layout,inspectionSide:'right'};s.update(v);tick(100);
  expect(root.innerHTML).toContain('data-brief-project="A" opacity="0"');expect(root.innerHTML).toContain('data-project-slot="A"');
  s.update({...v,descriptor:{...v.descriptor,revision:2,cue:'transition'}});tick(400);expect(root.innerHTML).toContain('data-brief-project="A" opacity="1"');s.dispose();
 });

});
