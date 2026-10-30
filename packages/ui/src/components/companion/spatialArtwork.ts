import type { DesktopCompanionScene } from '@varin/application-client';
import type { CompanionSpatialLayout } from '@varin/application-client/desktop';
import { leadArt, childArt, workAccent, workProp, noticeGlyph, portfolioText as text, portfolioCaption, managementDossierDock, managementDossierPose, managementDossierArt, portfolioFocalKey, type PortfolioListen } from './portfolioArtwork';

/** Only actual native geometry receipts enter this renderer. The rear layer is
 * separately alpha-masked by sceneRenderer against the last successful drawing. */
export function spatialArtwork(d:DesktopCompanionScene, layout:CompanionSpatialLayout, side:'left'|'right'|null|undefined, now:number, epoch:number, listen:PortfolioListen|null, transfer?:{cue:string;age:number}) {
 const p=d.portfolio;if(!p)return {behind:'',front:''};
 let behind='',front='';
 const progress=listen?(d.reducedMotion?1:Math.min(1,Math.max(0,(now-listen.started)/160))):0;
 const travel=listen?(listen.phase==='approach'?progress:1-progress):0;
 const reporter=p.projects.find(a=>a.key===listen?.key);
 const dock=side?{x:side==='left'?42:250,y:128}:null;
 for(const seat of layout.seats){
  const project=p.projects.find(a=>a.label===seat.label);if(!project)continue;
  const team=['unknown','uncertain'].includes(project.status)?undefined:p.teams?.find(t=>t.projectKey===project.key);
  const reporting=project.key===reporter?.key&&!!dock;
  // Rear A yields locally when another captain uses the right reporting dock.
  const yielding=seat.label==='A'&&!!reporter&&reporter.label!=='A'&&side==='right'&&travel>0;
  const yieldX=yielding?Math.min(12,layout.available.right-seat.bounds.right)*travel:0;
  const yieldY=yielding?-28*travel:0;
  let x=seat.home.x+yieldX,y=seat.home.y+yieldY;
  if(reporting&&dock){
   const u=travel,v=1-u;
   const sameSide=(seat.home.x<150)===(side==='left');
   // Outside arc, never a straight chord across Varin's face/laptop.
   const bendX=side==='left'?Math.min(seat.home.x,42):Math.max(seat.home.x,258);
   if(sameSide){x=v*v*seat.home.x+2*v*u*bendX+u*u*dock.x;y=v*v*seat.home.y+2*v*u*seat.home.y+u*u*dock.y;}
   else { // A constrained opposite-side receipt cannot safely move a captain through the actor.
    x=seat.home.x;y=seat.home.y;
   }
  }
  const size=seat.size*(yielding?1-.2*travel:1),b=workAccent(project,now,epoch,d.reducedMotion||!!portfolioFocalKey(d)&&project.key!==portfolioFocalKey(d));
  let z=`<g data-spatial-squad="${seat.label}"><ellipse cx="${seat.shadow.x}" cy="${seat.shadow.y}" rx="${seat.shadow.rx}" ry="${seat.shadow.ry}" fill="#52627d" opacity="${seat.shadow.opacity}"/>`;
  if(reporting&&travel>0)z+=`<path d="M${seat.home.x} ${seat.home.y} Q${x} ${seat.home.y} ${x} ${y}" fill="none" stroke="#a7b7cd" stroke-width=".65" stroke-dasharray="2 3"/>`;
  if(team){
   if(seat.childrenVisible&&!yielding)team.members.slice(0,3).forEach((member,i)=>{
    const q=seat.children[i];if(!q)return;
    const active=project.status==='active'&&member.state==='running',a=active?b:0;
    z+=`<g data-child-owner="${seat.label}" data-child-key="${i}"><path d="M${q.x} ${q.y} Q${(q.x+seat.home.x)/2} ${q.y+3} ${seat.home.x} ${seat.home.y}" fill="none" stroke="#a9bbcc" stroke-width=".6" opacity="${.25+a*.3}"/>`+childArt(member.avatar,q.x,q.y-a,seat.childSize);
    if(member.state==='waiting')z+=text(q.x,q.y+seat.childSize*.7,'Ⅱ',5);
    else if(member.state==='failed')z+=text(q.x,q.y+seat.childSize*.7,'!',6);
    z+='</g>';
   });
   const count=team.overflowCount===null?null:team.members.length+team.overflowCount;
   if(!seat.childrenVisible||yielding){if(team.members.length)z+=text(x+size*.55,y+size*.4,count===null?'队·':'队'+count,6);}
   else if(team.overflowCount&&team.overflowCount>0)z+=text(seat.home.x+size*.6,seat.home.y-size*.55,'+'+team.overflowCount,6);
  }
  z+=`<g data-lead-position="${seat.label}" data-center="${x},${y}">`+leadArt(project,x,y,size,b*2)+'</g>';
  if(!reporting&&!yielding)z+=`<g transform="translate(${x} ${y}) scale(${size/40})">`+workProp(project,0,0,b)+'</g>';
  if(project.notice)z+=noticeGlyph(project.notice,x-size*.43,y-size*.32,.7);
  const status=project.status==='active'?(project.detail==='waiting'?'等待':'推进'):({settling:'收尾',result:'本轮结果',available:'待命','needs-user':project.notice==='permission'?'待授权':project.notice==='question'?'待回答':'待你决定',uncertain:'待核查',unknown:'未知'}[project.status]);
  let labels='';
  if(yielding)labels+=text(x,y+size*.7,project.label+' · '+status,6);
  else labels+=text(seat.home.x,seat.captionY,portfolioCaption(project.caption,seat.captionBudget),7)+text(seat.home.x,seat.statusY,project.label+' · '+status,6.5);
  if(reporting&&travel>0)labels+=text(x+(side==='left'?16:-16),y+12,project.label,7);
  z+='</g>';
  if(seat.layer==='behind'&&!reporting){behind+=z;front+=labels;}else front+=z+labels;
 }
 const subject=p.projects.find(a=>a.key===(p.mode==='inspection'?p.inspectedKey:p.subjectKey));
 const dockForDossier=managementDossierDock(side,layout.available,layout.seats.map(seat=>seat.bounds));
 if(subject&&dockForDossier&&transfer&&!['unknown','uncertain'].includes(subject.status)){
  const pose=managementDossierPose(transfer.cue,transfer.age,dockForDossier,d.reducedMotion);
  if(pose&&pose.opacity>0)front+=managementDossierArt(subject.label,pose);
 }
 return {behind,front};
}
