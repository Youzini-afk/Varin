import type { DesktopCompanionScene } from '@varin/application-client';
import { agentAvatarSvg, AGENT_AVATAR_ART } from '../ui/agent-avatar-art';
import { projectLeadSvg } from './projectLeadArt';
export interface PortfolioBeat { detail?: string; at: number }
export const MANAGEMENT_CUES = new Set(['listen-left','listen-right','gather-out','gather-in','address-user','management-present','management-release','management-receive','management-delegate']);
export function managementPacketPose(cue:string,age:number,side:'left'|'right',reduced=false,leadTarget?:{x:number;y:number}){
 const dock={x:side==='right'?250:42,y:128},laptop={x:166,y:147},mid={x:(dock.x+166)/2,y:138},front={x:166,y:132};
 if(cue==='management-delegate'){
  if(!leadTarget)return null;
  const p=reduced?1:Math.max(0,Math.min(1,age/400)),smooth=(v:number)=>v*v*(3-2*v),hand={x:231,y:96};
  let point:{x:number;y:number};
  if(p<.45){const u=smooth(p/.45);point={x:(1-u)*(1-u)*laptop.x+2*(1-u)*u*245+u*u*hand.x,y:laptop.y+(hand.y-laptop.y)*u*u};}
  else {const u=smooth((p-.45)/.55),v=1-u;
   if(side==='right')point={x:v*v*v*hand.x+3*v*v*u*280+3*v*u*u*280+u*u*u*leadTarget.x,y:v*v*v*hand.y+3*v*v*u*hand.y+3*v*u*u*leadTarget.y+u*u*u*leadTarget.y};
   else point={x:v*v*v*hand.x+3*v*v*u*240+3*v*u*u*10+u*u*u*leadTarget.x,y:v*v*v*hand.y+3*v*v*u*200+3*v*u*u*200+u*u*u*leadTarget.y};
  }
  return {...point,opacity:Math.max(0,1-Math.max(0,(p-.95)/.05))};
 }
 const stages:Record<string,{from:{x:number;y:number};to:{x:number;y:number};duration:number;fade?:boolean}>={
  'management-receive':{from:dock,to:laptop,duration:420},
  'gather-out':{from:dock,to:mid,duration:180},
  'gather-in':{from:mid,to:laptop,duration:340},
  'address-user':{from:laptop,to:front,duration:260},
  'management-present':{from:front,to:front,duration:500},
  'management-release':{from:front,to:laptop,duration:130,fade:true},
 };
 const stage=stages[cue];if(!stage)return null;
 const p=reduced?1:Math.max(0,Math.min(1,age/stage.duration)),e=p*p*(3-2*p);
 return {x:stage.from.x+(stage.to.x-stage.from.x)*e,y:stage.from.y+(stage.to.y-stage.from.y)*e,opacity:stage.fade?1-p:1};
}
const ink='#4c5268', gold='#c7a56c', blue='#7895b5';
const path=(d:string,c=ink,fill='none',w=1)=>`<path d="${d}" stroke="${c}" fill="${fill}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
export const escapePortfolioText=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
/** Width budget in ideographic ems; long names ellipsize, never shrink. */
export function portfolioCaption(s:string|undefined,budget=5):string {
 if(!s)return '';const chars=Array.from(s).slice(0,24);const width=(c:string)=>/^[\x20-\x7e]$/.test(c)?.56:1;
 if(chars.reduce((n,c)=>n+width(c),0)<=budget)return chars.join('');
 let result='',used=0;for(const c of chars){if(used+width(c)>budget-1)break;result+=c;used+=width(c);}return result+'…';
}
const text=(x:number,y:number,s:string,size=8)=>`<text x="${x}" y="${y}" text-anchor="middle" fill="${ink}" font-family="Noto Sans CJK SC,system-ui" font-size="${size}">${escapePortfolioText(s)}</text>`;
type Project=NonNullable<DesktopCompanionScene['portfolio']>['projects'][number];
type ProjectNotice=NonNullable<Project['notice']>;
const noticeOf=(project:Project)=>project.notice;
function noticeGlyph(notice:ProjectNotice|undefined,x:number,y:number,size=1):string {
 const lock=path('M-4 -1 v7 h8 v-7 Z',gold,'#fffaf0',1)+path('M-3 -1 v-3 a3 3 0 0 1 6 0 v3',ink,'none',1.3);
 const question=text(0,5,'?',13);
 const lens='<circle cx="-1" cy="0" r="4" fill="none" stroke="'+blue+'" stroke-width="1.2"/>'+path('M2 3 l4 4',ink,'none',1.3);
 const disconnected=path('M-6 0 h4 M2 0 h4 M-1 -4 l-2 8',blue,'none',1.2);
 const body=notice==='permission'?lock:notice==='question'?question:notice==='mixed'?'<g transform="translate(-4 0) scale(.75)">'+lock+'</g><g transform="translate(5 0) scale(.75)">'+question+'</g>':notice==='inspect'?lens:notice==='unknown'?disconnected:path('M0 -4 l4 4 l-4 4 l-4 -4 Z',blue,'#fffaf0',1);
 return `<g data-notice="${notice??'none'}" transform="translate(${x} ${y}) scale(${size})">${body}</g>`;
}
const count=(n:number|null)=>n!==null&&n>0?String(Math.min(999,n)):'';
/** Three stable identity seats above one inspection dock; never mirror the actor.
 * Bounded optional task captions are escaped plain text. Raw keys never enter markup. */
export function portfolioArtwork(d:DesktopCompanionScene,side:'left'|'right'|null|undefined,now:number,cueAge:number,beats:ReadonlyMap<string,PortfolioBeat>,heldTransfer?:{cue:string;age:number}):string {
 const p=d.portfolio;if(!p || !side)return ''; // wait for native side receipt, not a guessed opposite gaze
 const x=side==='right'?218:10, management=MANAGEMENT_CUES.has(d.cue), q=d.reducedMotion?0:Math.sin(Math.PI*Math.min(1,Math.max(0,cueAge/520)));
 const projects=p.projects.slice(0,3), inspected=projects.find(v=>v.key===p.inspectedKey), subject=projects.find(v=>v.key===p.subjectKey);
 const a=p.mode==='inspection'?inspected:(p.mode==='intake'||p.mode==='result'||p.mode==='attention')?subject:inspected;
 let z='';
 const team=p.team;
 const compactTeam=inspected&&team?.projectKey===inspected.key&&inspected.status!=='unknown'&&inspected.status!=='uncertain'&&a?.key!==inspected.key?team:null;
 const packet=path(`M${x+3} 114 l62 -2 v43 l-62 3 Z`,'#8f9eb5','#c9cee1',.7);
 const safe=projects.filter(v=>Object.hasOwn(AGENT_AVATAR_ART,v.lead.avatar));
 for(const a of safe){
  const slot=['A','B','C'].indexOf(a.label);if(slot<0)continue;const sy=8+slot*26;
  const tone=a.status==='needs-user'?gold:a.status==='uncertain'||a.status==='unknown'?'#be8f9b':blue;
  z+=`<g data-project-slot="${a.label}">`+path(`M${x} ${sy+2} l5 -2 h59 l2 25 h-66 Z`,tone,'url(#paper)',.7);
  z+=a.lead.role==='project-lead'?projectLeadSvg(a.lead.avatar,x-1,sy,26):agentAvatarSvg(a.lead.avatar).replace('<svg ',`<svg x="${x+1}" y="${sy+2}" width="22" height="22" `);
  const notice=noticeOf(a);
  const status=a.status==='active'?(a.detail==='waiting'?'等待':'推进'):({settling:'收尾',result:'本轮结果',available:'待命','needs-user':notice==='permission'?'待授权':notice==='question'?'待回答':notice==='mixed'?'多项待办':'待你决定',uncertain:'待核查',unknown:'未知'}[a.status]);
  const compact=compactTeam&&a.key===inspected?.key?compactTeam:null;
  z+=text(x+(compact?37:44),sy+8,a.label+' · '+(compact&&status==='本轮结果'?'结果':status),6.5)+text(x+44,sy+19,portfolioCaption(a.caption),7.5);
  if(notice)z+=`<circle cx="${x+21}" cy="${sy+21}" r="4.7" fill="#fffaf0"/>`+noticeGlyph(notice,x+21,sy+21,.65);
  if(compact){const n=compact.overflowCount===null?'小队':'队'+(compact.members.length+compact.overflowCount);z+=text(x+60,sy+8,n,6);}
  z+='</g>';
 }
 // Source dossier yields to the actual arm/palm, not merely the face mask.
 const transferCue=heldTransfer?.cue??d.cue;
 const release=d.cue==='management-release'||(d.cue==='transition'&&['management-release','management-delegate'].includes(transferCue));
 const inTransfer=['gather-out','gather-in','address-user','management-present','management-receive','management-delegate'].includes(transferCue);
 const briefOpacity=release?(d.reducedMotion?1:Math.min(1,cueAge/180)):inTransfer?0:1;
 const shift=0;
 z+=`<g data-brief-project="${a?.label??'none'}" opacity="${briefOpacity}" transform="translate(0 ${shift})">`+packet+path(`M${x} 112 Q${x+32} 107 ${x+64} 112 v43 Q${x+32} 151 ${x} 156 Z`,ink,'url(#paper)',1.1)+path(`M${x+3} 115 v36`,'#aaa0ca','none',2.5);
 z+=path(`M${x+7} 114 Q${x+32} 111 ${x+59} 114`,'#fff','none',1.3)+path(`M${x+52} 111 v10 l3 -3 l3 3 v-10`,'#aaa0ca','#c7c6e0',.6);
 if(a){
  z+=text(x+10,122,a.label,8)+text(x+34,122,portfolioCaption(a.caption,5),6.5);
  const unknown=a.status==='unknown'||a.status==='uncertain';
  if(unknown)z+=noticeGlyph(a.status==='unknown'?'unknown':noticeOf(a)??'inspect',x+35,137,1.5);
  else if(a.status==='needs-user')z+=noticeGlyph(noticeOf(a),x+35,137,1.5);
  else {
   const beat=beats.get(a.key),age=beat?now-beat.at:1000,accent=d.reducedMotion?0:Math.sin(Math.PI*Math.min(1,Math.max(0,age/480)));
   z+=path(`M${x+23} 125 h28 M${x+23} 131 h22 M${x+23} 137 h25`,blue,'none',1.5);
   if(a.detail==='searching'||a.detail==='verifying')z+=`<circle cx="${x+39+accent*5}" cy="134" r="9" fill="#edf7fa" fill-opacity=".4" stroke="${gold}" stroke-width="1.5"/>`+path(`M${x+46+accent*5} 141 l5 5`,ink,'none',2);
   else if(a.detail==='editing'||a.detail==='generating')z+=path(`M${x+48} ${142-accent*3} l7 -15 l3 1 l-7 15 Z`,gold,'#fffaf0');
   else if(a.detail==='waiting')z+=path(`M${x+29} 143 v5 M${x+34} 143 v5`,gold,'none',2);
   else if(a.detail)z+=path(`M${x+22} ${144-accent*2} h27`,'#8bbfc9','none',2);
  }
  const requests=count(a.requestCount),uncertain=count(a.uncertainCount);
  if(requests||uncertain)z+=text(x+33,151,requests&&uncertain?`待${requests}项 · 核${uncertain}项`:requests?`${requests}项待处理`:`${uncertain}项待核查`,7);
 }else if(p.mode==='attention'){
  const pending=projects.filter(v=>v.status==='needs-user'||v.status==='uncertain'||v.status==='unknown');
  pending.forEach((v,i)=>{z+=text(x+13,124+i*12,v.label,8)+noticeGlyph(noticeOf(v)??(v.status==='unknown'?'unknown':v.status==='uncertain'?'inspect':undefined),x+36,121+i*12,.8)+text(x+53,124+i*12,count(v.status==='needs-user'?v.requestCount:v.uncertainCount)?count(v.status==='needs-user'?v.requestCount:v.uncertainCount)+'项':'',7);});
 }else z+=path(`M${x+12} 126 h38 M${x+12} 134 h30 M${x+12} 142 h34`,blue,'none',1.4);
 z+='</g>';
 // Management exchange is bounded and body-cued. Tool detail never calls this route.
 if((management||(d.cue==='transition'&&heldTransfer)) && a && a.status!=='unknown'&&a.status!=='uncertain'){
  const transfer=managementPacketPose(heldTransfer?.cue??d.cue,heldTransfer?.age??cueAge,side,d.reducedMotion,{x:x+12,y:21+['A','B','C'].indexOf(a.label)*26});
  if(transfer&&transfer.opacity>0){const {x:px,y:py,opacity}=transfer;
   z+=`<g data-summary-project="${a.label}" opacity="${opacity}" transform="translate(${px} ${py})">`+path('M-13 -9 h26 v18 h-26 Z',blue,'url(#paper)',.9)+text(-7,-1,a.label,7)+path('M-1 -4 h10 M-1 0 h8 M-8 5 h17',blue,'none',.8)+'</g>';
  }
 }

 if(inspected&&a?.key===inspected.key&&inspected.status!=='unknown'&&inspected.status!=='uncertain'&&team?.projectKey===inspected.key){
  team.members.slice(0,3).filter(m=>Object.hasOwn(AGENT_AVATAR_ART,m.avatar)).forEach((m,i)=>{
   const cx=x+10+i*22;
   z+=path(`M${x+32} 158 Q${cx} 161 ${cx} 169`,'#aaa0ca','none',.7);
   z+=agentAvatarSvg(m.avatar).replace('<svg ',`<svg x="${cx-10}" y="168" width="20" height="20" `);
   if(m.state==='waiting')z+=path(`M${cx-2} 191 v4 M${cx+2} 191 v4`,gold);
   else if(m.state==='failed')z+=text(cx,195,'!',8);
   else if(m.state==='leaving'||m.state==='settling')z+=path(`M${cx-3} 192 h6`,blue);
  });
  if(count(team.overflowCount))z+=text(x+32,204,'+'+count(team.overflowCount),9);
 }
 if(count(p.overflowCards))z+=text(x+58,95,'+'+count(p.overflowCards),8);
 return z;
}
