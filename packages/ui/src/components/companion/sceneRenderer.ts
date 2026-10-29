import { spatialArtwork } from './spatialArtwork';
import { SceneCharacterMaskCache, inverseCharacterMaskSvg, type SceneCharacterMask } from './sceneCharacterMask';
import type { CompanionSpatialLayout } from '@varin/application-client/desktop';
import { portfolioArtwork, squadWorkTiming, type PortfolioListen, type PortfolioBeat } from './portfolioArtwork';
import type { DesktopCompanionScene } from '@varin/application-client';
import { COMPANION_SCENE_GEOMETRY as geometry, COMPANION_TEAM_VISIBLE_LIMIT } from './sceneGeometry';
import { AGENT_AVATAR_ART, agentAvatarSvg } from '../ui/agent-avatar-art';

export interface SceneLayout { spatial?: CompanionSpatialLayout; inspectionSide?: 'left' | 'right' | null; character: { x: number; y: number; width: number; height: number }; visible: { x: number; y: number; width: number; height: number } }
export interface SceneUpdate { descriptor: DesktopCompanionScene; layout: SceneLayout }
const blue = '#7895b5', ink = '#4c5268', cyan = '#8bbfc9', purple = '#aaa0ca', gold = '#c7a56c', peach = '#be8f9b';
const path = (d: string, c = ink, fill = 'none', width = 1.4) => `<path d="${d}" stroke="${c}" fill="${fill}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const dot = (x: number, y: number, c = cyan, r = 3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
const diamond = (x:number,y:number,r=4,c=gold) => path(`M${x} ${y-r} l${r} ${r} l-${r} ${r} l-${r} -${r} Z`,c,'#fff9eb',1.2);
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - (1-clamp(n)) ** 3;
const group = (content: string, x = 0, y = 0, angle = 0, cx = 0, cy = 0) => `<g transform="translate(${x} ${y}) rotate(${angle} ${cx} ${cy})">${content}</g>`;
const lines=(x:number,y:number,w:number,c=blue)=>path(`M${x} ${y} h${w} M${x} ${y+7} h${w*.73} M${x} ${y+14} h${w*.87}`,c,'none',1.6);
/** Ivory faces, enamel backs and a dark binding establish a miniature object, not a UI icon. */
const folio=(x:number,y:number,w=42,h=53,c=purple)=>
 path(`M${x+3} ${y+3} l${w} -2 l-1 ${h} l-${w} 2 Z`,ink,c)
 +path(`M${x} ${y} Q${x+w*.5} ${y-4} ${x+w} ${y} v${h-3} Q${x+w*.5} ${y+h-6} ${x} ${y+h} Z`,ink,'url(#paper)')
 +path(`M${x+4} ${y+2} v${h-6}`,c,'none',3)
 +path(`M${x+8} ${y+4} Q${x+w*.5} ${y+1} ${x+w-3} ${y+4}`,'#fff','none',1.3)
 +path(`M${x+w-12} ${y} v13 l3 -3 l3 3 v-13`,c,c,.8)
 +lines(x+10,y+22,w-18,c)
 +path(`M${x+8} ${y+h-3} Q${x+w*.5} ${y+h-6} ${x+w-2} ${y+h-5}`,blue,'none',.7);
const tether=(x:number,y:number,left=false,c=purple)=>{
 const a=left?geometry.computerLeft:geometry.computerRight;
 return path(`M${a.x} ${a.y} Q${(a.x+x)/2} ${Math.max(a.y,y)+19} ${x} ${y}`,c,'none',1)
 +diamond(x,y,2.6,c);
};
type TeamMember = NonNullable<DesktopCompanionScene['team']>['members'][number];
interface TeamBeat { at: number; entering: boolean; state: string; seat: number }
type TeamBeats = ReadonlyMap<string, TeamBeat>;
const spirit=(x:number,y:number,avatar:Parameters<typeof agentAvatarSvg>[0])=>
 path(`M${x} ${y-21} Q${x+23} ${y-19} ${x+21} ${y+3} Q${x+19} ${y+19} ${x} ${y+21} Q${x-21} ${y+18} ${x-21} ${y} Q${x-22} ${y-19} ${x} ${y-21} Z`,purple,'url(#spirit-glass)',1)
 +path(`M${x-13} ${y-17} q10 -6 23 -1`,'#fff','none',1.5)
 +agentAvatarSvg(avatar).replace('<svg ',`<svg x="${x-17}" y="${y-17}" width="34" height="34" `)
 +diamond(x,y+23,3.2)+path(`M${x-10} ${y+23} q10 6 20 0`,purple,'none',.8);

/** Moonlit atelier: finite hand/gaze-led accents; no idle orbit or result invention. */
function artwork(d: DesktopCompanionScene, elapsed: number, cueElapsed = elapsed, readingRight = false, edge: 'left' | 'right' | null = null, teamBeats: TeamBeats = new Map(), now = 0, teamOnly = false): string {
 const reduced=d.reducedMotion, active=d.phase==='active', legacy=d.cue==='engaged';
 const entrance=reduced?1:ease(elapsed/420), accent=reduced||!active?0:Math.sin(Math.PI*clamp(cueElapsed/520));
 const stroke=reduced?1:ease(cueElapsed/320), motion=active&&!reduced;
 let z='';
 if(!teamOnly || d.kind==='dispatch') switch(d.kind){
 case 'reading': {
  const flip=motion&&(d.cue==='page-turn'||legacy)?accent:0;
  z=group(folio(12,84,40,56),0,0,-12,48,138)
    +group(folio(29,77,43,59,blue),0,-3*flip,8*flip,65,133)
    +path(`M40 ${104+(d.cue==='read'?stroke*13:6)} h23`,cyan,'none',4)
    +path('M16 91 l-4 -6 M22 84 l-1 -5',gold,'none',1.1);
  const shift=readingRight?199:8;
  z=tether(shift+65,136,!readingRight)+group(z,shift-10*(1-entrance),7*(1-entrance),-4*(1-entrance),40,130);
  break;
 }
 case 'editing': {
  const x=edge==='right'?12:220, revise=d.cue==='revise'?accent:0;
  z=folio(x+4,91,51,61,blue)
   +path(`M${x-2} 121 Q${x+26} 116 ${x+59} 121 l-2 12 Q${x+25} 128 ${x-3} 133 Z`,purple,'url(#ribbon)',1)
   +path(`M${x+8} 125 h${(d.cue==='type'?stroke:1)*32}`,ink,'none',2)
   +group(path(`M${x+46} 137 l14 -31 l5 -3 l1 6 l-15 31 l-6 4 Z`,ink,'url(#metal)')+path(`M${x+46} 137 l5 3 l-6 4 Z`,ink,ink),-5*revise,-6*revise)
   +diamond(x+12,98,3);
  z=tether(x+25,153,x<100)+group(z,9*(1-entrance),5*(1-entrance));break;
 }
 case 'searching': {
  const selected=d.cue==='select'?stroke:0;
  // Edge layouts are authored as one compact vertical constellation, not a
  // translated copy of two lanes (which used to fall below the scene surface).
  const cards=edge==='left'?[[240,78],[247,120],[239,157]]:edge==='right'?[[12,78],[20,120],[12,157]]:[[10,112],[242,78],[243,145]];
  const [first,second,third]=cards;
  z=group(folio(first![0]!,first![1]!,32,36,blue),0,0,-8,first![0]!+20,first![1]!+28)
   +group(folio(second![0]!,second![1]!,32,37,purple),0,0,7,second![0]!+13,second![1]!+22)
   +group(folio(third![0]!,third![1]!,32,35,cyan),-4*selected,-6*selected,-5,third![0]!+7,third![1]!+19);
  const target=d.cue==='scan-left'?first!:second!, x=target[0]!+17,y=target[1]!+14;
  if(legacy||['scan-left','scan-right','select'].includes(d.cue)) z+=`<circle cx="${x}" cy="${y}" r="17" fill="#edf7fa" fill-opacity=".32" stroke="${ink}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="14" fill="none" stroke="${gold}" stroke-width="1.2"/>`+path(`M${x+12} ${y+13} l10 12`,ink,'none',4)+path(`M${x-9} ${y-4} q2 -6 8 -7`,'#fff','none',2.3);
  if(!edge)z+=path('M44 102 Q58 88 72 88 M232 132 q12 -7 22 -5',purple,'none',1)+diamond(67,88,3)+diamond(254,127,2.5);
  else z+=diamond(first![0]!+5,first![1]!-7,2.5)+path(`M${third![0]!+35} ${third![1]!-10} q5 -8 0 -16`,purple,'none',1);
  z=group(z,0,6*(1-entrance));break;
 }
 case 'dispatch': {
  const members=(d.team?.members??[]).filter(member=>Object.prototype.hasOwnProperty.call(AGENT_AVATAR_ART,member.avatar)).slice(0,COMPANION_TEAM_VISIBLE_LIMIT);
  const seats=edge==='left'?[[255,81],[257,131],[252,181]]:edge==='right'?[[31,81],[33,131],[29,181]]:[[32,101],[260,85],[254,171]];
  members.forEach((member,i)=>{
   const beat=teamBeats.get(member.key), [x,y]=seats[beat?.seat??i]!, age=beat?now-beat.at:1000;
   const leaving=member.state==='leaving', entering=!!beat?.entering;
   const progress=reduced?1:ease(age/(leaving?500:620));
   const amount=leaving?1-progress:entering?progress:1;
   const anchor=x!<150?geometry.computerLeft:geometry.computerRight;
   const px=entering||leaving?anchor.x+(x!-anchor.x)*amount:x!, py=entering||leaving?anchor.y+(y!-anchor.y)*amount+Math.sin(amount*Math.PI)*12:y!;
   const size=.72+.28*amount;
   let charm=spirit(px,py,member.avatar);
   if(member.state==='settling')charm+=path(`M${px+12} ${py+15} h7 M${px+12} ${py+19} h7`,blue,'none',1.3);
   if(member.state==='preparing')charm+=diamond(px+15,py+17,3,purple);
   if(member.state==='waiting')charm+=path(`M${px+13} ${py+14} v5 M${px+17} ${py+14} v5`,gold,'none',1.6);
   if(member.state==='failed')charm+=path(`M${px+16} ${py+10} v5`,peach,'none',2)+dot(px+16,py+18,peach,1);
   if(amount>0)z+=`<g opacity="${amount}">${tether(px,py+23,px<150,i===1?cyan:purple)}<g transform="translate(${px*(1-size)} ${py*(1-size)}) scale(${size})">${charm}</g></g>`;
  });
  // Missing identities never become invented mascots or imply completion.
  if(!members.length)z=diamond(210,160,6,purple)+tether(210,160,false);
  if(d.team?.overflowCount && d.team.overflowCount>0){
   const x=edge==='right'?31:256;
   z+=path(`M${x-11} 211 h23 v10 h-23 Z`,purple,'url(#paper)',1)+`<text x="${x+.5}" y="219" text-anchor="middle" fill="${ink}" font-size="10" font-family="system-ui">+${d.team.overflowCount}</text>`;
  }
  break;
 }
 case 'organize': {
  const x=edge==='right'?12:220, align=d.cue==='organize-align'?accent:0;
  z=path(`M${x+2} 144 l8 -10 l48 0 l4 24 l-58 0 Z`,ink,'#a9adc7')
   +group(folio(x+7,113,31,42,purple),-3*align,-5*align,-7,235,145)+group(folio(x+24,119,29,37,blue),3*align,-3*align,6,250,145)
   +path(`M${x} 149 l61 -3 l-5 26 l-51 2 Z`,ink,'url(#ribbon)')
   +path(`M${x+3} 151 l54 -3 M${x+9} 169 l43 -2`,'#f7f3ff','none',1.3)
   +path(`M${x+22} 152 l18 -1 l-1 10 l-17 1 Z`,gold,'url(#paper)',1)+diamond(x+30,157,3);
  z=tether(x+30,174,x<100)+group(z,0,7*(1-entrance));break;
 }
 case 'verify': {
  const x=edge==='right'?10:220,scan=d.cue==='verify-scan'?stroke:.45;
  z=group(folio(x+1,115,28,45,blue),0,0,-4,x+20,150)+group(folio(x+34,115,28,45,purple),0,0,4,x+44,150)
   +path(`M${x+8} ${132+scan*14} h14 M${x+40} ${132+scan*14} h14`,cyan,'none',3)
   +path(`M${x+9} 166 q23 12 45 0`,purple)+diamond(x+32,171,4)
   +path(`M${x+28} 139 h7 M${x+31.5} 135 v8`,gold,'none',1);
  z=group(z,0,6*(1-entrance));break;
 }
 case 'question': {
  const answered=d.phase==='resolve'&&d.outcome==='answered';
  z=path('M220 78 Q228 67 248 71 Q283 69 284 91 L282 111 Q280 124 258 123 L237 122 L220 136 L224 120 Q213 116 214 101 Z',ink,'url(#ribbon)',1.1)
   +path('M222 77 Q245 70 272 77 Q281 82 278 104 Q279 116 258 117 L235 116 L224 125 L228 115 Q218 113 219 100 Z',blue,'url(#paper)',1)
   +diamond(274,78,4);
  z+=answered?lines(231,92,31,peach):path('M238 89 C238 78 257 78 257 89 C257 97 246 96 246 103',ink,'none',3)+dot(246,110,ink,1.7);
  const shift=edge==='right'?-207:0;
  z=tether(223+shift,133,shift!==0,peach)+group(z,shift+6*(1-entrance),5*(1-entrance));break;
 }
 case 'permission': {
  const allowed=d.phase==='resolve'&&d.outcome==='allowed',denied=d.phase==='resolve'&&d.outcome==='denied',p=reduced?1:ease(elapsed/480);
  z=group(folio(216,130,28,35,blue),allowed?36*p:denied?-15*p:0,0,-5,230,147)
   +path(allowed?`M253 119 l${18*p} -9 M258 171 l${18*p} 9`:'M253 119 v52 M258 119 v52',gold,'none',1.5)
   +path('M255 112 l-4 7 l4 5 l4 -5 Z',gold,'url(#metal)')
   +path('M258 93 l24 -2 l2 29 l-12 9 l-14 -7 Z',ink,'url(#metal)')
   +path(allowed?'M264 100 V92 Q264 82 274 84':'M264 100 V93 Q264 82 276 92 V99',ink,'none',3)
   +path('M260 101 l21 -1 l0 18 l-10 7 l-10 -5 Z',gold,'url(#paper)')
   +diamond(271,110,4)+path('M271 113 v5',ink,'none',2);
  if(allowed)z+=path(`M255 130 l${14*p} -7 M255 161 l${14*p} 7`,gold);
  const shift=edge==='right'?-207:0;
  z=tether(238+shift,167,shift!==0,gold)+group(z,shift+6*(1-entrance),4*(1-entrance));break;
 }
 case 'status': {
  const x=edge==='right'?13:232,y=178;
  z=path(`M${x-2} ${y+2} l9 -5 l31 0 l7 6 l-2 18 l-38 2 Z`,ink,'url(#ribbon)')
   +path(`M${x+1} ${y+2} l38 -2 l1 17 l-38 3 Z`,blue,'url(#paper)',1)+diamond(x+1,y+3,2.5);
  const glyphs:Record<string,string>={
   queued:path(`M${x+11} ${y+4} h14 v9 h-14 Z M${x+17} ${y+8} h14 v9 h-14 Z`,blue,'#edf3fa',1.3),
   external:path(`M${x+10} ${y+6} v9 M${x+31} ${y+6} v9`,cyan)+diamond(x+21,y+10,3,cyan),
   retry:path(`M${x+11} ${y+14} A9 9 0 1 1 ${x+31} ${y+9} M${x+29} ${y+4} l2 5 l-5 0`,gold)+path(`M${x+19} ${y+7} v6 M${x+24} ${y+7} v6`,ink),
   failure:path(`M${x+21} ${y+3} v8`,peach,'none',3)+dot(x+21,y+16,peach,1.5),
   cancelling:path(`M${x+8} ${y+10} h7 M${x+28} ${y+10} h7 M${x+19} ${y+6} h5 v9 h-5 Z`,gold),
   disconnected:path(`M${x+8} ${y+10} h9 M${x+27} ${y+10} h8 M${x+20} ${y+5} l-3 10 M${x+27} ${y+5} l-3 10`,ink),
   synchronizing:path(`M${x+11} ${y+11} A10 7 0 0 1 ${x+30} ${y+6} l-5 0 M${x+32} ${y+9} A10 7 0 0 1 ${x+13} ${y+15} l5 0`,cyan),
   uncertain:diamond(x+21,y+10,9,gold)+dot(x+21,y+10,ink,1.7)
  };z+=glyphs[d.status??'']??'';z=group(z,0,5*(1-entrance));break;
 }
 }
 // A parent's changing tool does not mean its children disappeared. Retain a
 // quiet identity cluster outside dispatch; it never replays a send gesture.
 if(d.kind!=='dispatch' && d.team?.members.length){
  const left=edge!=='left', ox=left?17:220, y=d.kind==='searching'&&edge?211:left?190:211;
  const members=d.team.members.filter(member=>Object.prototype.hasOwnProperty.call(AGENT_AVATAR_ART,member.avatar)).slice(0,COMPANION_TEAM_VISIBLE_LIMIT);
  members.forEach((member,i)=>{
   const beat=teamBeats.get(member.key),x=ox+(beat?.seat??i)*19;
   const opacity=member.state==='leaving'?(reduced?0:1-ease((now-(beat?.at??now-650))/500)):1;
   const statusMark=member.state==='settling'?path(`M${x+5} ${y+7} h5 M${x+5} ${y+10} h5`,blue,'none',.9):member.state==='waiting'?path(`M${x+6} ${y+6} v5 M${x+9} ${y+6} v5`,gold,'none',1):member.state==='failed'?dot(x+8,y+8,peach,2):member.state==='preparing'?diamond(x+8,y+8,2,purple):'';
   z+=`<g opacity="${opacity}"><circle cx="${x}" cy="${y}" r="10" fill="url(#spirit-glass)" stroke="${purple}" stroke-width=".8"/>${agentAvatarSvg(member.avatar).replace('<svg ',`<svg x="${x-9}" y="${y-9}" width="18" height="18" `)}${statusMark}</g>`;
  });
  if(d.team.overflowCount && d.team.overflowCount>0)z+=path(`M${ox+50} ${y-6} h15 v12 h-15 Z`,purple,'url(#paper)',.7)+`<text x="${ox+57.5}" y="${y+3}" text-anchor="middle" fill="${ink}" font-size="8" font-family="system-ui">+${d.team.overflowCount}</text>`;
 }
 if(!d.team&&d.count&&['reading','editing','searching'].includes(d.kind??''))z+=diamond(39,176,5,purple)+`<text x="49" y="180" fill="${ink}" font-size="11" font-family="system-ui">${d.count}</text>`;
 return z;
}

