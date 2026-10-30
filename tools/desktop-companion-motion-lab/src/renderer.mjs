const colors={line:'#596779',hair:'#ccd2df',hairShade:'#aab8d0',skin:'#f1d8cd',coat:'#e6e5e3',blue:'#96b6da',dark:'#414655'};
export class Renderer {
 constructor(canvas){this.canvas=canvas;this.ctx=canvas.getContext('2d');this.layers=[];}
 async load(manifest,base=location.href){if(manifest.version!==1||manifest.profile!=='seated-study'||!Array.isArray(manifest.layers))throw Error('Unsupported layer manifest');const nodes=new Set(['chair','lowerBody','torso','head','hairBack','hairFront','upperArmL','forearmL','handL','upperArmR','forearmR','handR','laptopBase','laptopLid','eyes','mouth']);const missing=[...nodes].filter(node=>!manifest.layers.some(layer=>layer.node===node));if(missing.length)throw Error('Incomplete rig: '+missing.join(', '));const loaded=await Promise.all(manifest.layers.map(async layer=>{if(!nodes.has(layer.node)||!Array.isArray(layer.pivot)||layer.pivot.length!==2||!layer.pivot.every(x=>Number.isFinite(x)&&x>=0&&x<=1)||!Array.isArray(layer.size)||layer.size.length!==2||!layer.size.every(x=>Number.isFinite(x)&&x>0))throw Error('Invalid layer geometry');const url=new URL(layer.src,base);if(url.origin!==location.origin)throw Error('Only same-origin assets accepted');const img=new Image();img.src=url.href;await img.decode();return {...layer,img};}));this.layers=loaded;}
 clear(){this.layers=[];}
 draw(m,debug=true){const c=this.ctx,p=m.pose();c.clearRect(0,0,1000,900);
 const ellipse=(x,y,rx,ry,fill,angle=0)=>{c.beginPath();c.ellipse(x,y,rx,ry,angle,0,Math.PI*2);c.fillStyle=fill;c.fill();c.strokeStyle=colors.line;c.lineWidth=2;c.stroke();};
 const poly=(pts,fill)=>{c.beginPath();pts.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=fill;c.fill();c.strokeStyle=colors.line;c.lineWidth=2;c.stroke();};
 const line=(a,b,width,color)=>{c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.lineWidth=width;c.lineCap='round';c.strokeStyle=color;c.stroke();};
 const node=(x,y,angle=0)=>({x,y,angle});const angle=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x)-Math.PI/2;
 const nodes={chair:node(m.chair.x,700+m.chair.y),lowerBody:node(m.root.x,650+m.root.y-p.lift),torso:node(m.root.x+p.torso.x-500,p.torso.y+m.root.y,p.lean),head:node(m.root.x+p.torso.x-500,310-p.lift+p.breath+m.root.y,p.head),hairBack:node(m.root.x+p.torso.x-500,310-p.lift+p.breath+m.root.y,p.hair),hairFront:node(m.root.x+p.torso.x-500,310-p.lift+p.breath+m.root.y,p.head+p.hair*.3),laptopBase:node(m.root.x+p.laptop.x-500,p.laptop.y+m.root.y),laptopLid:node(m.root.x+p.laptop.x-500,p.laptop.y+m.root.y),eyes:node(m.root.x+p.torso.x-500,310-p.lift+p.breath+m.root.y,p.head),mouth:node(m.root.x+p.torso.x-500,310-p.lift+p.breath+m.root.y,p.head)};
 for(const [side,key] of [['L','left'],['R','right']]){const shoulder=p[key+'Shoulder'],arm=p[key];nodes['upperArm'+side]=node(m.root.x+shoulder.x-500,shoulder.y+m.root.y,angle(shoulder,arm.elbow));nodes['forearm'+side]=node(m.root.x+arm.elbow.x-500,arm.elbow.y+m.root.y,angle(arm.elbow,arm.hand));nodes['hand'+side]=node(m.root.x+arm.hand.x-500,arm.hand.y+m.root.y);}
 // Independent world-space stool. Never inside character root transform.
 if(!this.layers.length){const stool=(chair,alpha)=>{c.globalAlpha=alpha;ellipse(chair.x,817+chair.y,135,16,'#111a26');poly([[chair.x-68,700+chair.y],[chair.x-58,803+chair.y],[chair.x-43,803+chair.y],[chair.x-38,700+chair.y]],'#383f4c');poly([[chair.x+68,700+chair.y],[chair.x+58,803+chair.y],[chair.x+43,803+chair.y],[chair.x+38,700+chair.y]],'#383f4c');ellipse(chair.x,690+chair.y,112,32,'#536073');c.globalAlpha=1;};if(m.ghostChair)stool(m.ghostChair,m.ghostChair.alpha);stool(m.chair,m.chairAlpha);}
 if(this.layers.length){for(const layer of this.layers){const n=nodes[layer.node];c.save();c.translate(n.x,n.y);c.rotate(n.angle);if(layer.node==='chair')c.globalAlpha=m.chairAlpha;if(layer.node==='laptopLid')c.scale(1,.06+.94*p.lid);if(layer.node==='eyes')c.scale(1,1-.94*p.blink);c.drawImage(layer.img,-layer.pivot[0]*layer.size[0],-layer.pivot[1]*layer.size[1],...layer.size);c.restore();}}
 else{
 c.save();c.translate(m.root.x-500,m.root.y);
 // Hair silhouette with independent lower follow-through, not whole-image bobbing.
 c.save();c.translate(p.torso.x,320-p.lift+p.breath);c.rotate(p.hair);ellipse(-88,170,77,218,colors.hairShade,-.16);ellipse(90,170,77,218,colors.hairShade,.16);c.restore();
 const ly=650-p.lift;line({x:463,y:ly},{x:448,y:770-p.lift},35,colors.skin);line({x:531,y:ly},{x:542,y:770-p.lift},35,colors.skin);ellipse(437,790-p.lift,35,25,colors.dark,-.1);ellipse(543,790-p.lift,35,25,colors.dark,.1);
 c.save();c.translate(500,ly);c.rotate(p.skirt);poly([[-80,-65],[72,-65],[116,75],[30,105],[-110,75]],colors.blue);poly([[-80,-65],[72,-65],[105,65],[32,42],[-72,85],[-102,52]],colors.dark);c.restore();
 poly([[p.torso.x-67,p.torso.y-47],[p.torso.x+64,p.torso.y-47],[557,600-p.lift],[443,600-p.lift]],colors.blue);
 poly([[p.torso.x-70,p.torso.y-48],[p.torso.x-35,p.torso.y-38],[450,615-p.lift],[398,600-p.lift]],colors.coat);poly([[p.torso.x+70,p.torso.y-48],[p.torso.x+35,p.torso.y-38],[550,615-p.lift],[600,600-p.lift]],colors.coat);
 for(const key of ['left','right']){const shoulder=p[key+'Shoulder'],arm=p[key];line(shoulder,arm.elbow,55,colors.coat);line(arm.elbow,arm.hand,44,colors.coat);}
 c.save();c.translate(p.torso.x,310-p.lift+p.breath);c.rotate(p.head);ellipse(0,-10,120,130,colors.hair);ellipse(0,25,100,91,colors.skin);poly([[-113,-23],[-80,-108],[20,-124],[110,-56],[98,9],[62,-4],[33,25],[8,-18],[-21,22],[-52,-10],[-86,31]],colors.hair);ellipse(109,6,34,38,colors.hairShade);poly([[74,-84],[100,-91],[91,-62],[112,-62],[93,-37],[70,-37],[85,-61],[63,-61]],colors.dark);poly([[86,-73],[105,-72],[96,-52],[78,-51]],colors.blue);
 for(const x of [-43,43]){ellipse(x,37,22,Math.max(1,13*(1-p.blink)), '#f5f1ed');ellipse(x+p.gaze*2,39+p.gaze*2,10,Math.max(.4,10*(1-p.blink)),'#769bc2');line({x:x-22,y:32},{x:x+20,y:28},3,colors.line);line({x:x-18,y:10-p.ask*5},{x:x+13,y:8},2,colors.line);}c.beginPath();c.moveTo(-9,73);c.quadraticCurveTo(0,80+p.ask*4,10,72);c.lineWidth=2;c.strokeStyle='#ae7d77';c.stroke();c.restore();
 const l=p.laptop;poly(l.quad.map(q=>[q.x,q.y]),'#505b70');
 // Closed lid shares the same plane, then hinges away; carrying tilts the CLOSED plane.
 const [a,b,d,e]=l.quad;const farY=l.y-l.depth-120*p.lid;
 const lid=[{x:a.x,y:a.y},{x:b.x,y:b.y},{x:d.x+(b.x-15-d.x)*p.lid,y:d.y+(farY-d.y)*p.lid},{x:e.x+(a.x-17-e.x)*p.lid,y:e.y+(farY-e.y)*p.lid}];
 poly(lid.map(q=>[q.x,q.y]),'#343d50');const center=lid.reduce((s,q)=>({x:s.x+q.x/4,y:s.y+q.y/4}),{x:0,y:0});ellipse(center.x,center.y,9,Math.max(2,(l.depth*(1-p.lid)+120*p.lid)/24),'#778397');
 for(const key of ['left','right']){const hand=p[key].hand;ellipse(hand.x,hand.y,19,11,colors.skin,key==='right'?-p.ask*.4:.1);}
 c.restore();}
 if(debug){c.save();c.translate(m.root.x-500,m.root.y);for(const key of ['left','right']){const a=p[key+'Shoulder'],b=p[key].elbow,h=p[key].hand;line(a,b,1,'#f1bd75');line(b,h,1,'#f1bd75');for(const q of [a,b,h])ellipse(q.x,q.y,4,4,'#f1bd75');}c.restore();c.strokeStyle='#8ab8b3';c.lineWidth=1;c.setLineDash([4,5]);c.beginPath();c.moveTo(m.chair.x-140,700+m.chair.y);c.lineTo(m.chair.x+140,700+m.chair.y);c.stroke();c.setLineDash([]);c.font='12px monospace';c.fillStyle='#9cb6d5';c.fillText('STOOL / WORLD ANCHOR',m.chair.x-130,735+m.chair.y);}
 return p;
 }
}
