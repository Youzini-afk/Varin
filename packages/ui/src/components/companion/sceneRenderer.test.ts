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