/** No RuntimeAPIs, preload access, external assets, input handlers, or user text. */
export function mountCompanionScene(root: HTMLElement) {
  root.style.cssText='position:fixed;inset:0;overflow:hidden;pointer-events:none;user-select:none';
  root.setAttribute('aria-hidden','true');
  let resetRoster=false;
  let maskCache:SceneCharacterMaskCache|null=null, maskSelector:'selected'|'review'|null=null, characterMask:SceneCharacterMask|null=null;
  const hideRear=()=>{root.querySelector?.('[data-spatial-behind]')?.setAttribute('visibility','hidden');};
  let portfolioBeats=new Map<string,PortfolioBeat>();
  let portfolioCueStarted=0;
  let portfolioListen:PortfolioListen|null=null,workEpoch=performance.now();
  let workTimer:ReturnType<typeof setTimeout>|undefined;
  let portfolioPacketCue:string|null=null,portfolioPacketStarted=0;
  let teamBeats = new Map<string, TeamBeat>();
  let departing = new Map<string,{ member: TeamMember; at: number }>();
  let current: SceneUpdate | null=null, previous: SceneUpdate|null=null, started=0, previousAt=0, lastRevision=-1, frame=0, phaseStarted=0, previousElapsed=0, cueStarted=0;
  const render = (now: number) => {
    frame=0;
    if(workTimer!==undefined){clearTimeout(workTimer);workTimer=undefined;}
    if(!current || current.descriptor.suppressed || current.descriptor.menuOpen || (!current.descriptor.kind && !current.descriptor.team?.members.length && !departing.size) || document.hidden) { root.replaceChildren(); return; }
    const {descriptor:incoming,layout:l}=current, elapsed=now-started;
    for(const [key,value] of departing)if(now-value.at>=500)departing.delete(key);
    const d:DesktopCompanionScene=departing.size?{...incoming,team:{members:[...(incoming.team?.members??[]),...[...departing.values()].map(value=>value.member)],overflowCount:incoming.team?.overflowCount??null}}:incoming;
    const w=root.clientWidth||522,h=root.clientHeight||432;
    const scale=l.character.width*w/geometry.character.width, tx=l.character.x*w-geometry.character.x*scale,ty=l.character.y*h-geometry.character.y*scale;
    const face = geometry.protectedFace;
    // Layout anchors are independent of identity art; replace together with the next canonical.
    const leftEdge=(l.visible.x*w-tx)/scale,rightEdge=((l.visible.x+l.visible.width)*w-tx)/scale;
    const leftCrop=leftEdge>9, rightCrop=rightEdge<285;
    // Compress only the external left/right lanes toward the body at screen edges; never mirror the character.
    const lane=(content:string)=>`<g clip-path="url(#outside-face)">${content}</g>`;
    const terminal=d.phase!=='active', phaseAge=now-phaseStarted;
    const end=d.phase==='resolve'?900:600;
    const opacity=terminal?1-clamp((phaseAge-(d.phase==='resolve'?500:0))/(d.phase==='resolve'?400:600)):d.reducedMotion?1:ease(elapsed/220);
    const edge=leftCrop&&!rightCrop?'left':rightCrop&&!leftCrop?'right':null;
    const hasTeam=!!d.team?.members.length;
    let body=d.kind==='portfolio'?lane(portfolioArtwork(d,l.inspectionSide,now,now-portfolioCueStarted,portfolioBeats,portfolioPacketCue?{cue:portfolioPacketCue,age:now-portfolioPacketStarted}:undefined,portfolioListen,workEpoch)):d.kind==='dispatch'?'':lane(artwork({...d,team:undefined,count:d.team?null:d.count},elapsed,now-cueStarted,leftCrop&&!rightCrop,edge,teamBeats,now));
    let maskDefs='';
    if(d.kind==='portfolio'&&d.layout==='spatial-b-v1'&&l.spatial){
      const spatial=spatialArtwork(d,l.spatial,l.inspectionSide,now,workEpoch,portfolioListen,portfolioPacketCue?{cue:portfolioPacketCue,age:now-portfolioPacketStarted}:undefined);
      const bounds=l.spatial.available;
      if(characterMask)maskDefs=inverseCharacterMaskSvg('drawn-character',characterMask,geometry.character,{x:bounds.left,y:bounds.top,width:bounds.right-bounds.left,height:bounds.bottom-bounds.top});
      body=`<g data-spatial-behind="true" ${characterMask?'mask="url(#drawn-character)"':'visibility="hidden"'}>${spatial.behind}</g>${spatial.front}`;
    }
    const teamLayer=hasTeam?lane(artwork({...d,phase:'active',outcome:null,count:null},elapsed,now-cueStarted,leftCrop&&!rightCrop,edge,teamBeats,now,true)):'';
    if(d.kind!=='portfolio'&&previous&&!d.reducedMotion&&now-previousAt<240&&previous.descriptor.scope===d.scope&&!terminal) body=`<g opacity="${1-(now-previousAt)/240}">${lane(previous.descriptor.kind==='dispatch'?'':artwork({...previous.descriptor,phase:'withdraw',team:undefined},previousElapsed))}</g>`+body;
    // At a display edge put one-sided scenes on the available side. Do not
    // push cards through the protected face or mirror the character to make room.
    // One-sided scenes relocate objects inside artwork, keeping laptop tethers fixed.
    const withdraw = terminal && !d.reducedMotion ? ease(phaseAge/end) : 0;
    const layers = withdraw ? `<g transform="translate(${150*withdraw*.08} ${148*withdraw*.08}) scale(${1-withdraw*.08})">${body}</g>` : body;
    // All edge compositions are authored above; anchors never move with lanes.
    root.innerHTML=`<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><defs>${maskDefs}<linearGradient id="paper" x1="0" y1="0" x2=".1" y2="1"><stop stop-color="#fffdf5"/><stop offset=".44" stop-color="#fbfcff"/><stop offset="1" stop-color="#dce7f1"/></linearGradient><linearGradient id="spirit-glass" x2=".3" y2="1"><stop stop-color="#fffaf4" stop-opacity=".8"/><stop offset="1" stop-color="#c3cee9" stop-opacity=".45"/></linearGradient><linearGradient id="ribbon" x2=".3" y2="1"><stop stop-color="#e9e5f5"/><stop offset=".48" stop-color="#c7c6e0"/><stop offset="1" stop-color="#a1afcb"/></linearGradient><linearGradient id="metal" x2=".8" y2="1"><stop stop-color="#fff2ca"/><stop offset=".4" stop-color="#e6ce9d"/><stop offset="1" stop-color="#b59b74"/></linearGradient><filter id="paper-depth" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="1.5" stdDeviation="1" flood-color="#273449" flood-opacity=".13"/></filter><clipPath id="outside-face"><path d="M-100 -100H400V350H-100Z M${face.x} ${face.y}V${face.y+face.height}H${face.x+face.width}V${face.y}Z" clip-rule="evenodd"/></clipPath></defs><g transform="translate(${tx} ${ty}) scale(${scale})" ><g clip-path="url(#outside-face)" ${d.layout==='spatial-b-v1'?'':'filter="url(#paper-depth)"'}><g opacity="${opacity}">${layers}</g>${teamLayer}</g></g></svg>`;
    if(terminal&&phaseAge>=end&&!hasTeam) { root.replaceChildren(); return; }
    const portfolioMoving=d.kind==='portfolio'&&[...portfolioBeats.values()].some(beat=>now-beat.at<480);
    const teamMoving=[...teamBeats.values()].some(beat=>((d.kind==='dispatch'&&beat.entering) || beat.state==='leaving') && now-beat.at<650);
    const work=d.kind==='portfolio'?squadWorkTiming(d,now,workEpoch):{animate:false,wakeIn:null};
    const listenMoving=portfolioListen&&now-portfolioListen.started<180;
    if(terminal&&phaseAge<end || !d.reducedMotion && (elapsed < 550 || now-cueStarted < 550 || teamMoving || portfolioMoving || work.animate || listenMoving)) frame=requestAnimationFrame(render);
    else if(work.wakeIn!==null)workTimer=setTimeout(()=>{workTimer=undefined;frame=requestAnimationFrame(render);},Math.max(16,work.wakeIn));
  };
  const update=(value:SceneUpdate)=>{
    if(value.descriptor.revision<lastRevision)return;
    lastRevision=value.descriptor.revision;
    if(workTimer!==undefined){clearTimeout(workTimer);workTimer=undefined;}
    const same=current?.descriptor.scope===value.descriptor.scope&&current?.descriptor.kind===value.descriptor.kind&&current?.descriptor.phase===value.descriptor.phase&&current?.descriptor.status===value.descriptor.status;

    if(!same){
      const now=performance.now();
      previous=current?.descriptor.scope===value.descriptor.scope&&current.descriptor.phase==='active'&&current.descriptor.kind!==value.descriptor.kind?current:null;
      previousElapsed=now-started;previousAt=phaseStarted=now;
      // Ending activity withdraws the currently visible card instead of replaying its entrance.
      if(current?.descriptor.scope!==value.descriptor.scope || current?.descriptor.kind!==value.descriptor.kind || value.descriptor.phase==='active') started=now;
      else if(value.descriptor.phase==='resolve') started=now;
    }
    if (current?.descriptor.cue !== value.descriptor.cue || current?.descriptor.cueInstance !== value.descriptor.cueInstance || !same) cueStarted=performance.now();
    if (current && (current.descriptor.suppressed || current.descriptor.menuOpen) && !value.descriptor.suppressed && !value.descriptor.menuOpen) {
      started=phaseStarted=cueStarted=performance.now(); previous=null;
    }
    const firstRoster=resetRoster || current?.descriptor.scope!==value.descriptor.scope || !current?.descriptor.team || current.descriptor.suppressed || current.descriptor.menuOpen;
    const hidden=value.descriptor.suppressed || value.descriptor.menuOpen || document.hidden;
    const members=value.descriptor.team?.members??[], keys=new Set(members.map(member=>member.key));
    if(firstRoster || hidden)departing.clear();
    else for(const member of current?.descriptor.team?.members??[]){
      if(!keys.has(member.key) && !departing.has(member.key)){
        const old=teamBeats.get(member.key);
        departing.set(member.key,{member:{...member,state:'leaving'},at:old?.state==='leaving'?old.at:performance.now()});
      }
    }
    const nextBeats=new Map<string,TeamBeat>(), occupied=new Set<number>();
    // Current work owns seats before disappearing decorations. A keyed survivor
    // never shuffles to another seat just because its neighbour retired.
    for(const member of members){const prior=firstRoster?undefined:teamBeats.get(member.key);if(prior)occupied.add(prior.seat);}
    for(const [i,member] of members.entries()){
      const prior=firstRoster?undefined:teamBeats.get(member.key);
      const seat=prior?.seat??(Array.from({length:COMPANION_TEAM_VISIBLE_LIMIT},(_,n)=>n).find(n=>!occupied.has(n))??i);occupied.add(seat);
      const leavingEdge=member.state==='leaving' && prior?.state!=='leaving';
      nextBeats.set(member.key,prior && !leavingEdge?{...prior,state:member.state}:{at:performance.now()-(firstRoster&&member.state==='leaving'?650:0),entering:!firstRoster&&!prior,state:member.state,seat});
      departing.delete(member.key);
    }
    for(const [key,value] of departing){
      const old=teamBeats.get(key),seat=old?.seat;
      if(seat===undefined || occupied.has(seat) || nextBeats.size>=COMPANION_TEAM_VISIBLE_LIMIT || performance.now()-value.at>=500){departing.delete(key);continue;}
      occupied.add(seat);nextBeats.set(key,{at:value.at,entering:false,state:'leaving',seat});
    }
    teamBeats=nextBeats;
    resetRoster=hidden;
    const portfolio=value.descriptor.portfolio;
    const listenKey=portfolio?.inspectedKey??null;
    const listenValid=portfolio?.projects.some(p=>p.key===listenKey&&!['unknown','uncertain'].includes(p.status));
    if(hidden||current?.descriptor.scope!==value.descriptor.scope||portfolioListen&&portfolioListen.key!==listenKey||!listenValid)portfolioListen=null;
    if(!hidden&&listenValid&&listenKey&&['listen-left','listen-right'].includes(value.descriptor.cue)){
      if(!portfolioListen||portfolioListen.phase==='return')portfolioListen={key:listenKey,started:performance.now(),phase:'approach'};
    }else if(portfolioListen?.phase==='approach')portfolioListen={...portfolioListen,started:performance.now(),phase:'return'};

    if(current?.descriptor.scope!==value.descriptor.scope || current?.descriptor.cue!==value.descriptor.cue || current?.descriptor.portfolio?.subjectKey!==portfolio?.subjectKey || hidden)portfolioCueStarted=performance.now();
    const packetSubject=portfolio?.projects.find(project=>project.key===(portfolio.mode==='inspection'?portfolio.inspectedKey:portfolio.subjectKey));
    const packetUnavailable=packetSubject?.status==='unknown'||packetSubject?.status==='uncertain';
    const packetReset=hidden||packetUnavailable||current?.descriptor.scope!==value.descriptor.scope||current?.descriptor.portfolio?.subjectKey!==portfolio?.subjectKey||!portfolio;
    if(packetReset)portfolioPacketCue=null;
    const incomingCue=value.descriptor.cue;
    if(!hidden&&!packetUnavailable&&['gather-out','gather-in','address-user','management-present','management-release','management-receive','management-delegate'].includes(incomingCue)){
      if(portfolioPacketCue!==incomingCue){portfolioPacketCue=incomingCue;portfolioPacketStarted=performance.now()-(packetReset?1000:0);}
    }else if(incomingCue!=='transition')portfolioPacketCue=null;
    // Brief preparation drawings may map to transition. Hold the same summary
    // through those authored gaps; only its real next transfer cue moves it.

    const resetPortfolio=hidden || !portfolio || current?.descriptor.scope!==value.descriptor.scope || current?.descriptor.suppressed || current?.descriptor.menuOpen || resetRoster;
    const nextPortfolio=new Map<string,PortfolioBeat>();
    for(const project of portfolio?.projects??[]){
      if(project.status==='unknown'||project.status==='uncertain')continue;
      const old=resetPortfolio?undefined:portfolioBeats.get(project.key),now=performance.now();
      // Initial/reconnected facts are static. Changes during cooldown update detail
      // immediately but cannot sustain a never-ending accent under tool bursts.
      const signature=JSON.stringify([project.detail,project.status,(portfolio?.teams??[]).find(t=>t.projectKey===project.key)?.members.map(m=>[m.key,m.state])]);
      const at=old&&old.detail!==signature&&now-old.at>=1200?now:old?.at??now-2000;
      nextPortfolio.set(project.key,{detail:signature,at});
    }
    portfolioBeats=nextPortfolio;
    if(current?.descriptor.scope!==value.descriptor.scope){workEpoch=performance.now();characterMask=null;hideRear();maskCache?.clear();}
    current=value;
    const drawing=value.descriptor.drawing;
    if(hidden||value.descriptor.layout!=='spatial-b-v1'||!drawing){characterMask=null;hideRear();maskCache?.clear();}
    else {
      if(maskSelector!==drawing.bundle){maskCache?.dispose();maskSelector=drawing.bundle;characterMask=null;
        maskCache=new SceneCharacterMaskCache(drawing.bundle,ready=>{characterMask=ready;if(!ready)hideRear();if(!frame)frame=requestAnimationFrame(render);});
      }
      void maskCache?.setDrawing(drawing);
    }
    if(frame)cancelAnimationFrame(frame);
    frame=requestAnimationFrame(render);
  };
  const event=(e:Event)=>update((e as CustomEvent<SceneUpdate>).detail);
  const visibility=()=>{if(frame)cancelAnimationFrame(frame);if(workTimer!==undefined){clearTimeout(workTimer);workTimer=undefined;}if(document.hidden){characterMask=null;maskCache?.clear();resetRoster=true;departing.clear();teamBeats.clear();portfolioBeats.clear();portfolioPacketCue=null;portfolioListen=null;root.replaceChildren();}else {started=performance.now();frame=requestAnimationFrame(render);}};
  window.addEventListener('varin-companion-scene',event);document.addEventListener('visibilitychange',visibility);
  document.documentElement.dataset.varinCompanionSceneReady = 'true';
  window.dispatchEvent(new Event('varin-companion-scene-ready'));
  return { update, dispose:()=>{maskCache?.dispose();delete document.documentElement.dataset.varinCompanionSceneReady;cancelAnimationFrame(frame);if(workTimer!==undefined)clearTimeout(workTimer);root.replaceChildren();window.removeEventListener('varin-companion-scene',event);document.removeEventListener('visibilitychange',visibility);} };
}
