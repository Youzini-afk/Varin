import type { DesktopCompanionScene } from '@varin/application-client';
import { agentAvatarSvg, AGENT_AVATAR_ART } from '../ui/agent-avatar-art';
import { projectLeadSvg } from './projectLeadArt';
export interface PortfolioBeat { detail?: string; at: number }
export const MANAGEMENT_CUES = new Set(['listen-left','listen-right','gather-out','gather-in','address-user','management-present','management-release','management-receive','management-delegate']);
export function managementPacketPose(cue:string,age:number,side:'left'|'right',reduced=false,leadTarget?:{x:number;y:number}){
 const dock=leadTarget??{x:side==='right'?250:42,y:128},laptop={x:166,y:147},mid={x:dock.x,y:147},front={x:166,y:132};
 if(cue==='management-receive'){const p=reduced?1:Math.max(0,Math.min(1,age/420)),u=p*p*(3-2*p),v=1-u;return {x:v*v*dock.x+2*v*u*dock.x+u*u*laptop.x,y:v*v*dock.y+2*v*u*147+u*u*147,opacity:1};}
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
export const portfolioText=(x:number,y:number,s:string,size=8)=>`<text x="${x}" y="${y}" text-anchor="middle" fill="${ink}" stroke="#fffdf6" stroke-opacity=".96" stroke-width="1.8" stroke-linejoin="round" paint-order="stroke fill" font-family="Noto Sans CJK SC,system-ui" font-size="${size}">${escapePortfolioText(s)}</text>`;
type Project=NonNullable<DesktopCompanionScene['portfolio']>['projects'][number];
type ProjectNotice=NonNullable<Project['notice']>;
const noticeOf=(project:Project)=>project.notice;
export function noticeGlyph(notice:ProjectNotice|undefined,x:number,y:number,size=1):string {
 const lock=path('M-4 -1 v7 h8 v-7 Z',gold,'#fffaf0',1)+path('M-3 -1 v-3 a3 3 0 0 1 6 0 v3',ink,'none',1.3);
 const question=portfolioText(0,5,'?',13);
 const lens='<circle cx="-1" cy="0" r="4" fill="none" stroke="'+blue+'" stroke-width="1.2"/>'+path('M2 3 l4 4',ink,'none',1.3);
 const disconnected=path('M-6 0 h4 M2 0 h4 M-1 -4 l-2 8',blue,'none',1.2);
 const body=notice==='permission'?lock:notice==='question'?question:notice==='mixed'?'<g transform="translate(-4 0) scale(.75)">'+lock+'</g><g transform="translate(5 0) scale(.75)">'+question+'</g>':notice==='inspect'?lens:notice==='unknown'?disconnected:path('M0 -4 l4 4 l-4 4 l-4 -4 Z',blue,'#fffaf0',1);
 return `<g data-notice="${notice??'none'}" transform="translate(${x} ${y}) scale(${size})">${body}</g>`;
}
const count=(n:number|null)=>n!==null&&n>0?String(Math.min(999,n)):'';
export interface PortfolioListen { key:string; started:number; phase:'approach'|'return' }
export const squadHome=(label:string,side:'left'|'right')=>({x:label==='B'?(side==='right'?262:30):(side==='right'?250:42),y:({A:43,B:121,C:181} as Record<string,number>)[label]??121});
const leadCache=new Map<string,string>(),childCache=new Map<string,string>();
export function leadArt(a:Project,x:number,y:number,size:number,tilt=0){
 let svg=leadCache.get(a.lead.avatar);if(!svg){svg=projectLeadSvg(a.lead.avatar,0,0,40);leadCache.set(a.lead.avatar,svg);}
 return `<g transform="rotate(${tilt} ${x} ${y}) translate(${x-size/2} ${y-size/2}) scale(${size/40})">${a.lead.role==='project-lead'?svg:agentAvatarSvg(a.lead.avatar).replace('<svg ','<svg width="40" height="40" ')}</g>`;
}
export function childArt(avatar:Parameters<typeof agentAvatarSvg>[0],x:number,y:number,size=20){
 let svg=childCache.get(avatar);if(!svg){svg=agentAvatarSvg(avatar).replace('<svg ','<svg width="20" height="20" ');childCache.set(avatar,svg);}
 return `<g transform="translate(${x-size/2} ${y-size/2}) scale(${size/20})">${svg}</g>`;
}
export function squadWorkTiming(d:DesktopCompanionScene,now:number,epoch:number){
 if(d.reducedMotion||d.suppressed||d.menuOpen||d.phase!=='active')return {animate:false,wakeIn:null as number|null};
 let animate=false,wakeIn:number|null=null;
 for(const p of d.portfolio?.projects??[]){if(p.status!=='active'||p.detail==='waiting')continue;
  const age=((now-epoch-['A','B','C'].indexOf(p.label)*1100)%5200+5200)%5200;
  if(age<640)animate=true;else wakeIn=Math.min(wakeIn??Infinity,5200-age);
 }return {animate,wakeIn};
}
export function workAccent(a:Project,now:number,epoch:number,reduced:boolean){
 if(reduced||a.status!=='active'||a.detail==='waiting')return 0;
 const age=((now-epoch-['A','B','C'].indexOf(a.label)*1100)%5200+5200)%5200;
 return age<640?Math.sin(Math.PI*age/640):0;
}
export function workProp(a:Project,x:number,y:number,b:number){
 const paper=path(`M${x-12} ${y+12} q12 -4 24 0 l-2 9 q-10 -3 -22 0 Z`,blue,'url(#paper)',.7);
 if(a.status!=='active'&&a.status!=='settling')return '';
 if(a.detail==='reading')return paper+path(`M${x} ${y+10} v10 M${x-9} ${y+15} h6 M${x+3} ${y+15} h6`,blue,'none',.8)+path(`M${x+1} ${y+11} q${10-b*8} -${3+b*6} 10 0`,gold,'#fffaf0',.7);
 if(a.detail==='editing'||a.detail==='generating')return paper+`<g transform="rotate(${-12+b*16} ${x+9} ${y+13})">`+path(`M${x+5} ${y+18} l9 -15 l3 2 l-9 15 Z`,gold,'#fffaf0',.8)+'</g>';
 if(a.detail==='searching'||a.detail==='verifying')return paper+`<circle cx="${x+7-b*5}" cy="${y+10}" r="7" fill="#eaf5fb" fill-opacity=".65" stroke="${gold}" stroke-width="1.4"/>`+path(`M${x+12-b*5} ${y+15} l5 5`,ink,'none',2);
 if(a.detail==='organizing')return paper+path(`M${x-7-b*3} ${y+8} l15 -2 l1 7 l-15 2 Z`,blue,'#e9e5f5',.7);
 // No known tool: focus stone, never random invented typing/search.
 return path(`M${x-10} ${y+16} q10 ${3-b*2} 20 0`,blue,'none',1)+path(`M${x} ${y+10-b*2} l4 4 l-4 4 l-4 -4 Z`,gold,'#fffaf0',.8);
}
export function portfolioArtwork(d:DesktopCompanionScene,side:'left'|'right'|null|undefined,now:number,cueAge:number,beats:ReadonlyMap<string,PortfolioBeat>,heldTransfer?:{cue:string;age:number},listen?:PortfolioListen|null,epoch=0):string {
 const p=d.portfolio;if(!p||!side)return '';
 const sign=side==='right'?1:-1,projects=p.projects.slice(0,3).filter(a=>Object.hasOwn(AGENT_AVATAR_ART,a.lead.avatar));
 const inspected=projects.find(a=>a.key===p.inspectedKey),subject=projects.find(a=>a.key===p.subjectKey),a=p.mode==='inspection'?inspected:['intake','result','attention'].includes(p.mode)?subject:inspected;
 const teams=p.teams??[],listening=listen&&projects.some(a=>a.key===listen.key)?listen:null;
 const u=listening?(d.reducedMotion?1:Math.min(1,Math.max(0,(now-listening.started)/160))):0,approach=listening?(listening.phase==='approach'?u:1-u):0,dock={x:side==='right'?250:42,y:128};let z='';
 for(const project of projects){
  const home=squadHome(project.label,side),team=['unknown','uncertain'].includes(project.status)?undefined:teams.find(t=>t.projectKey===project.key),reporting=listening?.key===project.key,travel=reporting?approach:0;
  const tucked=!!listening&&!reporting&&project.label==='B'&&approach>0,cx=home.x+(reporting?(dock.x-home.x)*travel:tucked?sign*(side==='right'?20:12)*approach:0),cy=home.y+(reporting?(dock.y-home.y)*travel:tucked?(side==='right'?12:19)*approach:0),size=tucked?40-14*approach:40;
  const b=workAccent(project,now,epoch,d.reducedMotion),change=beats.get(project.key),accent=change&&!d.reducedMotion?Math.sin(Math.PI*Math.min(1,Math.max(0,(now-change.at)/480))):0;
  z+=`<g data-project-slot="${project.label}" data-squad="${project.label}">`+path(`M${home.x-17} ${home.y+19} q17 8 34 0`,project.status==='needs-user'?gold:'#bac6d5','none',1)+path(`M${home.x-11} ${home.y+23} q11 3 22 0`,'#e0d7bf','none',.8);
  if(reporting&&travel>0)z+=path(`M${home.x} ${home.y+18} Q${home.x+sign*12} ${(home.y+cy)/2} ${cx} ${cy+17}`,'#b9c6d7','none',.6);
  let squadBadge='';
  if(team){const members=team.members.filter(m=>Object.hasOwn(AGENT_AVATAR_ART,m.avatar)).slice(0,3);
   if(listening&&!reporting&&approach>0){const bx=tucked?cx+sign*7:Math.max(14,Math.min(287,home.x+sign*25)),by=tucked?cy+7:home.y+36;squadBadge=`<circle cx="${bx}" cy="${by}" r="${tucked?4:5.5}" fill="#fffdf6" stroke="#aab9c9" stroke-width=".6"/>`+portfolioText(bx,by+2,team.overflowCount===null?'·':String(members.length+team.overflowCount),tucked?5.5:6);}
   else members.forEach((m,i)=>{const positions=[[Math.max(15,Math.min(280,home.x+sign*(side==='right'?30:26))),home.y-(project.label==='C'?7:22)],[Math.max(15,Math.min(project.label==='B'?284:280,home.x+sign*(side==='right'?30:26))),home.y+(project.label==='B'?13:23)],[home.x-sign*25,home.y+13]],pos=positions[i]!,mx=pos[0]!,my=pos[1]!;
    z+=`<g data-child-owner="${project.label}"><g opacity=".42">`+path(`M${mx} ${my} Q${(mx+home.x)/2} ${my+5} ${home.x} ${home.y+9}`,AGENT_AVATAR_ART[project.lead.avatar].color,'none',.7)+'</g>';
    if(accent>0&&project.status==='active'&&m.state==='running')z+=path(`M${mx} ${my} Q${(mx+home.x)/2} ${my-5*accent} ${home.x} ${home.y+7}`,'#a9bfd1','none',.6);
    z+=childArt(m.avatar,mx,my+(m.state==='running'?-accent*1.5:0));
    if(m.state==='waiting')z+=path(`M${mx-2} ${my+11} v3 M${mx+2} ${my+11} v3`,gold,'none',1);else if(m.state==='failed')z+=portfolioText(mx,my+14,'!',7);else if(m.state==='settling'||m.state==='leaving')z+=path(`M${mx-3} ${my+12} h6`,blue,'none',.8);
    z+='</g>';
   });
   if(count(team.overflowCount))z+=portfolioText(home.x+sign*27,home.y+37,'+'+count(team.overflowCount),6.5);
  }
  z+=`<g data-lead-position="${project.label}" data-center="${cx},${cy}">`+leadArt(project,cx,cy,size,b*(project.detail==='reading'?-3:2))+'</g>';z+=squadBadge;if(!tucked&&(!reporting||travel<.2))z+=workProp(project,cx,cy,b);
  if(reporting&&travel>0)z+=portfolioText(cx-sign*18,cy+18,project.label,7);
  if(project.notice)z+=noticeGlyph(project.notice,cx+(tucked?sign*7:-sign*18),cy-12,tucked?.65:.85);
  const status=project.status==='active'?(project.detail==='waiting'?'等待':'推进'):({settling:'收尾',result:'本轮结果',available:'待命','needs-user':project.notice==='permission'?'待授权':project.notice==='question'?'待回答':project.notice==='mixed'?'多项待办':'待你决定',uncertain:'待核查',unknown:'未知'}[project.status]);
  if(!tucked)z+=portfolioText(home.x,home.y+30,portfolioCaption(project.caption),7.5);
  z+=portfolioText(tucked?cx-sign*2:home.x,tucked?cy+19:home.y+39,project.label+' · '+(tucked?(project.notice==='permission'?'授权':project.notice==='question'?'答复':status==='推进'?'推进':'待办'):reporting&&travel>0?'汇报':status),6.5)+'</g>';
 }
 // Identified small summary; no large dossier remains to hide actual hands.
 if(a&&!['unknown','uncertain'].includes(a.status)&&(MANAGEMENT_CUES.has(d.cue)||(d.cue==='transition'&&heldTransfer))){const pose=managementPacketPose(heldTransfer?.cue??d.cue,heldTransfer?.age??cueAge,side,d.reducedMotion,squadHome(a.label,side));if(pose&&pose.opacity>0)z+=`<g data-summary-project="${a.label}" opacity="${pose.opacity}" transform="translate(${pose.x} ${pose.y})">`+path('M-13 -9 h26 v18 h-26 Z',blue,'url(#paper)',.9)+portfolioText(-7,-1,a.label,7)+path('M-1 -4 h10 M-1 0 h8 M-8 5 h17',blue,'none',.8)+'</g>';}
 if(count(p.overflowCards))z+=portfolioText(side==='right'?223:69,92,'+'+count(p.overflowCards),7);return z;
}
