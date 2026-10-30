import fs from 'node:fs';import {createRequire} from 'node:module';
import {projectLeadSvg} from '../../varin-main-20261028/packages/ui/src/components/companion/projectLeadArt';
import {agentAvatarSvg} from '../../varin-main-20261028/packages/ui/src/components/ui/agent-avatar-art';
const ROOT=import.meta.dir,repo='/workspace/scratch/d33c4ad65693/varin-main-20261028',sharp=createRequire(repo+'/package.json')('sharp');sharp.concurrency(1);sharp.cache(false);
const actorPath=repo+'/docs/design/desktop-companion-assets/animation-source/production-v2/shared/upright-open-neutral-v2.png',actor='data:image/png;base64,'+fs.readFileSync(actorPath).toString('base64');
const ink='#4c5268',muted='#82909f',gold='#c7a56c';
const path=(d:string,fill='none',stroke=ink,width=1)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const tx=(x:number,y:number,s:string,size=14,c=ink,anchor='start')=>`<text x="${x}" y="${y}" font-family="Noto Sans CJK SC,system-ui" font-size="${size}" fill="${c}" text-anchor="${anchor}">${s}</text>`;
type Squad={id:'A'|'B'|'C';x:number;y:number;size:number;depth:'back'|'front';children:[number,number][];tool:'book'|'lens'|'pen'};
const art={A:'ribbon-blue',B:'scoop-pistachio',C:'overlap-coral'} as const,children={A:['lens-lilac','ripple-peach'],B:['capsule-sky','pillar-lilac'],C:['orbit-sage','tile-blue']} as const;
function team(s:Squad){const scale=s.size/64,ground=s.y+s.size*.55,childSize=Math.round(s.size*.45),far=s.depth==='back';
 let z=`<g data-project="${s.id}" data-depth="${s.depth}">`;
 z+=`<ellipse cx="${s.x}" cy="${ground}" rx="${s.size*.45}" ry="${s.size*.095}" fill="#77899b" opacity="${far?.13:.19}" filter="url(#ground-shadow)"/>`;
 s.children.forEach(([dx,dy],i)=>{const cx=s.x+dx,cy=s.y+dy;z+=`<ellipse cx="${cx}" cy="${cy+childSize*.56}" rx="${childSize*.4}" ry="${childSize*.1}" fill="#8193a4" opacity=".13" filter="url(#child-shadow)"/>`;
 z+=`<g opacity=".26">`+path(`M${s.x} ${ground-4} Q${(s.x+cx)/2} ${Math.max(ground,cy+childSize*.6)+7} ${cx} ${cy+childSize*.56}`,'none','#9cadc2',.8)+'</g>';
 z+=agentAvatarSvg(children[s.id][i]!).replace('<svg ',`<svg x="${cx-childSize/2}" y="${cy-childSize/2}" width="${childSize}" height="${childSize}" `);
 });
 z+=projectLeadSvg(art[s.id],s.x-s.size/2,s.y-s.size/2,s.size);
 const px=s.x+9*scale,py=s.y+18*scale;
 z+=`<g transform="translate(${px} ${py}) scale(${scale})">`+path('M-17 -1 q17 -5 34 0 l-3 12 q-15 -4 -32 0 Z','#fffaf0','#9aaec1',.9);
 if(s.tool==='book')z+=path('M-1 -3 v13 M-13 3 h8 M4 3 h9','none','#8faec5',1)+path('M1 -2 q7 -8 14 -1 l-2 8 q-4 -8 -12 -7','#fffdf7','#b6c4cf',.7);
 if(s.tool==='lens')z+='<circle cx="7" cy="1" r="9" fill="#e6f4f8" fill-opacity=".7" stroke="#c7a56c" stroke-width="2"/>'+path('M13 8 l7 7','none',ink,2.5);
 if(s.tool==='pen')z+=path('M6 8 l13 -23 l4 3 l-14 24 Z','#fff7e0',gold,1.2);
 z+='</g>';
 // Tiny provenance letter is supplementary; the characters remain the headline.
 z+=tx(s.x,ground+16,s.id,10,muted,'middle')+'</g>';return z;
}
const variants=[
 {id:'A',name:'开口议事圈',tag:'后侧两组 · 身前一组',note:'最均衡：Varin 像围坐中的主管，三队各有清楚的工作落点。',teams:[{id:'A',x:112,y:238,size:56,depth:'back',children:[[-35,-18],[23,34]],tool:'book'},{id:'B',x:490,y:246,size:56,depth:'back',children:[[35,-19],[35,23]],tool:'lens'},{id:'C',x:300,y:402,size:76,depth:'front',children:[[-61,8],[61,17]],tool:'pen'}]},
 {id:'B',name:'错层拥簇',tag:'后方一组 · 前侧两组',note:'围绕感更强：前景团子更亲近，适合开阔桌面。',teams:[{id:'A',x:477,y:190,size:48,depth:'back',children:[[32,-15],[20,32]],tool:'book'},{id:'B',x:172,y:391,size:70,depth:'front',children:[[-53,-6],[28,38]],tool:'lens'},{id:'C',x:431,y:397,size:74,depth:'front',children:[[-30,39],[56,-4]],tool:'pen'}]},
 {id:'C',name:'贴身浅弧',tag:'低位收拢 · 保留前后',note:'窄桌边版本：不是竖排列表，也不把小队推到面部周围。',teams:[{id:'A',x:106,y:291,size:52,depth:'back',children:[[-30,-18],[21,29]],tool:'book'},{id:'B',x:492,y:299,size:52,depth:'back',children:[[29,-18],[24,31]],tool:'lens'},{id:'C',x:300,y:404,size:62,depth:'front',children:[[-43,8],[43,13]],tool:'pen'}]},
] as const;
const defs=`<defs><filter id="ground-shadow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="3"/></filter><filter id="child-shadow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="1.5"/></filter><radialGradient id="floor"><stop stop-color="#c8d4df" stop-opacity=".28"/><stop offset="1" stop-color="#d9e2eb" stop-opacity="0"/></radialGradient></defs>`;
function stage(v:typeof variants[number]){return defs+`<ellipse cx="300" cy="408" rx="250" ry="78" fill="url(#floor)"/>`+v.teams.filter(t=>t.depth==='back').map(t=>team(t as unknown as Squad)).join('')+`<image href="${actor}" x="120" y="36" width="360" height="360"/>`+v.teams.filter(t=>t.depth==='front').map(t=>team(t as unknown as Squad)).join('');}
for(const v of variants){const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="520"><rect width="600" height="520" fill="#eef2f6"/>${stage(v)}</svg>`;fs.writeFileSync(ROOT+`/layout-${v.id}.svg`,svg);await sharp(Buffer.from(svg)).png().toFile(ROOT+`/layout-${v.id}.png`);}
let board=tx(34,45,'Varin · 围坐式小队舞台',29)+tx(35,74,'2.5D 空间构图比较 · 原2D人物与同一套领队身份 · 设计原型，非完整运行版',14,muted);
variants.forEach((v,i)=>{const x=26+i*620;board+=`<g transform="translate(${x} 102)"><rect width="600" height="520" rx="22" fill="#eef2f6"/>${stage(v)}</g>`+tx(x+5,654,v.id+'  '+v.name,23)+tx(x+5,680,v.tag,14,muted)+tx(x+5,706,v.note,13,ink);});
board+=tx(35,750,'共同规则：稳定队位，不绕圈公转；近大远小、柔和落影、前后遮挡只触及椅脚/衣摆边缘；脸、手、笔电完整留白。',14,muted);
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1890" height="780"><rect width="1890" height="780" fill="#f8fafc"/>${board}</svg>`)).png().toFile(ROOT+'/spatial-layout-comparison.png');
fs.writeFileSync(ROOT+'/layout-spec.json',JSON.stringify({actor:{source:actorPath,x:120,y:36,width:360,height:360},variants},null,2));console.log('Three actual-resource spatial prototypes rendered.');

export {variants,stage,team,defs,tx,path,actor,actorPath};
