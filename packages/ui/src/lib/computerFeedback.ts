/** Shared, presentation-only surface for the desktop viewer and Electron's click-through windows.
 * No preload, credentials, typed content, capture loop or native input lives here. */
export const COMPUTER_FEEDBACK_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;font:12px system-ui;color:#e8fbfc}
#cursor{position:absolute;left:0;top:0;opacity:0;transition:transform 160ms cubic-bezier(.2,.8,.2,1),opacity 160ms;filter:drop-shadow(0 1px 3px #0008)}
#cursor.drag{transition:transform 35ms linear,opacity 160ms}#cursor svg{width:23px;height:27px;overflow:visible}
#label,#badge{position:absolute;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;border:1px solid #a5edf52e;background:#192a30e8;border-radius:6px;padding:4px 7px;box-shadow:0 3px 12px #0003}
#label{left:20px;top:23px;font-size:10px;color:#b9e6e8}#badge{opacity:0;transition:opacity 140ms,transform 160ms}
#badge.failed{color:#f0b4ae;border-color:#dc82795c;background:#352422ed}
#badge.typing::after{content:'•••';margin-left:7px;letter-spacing:2px;animation:typing 900ms ease-in-out infinite}
#badge.key-press{animation:key-press 260ms ease-out}
@keyframes typing{50%{opacity:.25}}@keyframes key-press{0%{background:#42636bed;box-shadow:0 0 14px #85dae36b}100%{background:#192a30e8}}
#target{position:absolute;opacity:0;border:1px solid #8cdae28c;border-radius:6px;box-shadow:0 0 15px #7bd5df30,inset 0 0 12px #7bd5df10;box-sizing:border-box;transition:opacity 160ms}
.ripple{position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;border:1.5px solid #96e9f0;background:#7bd5df24;box-shadow:0 0 16px #85dae34d;animation:ripple 620ms ease-out forwards}
@keyframes ripple{to{transform:scale(2.3);opacity:0}}@media(prefers-reduced-motion:reduce){#cursor,#badge{transition:opacity 120ms}.ripple{animation-duration:160ms}#badge.typing::after,#badge.key-press{animation:none}}
</style></head><body><div id="target"></div><div id="cursor"><svg viewBox="0 0 23 27"><path d="M3 2 3 22 8.5 16.5 12 25 15.5 23.5 12 15 20 15Z" fill="#8ad7e1" stroke="#e1fafb" stroke-width="1.3" stroke-linejoin="round"/></svg><span id="label"></span></div><div id="badge"></div>
<script>
const cursor=document.getElementById('cursor'),target=document.getElementById('target'),badge=document.getElementById('badge'),label=document.getElementById('label');
let config={bounds:{x:0,y:0,width:1,height:1},labels:{}},current=null,point=null,timer=null;
function geometry(){const b=config.bounds,s=config.fit===false?1:Math.min(innerWidth/b.width,innerHeight/b.height,config.upscale===false?1:Infinity);return {s,x:(innerWidth-b.width*s)/2-b.x*s,y:(innerHeight-b.height*s)/2-b.y*s}}
function mapped(p){const g=geometry();return{x:p.x*g.s+g.x,y:p.y*g.s+g.y}}
function clear(){clearTimeout(timer);current=null;cursor.style.opacity=target.style.opacity=badge.style.opacity='0';document.querySelectorAll('.ripple').forEach(n=>n.remove())}
function draw(){if(!current)return;const e=current;if(e.point){point=mapped(e.point);cursor.classList.toggle('drag',e.kind==='drag');cursor.style.transform='translate('+point.x+'px,'+point.y+'px)';cursor.style.opacity='1';label.textContent=e.actorLabel||'Agent'}
 if(e.target){const p=mapped(e.target),g=geometry();Object.assign(target.style,{left:p.x+'px',top:p.y+'px',width:e.target.width*g.s+'px',height:e.target.height*g.s+'px',opacity:e.kind==='type'||e.kind==='key'||e.kind==='set_value'||e.kind==='secondary'?'.85':'0'})}
 badge.classList.toggle('failed',e.phase==='failed');
 badge.classList.toggle('typing',e.kind==='type'&&e.phase!=='completed'&&e.phase!=='failed');badge.classList.toggle('key-press',e.kind==='key'&&e.phase!=='target'&&e.phase!=='failed');
 if(['type','key','set_value','scroll'].includes(e.kind)||e.phase==='failed'){let p=e.point?mapped(e.point):e.target?mapped({x:e.target.x+e.target.width/2,y:e.target.y+Math.min(28,e.target.height/2)}):point||{x:innerWidth/2,y:32};badge.textContent=e.phase==='failed'?config.labels.failed||'×':e.kind==='key'?e.key||'Key':config.labels[e.kind]||e.kind;Object.assign(badge.style,{transform:'translate('+Math.max(4,Math.min(p.x+18,innerWidth-145))+'px,'+Math.max(4,Math.min(p.y+22,innerHeight-36))+'px)',opacity:'1'})}}
window.computerFeedback=function(message){if(message.type==='configure'){config=message;draw();return}if(message.type==='clear'){clear();return}const e=message.gesture;if(!e)return;if(e.phase==='cancelled'){clear();return}
 clearTimeout(timer);const same=current&&current.id===e.id;if(e.phase==='failed'&&!same&&!e.point&&!e.target){clear();return}if(!same){target.style.opacity=badge.style.opacity='0'}current=same?Object.assign({},current,e):e;draw();
 if(e.phase==='dispatched'&&current.point&&(e.kind==='click'||e.kind==='secondary')&&(!same||!current.ripple)){const p=mapped(current.point),n=document.createElement('div');n.className='ripple';n.style.left=p.x+'px';n.style.top=p.y+'px';document.body.appendChild(n);n.addEventListener('animationend',()=>n.remove());current.ripple=true}
 if(e.phase==='completed'||e.phase==='failed')timer=setTimeout(clear,850)};
addEventListener('message',e=>{if(e.source===parent)window.computerFeedback(e.data)});addEventListener('resize',draw);
</script></body></html>`;
