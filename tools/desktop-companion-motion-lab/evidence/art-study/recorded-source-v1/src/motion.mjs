// Presentation only: no execution commands, timers, I/O, or runtime ownership.
export const modes = {
 idle:{head:-.035,gaze:0,lean:0,ask:0,type:0,lid:1,carry:0,grip:0,holdTilt:0},
 notice:{head:-.12,gaze:-1,lean:-.02,ask:0,type:0,lid:1,carry:0,grip:0,holdTilt:0},
 work:{head:.07,gaze:1,lean:.065,ask:0,type:1,lid:1,carry:0,grip:0,holdTilt:0},
 ask:{head:-.16,gaze:-1,lean:-.025,ask:1,type:0,lid:1,carry:0,grip:0,holdTilt:0},
 carry:{head:-.05,gaze:-.3,lean:0,ask:0,type:0,lid:0,carry:1,grip:1,holdTilt:1}
};
// Quintic boundary-value motion: preserve x/v/a on interruption; arrive at rest.
// C2, not C3: jerk may change at a target update. No numerical integrator.
export class Channel {
 constructor(x=0,omega=10){this.x=x;this.v=0;this.a=0;this._target=x;this.duration=6/omega;this.elapsed=this.duration;this.coeff=[x,0,0,0,0,0];}
 retime(duration){if(!Number.isFinite(duration)||duration<=0)throw Error('invalid duration');if(duration===this.duration)return;const target=this._target;this.duration=duration;this._target=undefined;this.target=target;}
 get target(){return this._target;}
 set target(value){if(!Number.isFinite(value))throw Error('invalid target');if(value===this._target)return;this._target=value;const T=this.duration,D=value-this.x,v=this.v*T,a=this.a*T*T;this.coeff=[this.x,v,a/2,10*D-6*v-1.5*a,-15*D+8*v+1.5*a,6*D-3*v-.5*a];this.elapsed=0;}
 advance(dt){if(!Number.isFinite(dt)||dt<0)throw Error('invalid dt');this.elapsed=Math.min(this.duration,this.elapsed+dt);const u=this.elapsed/this.duration,c=this.coeff;this.x=c.reduce((s,v,i)=>s+v*u**i,0);this.v=c.reduce((s,v,i)=>s+(i?i*v*u**(i-1):0),0)/this.duration;this.a=c.reduce((s,v,i)=>s+(i>1?i*(i-1)*v*u**(i-2):0),0)/(this.duration**2);if(this.elapsed===this.duration){this.x=this._target;this.v=0;this.a=0;}}
}
export const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*x*(10+x*(-15+6*x));};
export function ik(a,b,l1,l2,bend=1){const dx=b.x-a.x,dy=b.y-a.y,raw=Math.hypot(dx,dy),d=Math.max(.001,Math.min(l1+l2-.001,Math.max(Math.abs(l1-l2)+.001,raw))),angle=Math.atan2(dy,dx),c=Math.acos(Math.max(-1,Math.min(1,(l1*l1+d*d-l2*l2)/(2*l1*d))));return {elbow:{x:a.x+l1*Math.cos(angle+bend*c),y:a.y+l1*Math.sin(angle+bend*c)},hand:{x:a.x+d*Math.cos(angle),y:a.y+d*Math.sin(angle)},error:Math.abs(raw-d)};}
export class Motion {
 constructor(){this.time=0;this.mode='idle';this.channels=Object.fromEntries(Object.entries(modes.idle).map(([k,v])=>[k,new Channel(v,k==='gaze'?16:9)]));this.channels.lid.duration=.28;this.channels.grip.duration=.16;this.channels.holdTilt.duration=.38;this.channels.carry.duration=.42;this.plan=[];this.root={x:500,y:0};this.chair={x:500,y:0};this.drag=null;this.chairAlpha=1;this.drop=null;this.reduced=false;}
 setMode(mode){if(!modes[mode]||mode==='carry')throw Error('invalid semantic mode');this.mode=mode;if(!this.drag&&!this.drop)this.target(mode);}
 target(mode){for(const [k,v] of Object.entries(modes[mode]))this.channels[k].target=v;}
 patch(values){for(const [k,v]of Object.entries(values))this.channels[k].target=v;}
 beginDrag(x,y){
 this.drag={dx:this.root.x-x,dy:this.root.y-y,started:this.time,alphaStart:this.chairAlpha};this.drop=null;this.channels.carry.retime(.42);this.channels.ask.retime(.28);this.channels.type.retime(.12);
 const supported=this.channels.lid.x===0&&this.channels.grip.x===1;
 this.target('carry');
 if(supported){this.plan=[];return;}
 const closeDelay=this.channels.lid.x===0?0:.28;
 this.patch({carry:0,holdTilt:0});
 if(closeDelay)this.channels.grip.target=0;
 this.plan=[{at:this.time+closeDelay,values:{grip:1}},{at:this.time+closeDelay+.16,values:{holdTilt:1,carry:1}}];
 }
 moveDrag(x,y){if(this.drag){this.root.x=x+this.drag.dx;this.root.y=y+this.drag.dy;}}
 endDrag(){if(!this.drag)return;this.drag=null;
 const samePlace=Math.hypot(this.root.x-this.chair.x,this.root.y-this.chair.y)<.01;
 const alphaStart=samePlace?this.chairAlpha:0;
 if(!samePlace&&this.chairAlpha>0)this.ghostChair={...this.chair,alphaStart:this.chairAlpha,alpha:this.chairAlpha,started:this.time};
 this.channels.carry.retime(.24);this.chair={...this.root};this.chairAlpha=alphaStart;this.drop={started:this.time,alphaStart};this.plan=[{at:this.time+.28,values:{carry:0}},{at:this.time+.52,values:{holdTilt:0}},{at:this.time+.90,values:{grip:0}},{at:this.time+1.06,values:{lid:1}},{at:this.time+1.34,resume:true}];}

 advance(dt){
 if(!Number.isFinite(dt)||dt<0)throw Error('invalid dt');const end=this.time+dt;
 const step=to=>{const d=to-this.time;for(const c of Object.values(this.channels))c.advance(d);this.time=to;};
 while(this.plan.length&&this.plan[0].at<=end){const event=this.plan.shift();step(event.at);if(event.resume){this.drop=null;this.channels.ask.retime(6/9);this.channels.type.retime(6/9);this.target(this.mode);}else this.patch(event.values);}
 step(end);
 if(this.drag)this.chairAlpha=this.drag.alphaStart*(1-smooth((this.time-this.drag.started)/.3));
 else if(this.drop)this.chairAlpha=this.drop.alphaStart+(1-this.drop.alphaStart)*smooth((this.time-this.drop.started)/.28);
 else this.chairAlpha=1;
 if(this.ghostChair){this.ghostChair.alpha=this.ghostChair.alphaStart*(1-smooth((this.time-this.ghostChair.started)/.15));if(this.ghostChair.alpha===0)this.ghostChair=null;}
 }

 pose(){const p=Object.fromEntries(Object.entries(this.channels).map(([k,v])=>[k,v.x]));const t=this.time;
 const breath=this.reduced?0:Math.sin(t*1.7)*2;
 // Deterministic asymmetric blink, smooth eyelid motion; no frame-count timers.
 const bt=t%4.7;const blink=this.reduced?0:(bt>3.7&&bt<3.98?Math.sin((bt-3.7)/.28*Math.PI)**2:0);
 const phase=t%4;const gate=(smooth((phase-.25)/.15)*(1-smooth((phase-1.1)/.16))+smooth((phase-1.7)/.13)*(1-smooth((phase-2.65)/.18)));const typing=this.reduced?0:p.type*(this.study?1:gate);const lift=70*p.carry;
 const torso={x:500+Math.sin(p.lean)*100,y:470-lift+breath};
 const leftShoulder={x:torso.x-70,y:torso.y-20},rightShoulder={x:torso.x+70,y:torso.y-20};
 // One projected laptop plane is authoritative for both drawing and hand contacts.
 const laptop={x:490,y:610-40*p.holdTilt-70*p.carry,depth:26+94*p.holdTilt};
 laptop.project=(u,v)=>({x:laptop.x+(u-.5)*(200+30*v*(1-p.holdTilt)),y:laptop.y-laptop.depth*(1-v)});
 laptop.quad=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>laptop.project(u,v));
 const leftContact=laptop.project(.28+(.03-.28)*p.grip,.7+(.84-.7)*p.grip),rightContact=laptop.project(.72+(.97-.72)*p.grip,.7+(.84-.7)*p.grip);
 const leftTarget={x:leftContact.x,y:leftContact.y-typing*(1+Math.sin(t*10))*2};
 const rightTarget={x:rightContact.x+70*p.ask,y:rightContact.y-110*p.ask-typing*(1+Math.sin(t*11+1))*2};
 return {...p,time:t,breath,blink,torso,lift,laptop,leftContact,rightContact,leftShoulder,rightShoulder,left:ik(leftShoulder,leftTarget,100,100,1),right:ik(rightShoulder,rightTarget,100,100,-1),hair:this.reduced?0:Math.sin(t*1.7-.65)*.018+p.head*.22,skirt:this.reduced?0:Math.sin(t*1.7-1)*.012};
 }
}
export const sequence=[{at:0,mode:'idle'},{at:2,mode:'notice'},{at:3.1,mode:'work'},{at:7,mode:'ask'},{at:10,mode:'work'}];
export function sampleTimeline(time){const m=new Motion();let last=0;for(const e of sequence){if(e.at>time)break;m.advance(e.at-last);m.setMode(e.mode);last=e.at;}m.advance(time-last);return m;}
// Hidden time intentionally freezes decoration. Semantic observations may still update targets.
export class VisualClock {constructor(){this.last=null;this.hidden=false;}tick(now){const dt=this.last===null||this.hidden?0:Math.max(0,(now-this.last)/1000);this.last=now;return dt;}setHidden(value){this.hidden=value;this.last=null;}}
export const study8=[{at:0,mode:'idle'},{at:1.2,patch:{gaze:-1}},{at:1.3,patch:{head:-.07,lean:-.01}},{at:2.45,patch:{head:.025}},{at:2.66,patch:{head:-.05}},{at:2.85,patch:{gaze:1}},{at:2.95,patch:{head:.025,lean:.014}},{at:3.55,patch:{type:1}},{at:4.42,patch:{type:0}},{at:4.85,patch:{type:1}},{at:5.9,patch:{type:0}},{at:6.3,mode:'idle'}];
export function applyEvent(m,e){if(e.mode)m.setMode(e.mode);if(e.patch)for(const [k,v] of Object.entries(e.patch))m.channels[k].target=v;}
export function sampleStudy(time){const m=new Motion();m.study=true;let last=0;for(const e of study8){if(e.at>time)break;m.advance(e.at-last);applyEvent(m,e);last=e.at;}m.advance(time-last);return m;}
// Screen-space threshold, independent of canvas zoom / device-pixel ratio.
export class DragIntent {
 constructor(threshold=6){this.threshold=threshold;this.pending=null;this.active=false;}
 down(x,y){this.pending={x,y};this.active=false;}
 move(x,y){if(!this.pending)return false;if(!this.active&&Math.hypot(x-this.pending.x,y-this.pending.y)>=this.threshold){this.active=true;return true;}return false;}
 end(){const was=this.active;this.pending=null;this.active=false;return was;}
}
