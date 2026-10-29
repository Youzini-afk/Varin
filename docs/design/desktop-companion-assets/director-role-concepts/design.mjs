import fs from 'node:fs';import path from 'node:path';import {createRequire,stripTypeScriptTypes} from 'node:module';
const ROOT=path.dirname(new URL(import.meta.url).pathname),REPO=process.argv[2]||path.resolve(ROOT,'../../../..'),req=createRequire(REPO+'/package.json'),sharp=req('sharp');sharp.concurrency(1);sharp.cache({memory:32,files:4,items:10});
let artSource=fs.readFileSync(REPO+'/packages/ui/src/components/ui/agent-avatar-art.ts','utf8');fs.writeFileSync(ROOT+'/avatar-art.mjs',stripTypeScriptTypes(artSource));const{agentAvatarSvg}=await import('./avatar-art.mjs');fs.unlinkSync(ROOT+'/avatar-art.mjs');
const C={ink:'#4c5268',blue:'#8aabc8',ice:'#dcebf3',lavender:'#b9b0d0',cream:'#fffaf0',gold:'#c7a56c',muted:'#788598',paper:'#f2f4f8'};
const p=(d,fill='none',stroke=C.ink,w=1.4)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const diamond=(x,y,r=3)=>p(`M${x} ${y-r} l${r} ${r} l-${r} ${r} l-${r} -${r} Z`,C.cream,C.gold,1.2);
const text=(x,y,t,size=16,color=C.ink,weight=400)=>`<text x="${x}" y="${y}" font-family="Noto Sans CJK SC, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${t}</text>`;
const avatar=id=>agentAvatarSvg(id).replace(/^<svg[^>]*>/,'').replace('</svg>','');
export function role(id,variant='collar',x=0,y=0,size=80,motion=0){
 const back=variant==='collar'?p('M15 43 Q8 49 5 64 L20 69 L32 63 L47 69 L62 65 Q59 49 54 43 Z',C.ink)+p('M8 62 L20 66 L31 59 L47 66 L58 63',C.lavender,C.lavender,1):variant==='jacket'?p('M10 44 L3 52 L9 72 L32 68 L55 72 L62 52 L54 44 Z',C.ink)+p('M10 45 L3 52 L11 55 L17 47 M48 47 L54 44 L62 51 L55 55',C.ice,C.blue):'';
 const front=variant==='collar'?p('M15 44 L32 50 L49 44 L44 56 L32 52 L21 56 Z',C.cream,C.blue,1.1)+diamond(32,53,3.2)+p('M49 52 l8 1 l-1 11 l-7 -1 Z',C.cream,C.blue,1)+p('M51 56 h3 M51 59 h3','none',C.gold,.8):variant==='sash'?p('M10 46 Q32 50 53 46 L55 54 Q33 58 12 53 Z',C.ice,C.blue,1.2)+p('M48 52 L64 56 L58 61 L64 67 L46 60 Z',C.lavender,C.ink,1)+diamond(49,51,3)+p('M57 34 L70 36 L69 57 L56 55 Z',C.cream,C.ink,1)+p('M60 40 l7 1 M60 44 l5 1 M60 48 l6 1','none',C.blue,1):variant==='jacket'?p('M14 45 L32 55 L50 45 L45 60 L36 56 L32 65 L27 56 L19 60 Z',C.cream,C.blue,1)+p('M30 58 l2 7 l3 -7',C.gold,C.gold,1)+p('M49 51 h8 v5 h-8 Z',C.ice,C.gold,1):'';
 const tail=variant==='collar'?`<g transform="rotate(${motion*5} 48 58)">${p('M48 57 L61 62 L57 68 L64 71 L47 66 Z',C.lavender,C.ink,1.1)}</g>`:'';
 return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 80 80"><g transform="translate(8 3)">${back}${avatar(id)}${tail}${front}</g></svg>`;
}
const child=(id,x,y,size=40)=>role(id,'child',x,y,size);
const defs=`<defs><linearGradient id="paper" x2=".2" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="#dce7f1"/></linearGradient><filter id="depth" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#46516b" flood-opacity=".12"/></filter></defs>`;
const svg=(w,h,body,bg='#f0f3f7')=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${defs}<rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`;
const ids=['ribbon-blue','scoop-pistachio','lens-lilac','overlap-coral'];
let b=text(44,48,'VARIN / 项目执行员 · 主 Agent 角色方案',29,C.ink,600)+text(44,80,'身份不变，职责可见。直接复用现有头像路径与表情；仅桌宠角色配件，不写回全局头像。',16,C.muted);
const names=[['child','原有子精灵','原身份 · 无角色配件'],['collar','A 领航短披肩 · 推荐','双层肩线 / 空心菱形扣 / 小文书签'],['sash','B 侧系派遣带','横向腰带 / 侧文件夹 / 非对称短尾'],['jacket','C 项目工装襟','双翻领 / 肩章 / 文书口袋']];
for(let col=0;col<4;col++){const[v,title,note]=names[col],x=42+col*350;b+=`<rect x="${x}" y="112" width="326" height="650" rx="18" fill="${col===1?'#e3eaf3':'#fafbfd'}" stroke="${col===1?'#a8b8d0':'#dce3ec'}"/>`+text(x+18,146,title,20,C.ink,600)+text(x+18,174,note,12,C.muted);
 b+=role(ids[0],v,x+76,190,168)+text(x+26,388,'同一身份，跨轮廓保持识别',13,C.muted);
 ids.forEach((id,i)=>b+=role(id,v,x+22+i*75,410,64));
 b+=text(x+20,511,'实际像素尺寸（不是放大截图）',12,C.muted);
 [24,32,48].forEach((size,i)=>{const q=x+38+i*92;b+=role(ids[0],v,q,535,size)+text(q,610,`${size}px`,12,C.muted);});
 b+=text(x+18,657,col===1?'肩线在 24px 仍留下可辨的工作队长轮廓。':col===2?'侧文件夹有行动感，但小尺寸易成杂边。':col===3?'层级明确，但更像行政职员，偏正式。':'子队保持轻巧，不新增服装或职位暗示。',11,C.muted);
 b+=text(x+18,684,col===1?'短尾仅随派遣轻摆，静置时完全安定。':col===2?'作为偶发递送配件，不推荐永久角色标识。':col===3?'不推荐：容易让主 Agent 看起来也是主管。':'与任何主角色使用同一套眼睛/色彩/形状。',11,C.muted);
}
b+=text(44,812,'推荐 A：工作队长，不是小董事长。',22,C.ink,600)+text(44,846,'主体轮廓仍是原来的柔软精灵；短披肩形成清晰肩线，小文书签说明“负责把项目推进并回报”。',16,C.muted)+text(44,877,'不使用皇冠、不同物种、整脸换表情或单纯放大来表达主从。角色样式与保存的头像身份分离。',16,C.muted);
await sharp(Buffer.from(svg(1460,920,b))).png().toFile(ROOT+'/lead-variants.png');
// Exact approved character plates, extracted without repainting from the selected bundle.
const A=REPO+'/packages/web/public/companion-assets',bundle=JSON.parse(fs.readFileSync(A+'/bundle.json'));async function plate(action){const a=bundle.packages.find(p=>p.action===action),f=a.frames[Math.min(action==='understood'?2:0,a.frames.length-1)];const cut=await sharp(A+'/'+a.pages[f.page].file).extract({left:f.rect[0],top:f.rect[1],width:f.rect[2],height:f.rect[3]}).toBuffer();const im=await sharp({create:{width:512,height:512,channels:4,background:'#00000000'}}).composite([{input:cut,left:f.offset[0],top:f.offset[1]}]).png().toBuffer();return'data:image/png;base64,'+im.toString('base64');}
const plates={overview:await plate('dispatch'),delegate:await plate('dispatch'),report:await plate('understood'),decision:await plate('permission')};
fs.mkdirSync(ROOT+'/plates',{recursive:true});const motionPlates={overview:'plates/dispatch.png',delegate:'plates/dispatch.png',report:'plates/understood.png',decision:'plates/permission.png'};for(const [mode,file] of Object.entries(motionPlates))fs.writeFileSync(ROOT+'/'+file,Buffer.from(plates[mode].split(',')[1],'base64'));
export function projectCard(x,y,id,label,detail,children=[],mode='quiet',time=1){
 let q=p(`M${x+2} ${y+32} l9 -7 l24 0 l5 5 l49 0 l-2 48 l-83 0 Z`,C.lavender,C.ink,1)+p(`M${x} ${y+36} Q${x+40} ${y+30} ${x+87} ${y+35} l-3 41 l-81 0 Z`,'url(#paper)',C.blue,1)+p(`M${x+6} ${y+39} l76 -2`,'none','#fff',1)+role(id,'collar',x+20,y-10,52,mode==='delegate'?Math.sin(time*Math.PI*2):0)+text(x+9,y+53,label,10,C.ink,600)+text(x+9,y+67,detail,8,C.muted);
 if(children.length){children.forEach((id,i)=>{const t=mode==='delegate'?Math.max(0,Math.min(1,Math.max(0,(time-.45)/.55)*1.8-i*.23)):1, cx=x+12+i*23,cy=y+84; q+=`<g opacity="${t}" transform="translate(${(1-t)*16} ${-(1-t)*19})">${p(`M${x+43} ${y+72} Q${cx+5} ${cy-4} ${cx+8} ${cy+4}`,'none',C.lavender,.7)}${child(id,cx-3,cy-3,24)}</g>`;});}
 if(mode==='decision')q+=p(`M${x+66} ${y+12} h15 v15 h-15 Z`,C.cream,C.gold,1.3)+p(`M${x+70} ${y+12} v-5 q4 -6 7 0 v5`,'none',C.ink,1.5);
 if(mode==='question')q+=p(`M${x+64} ${y+10} h19 v16 l-5 5 v-5 h-14 Z`,C.cream,C.blue,1)+text(x+70,y+22,'?',12,C.ink,600);
 if(mode==='report')q+=diamond(x+77,y+29,4);
 return q;
}
export function stage(mode='overview',time=1){
 let q=`<image href="${plates[mode==='report'&&time<1?'overview':mode]}" x="62" y="55" width="236" height="236"/>`;
 // Deliberately project-owned connectors: Varin -> lead -> children, never Varin directly -> every tool.
 q+=p('M181 213 Q230 235 296 167 M150 211 Q96 225 44 197','none',C.lavender,.9);
 q+=projectCard(4,115,ids[0],'A · 文献项目',mode==='report'?(time<1?'本轮结果递送中':'已收到本轮结果'):'执行中 · 项目负责人',mode==='delegate'?[ids[1],ids[2]]:[],mode==='delegate'?'delegate':mode==='report'?'report':'quiet',time);
 q+=projectCard(266,78,ids[1],'B · 设计项目',mode==='decision'?'等待你的授权':'执行中 · 项目负责人',[],mode==='decision'?'decision':'quiet',time);
 q+=projectCard(267,215,ids[2],'C · 验证项目',mode==='decision'?'需要你的回答':'等待外部结果',[],mode==='decision'?'question':'quiet');
 if(mode==='delegate'){const t=Math.min(1,time/.45),x=180+(47-180)*t,y=207+(151-207)*t-18*Math.sin(t*Math.PI);q+=diamond(x,y,4);}
 if(mode==='report'){const t=Math.min(1,time),x=50+(174-50)*t,y=174+(205-174)*t-20*Math.sin(t*Math.PI);q+=`<g transform="translate(${x} ${y})">${p('M-9 -9 h18 v14 h-18 Z',C.cream,C.blue,1)}${p('M-5 -4 h10 M-5 0 h7','none',C.blue,1)}</g>`;}
 if(mode==='decision'){const t=Math.min(1,time),bx=288-82*t,by=139+36*t,cx=288-146*t,cy=265-91*t; q+=p(`M296 145 Q260 170 ${bx} ${by}`,'none',C.gold,1)+p(`M298 273 Q235 244 ${cx} ${cy}`,'none',C.lavender,1)+p(`M${bx} ${by} h29 v21 h-29 Z`,C.cream,C.gold,1)+text(bx+4,by+14,'B',9,C.ink,600)+p(`M${bx+16} ${by+9} h8 v7 h-8 Z`,C.cream,C.gold,1)+p(`M${bx+18} ${by+9} v-3 q2 -4 4 0 v3`,'none',C.ink,1)+p(`M${cx} ${cy} h27 v21 h-27 Z`,C.cream,C.blue,1)+text(cx+4,cy+14,'C ?',10,C.ink,600);}
 return q;
}
const stories=[['overview','01 组合项目总览','Varin 管理全局；每张卡由真实主 Agent 负责。'],['delegate','02 派给负责人，再组成小队','任务信笺先到主 Agent，再由它召集真实子队。'],['report','03 收到项目本轮结果','A 本轮结果回到 Varin；B 仍工作，不全局庆祝。'],['decision','04 把待决事项递给你','B 的授权 / C 的问题分开递交；不合并成总锁。']];let story=text(36,42,'VARIN / 执行董事与项目队长',26,C.ink,600)+text(36,72,'角色关系概念 · 示例项目与事件均为设计占位，尚未接入生产事实',14,C.muted);
stories.forEach(([mode,title,note],i)=>{const x=30+i*382;story+=`<g transform="translate(${x} 103)"><rect width="360" height="365" rx="20" fill="#e8eef4" stroke="#d5dfea"/>${stage(mode,mode==='report'?1:.72)}</g>`+text(x,502,title,18,C.ink,600)+text(x,530,note,11,C.muted);});story+=text(36,584,'360px 桌面构图：主 Agent 靠项目文件夹停驻；子精灵更轻、无披肩；工具细节属于项目卡，不驱动 Varin 换成逐工具操作员。',14,C.muted);
await sharp(Buffer.from(svg(1560,620,story))).png().toFile(ROOT+'/director-storyboards.png');
let family=text(36,42,'推荐 A / 同一身份的角色层级',26,C.ink,600)+text(36,71,'24 / 32 / 48px 逐项检查：眼睛与身体路径原样复用，只有职责配件改变。',14,C.muted);
ids.forEach((id,r)=>{const y=112+r*124;family+=text(36,y+43,id,16,C.ink,600);[24,32,48].forEach((n,i)=>{const x=288+i*210;family+=child(id,x,y+18,n)+role(id,'collar',x+72,y+18,n)+text(x,y+92,`${n}px  子精灵 → 项目队长`,12,C.muted);});family+=role(id,'collar',998,y-2,96)+p(`M1097 ${y+45} h32`,'none',C.lavender,1)+child(id,1140,y+20,42)+child(ids[(r+1)%4],1190,y+20,42);});
await sharp(Buffer.from(svg(1280,650,family))).png().toFile(ROOT+'/recommended-family.png');
fs.writeFileSync(ROOT+'/concept-stages.json',JSON.stringify({plates:Object.keys(plates),notes:'design-only scenarios, no runtime events or new avatar identities',variants:names,ids},null,2));
// Small self-contained vector motion concepts: browser-playable, no encoder or production engine changes.
const stages=Object.fromEntries(stories.map(([m])=>[m,Array.from({length:25},(_,i)=>stage(m,i/24).replace(/<image[^>]*\/>/,''))]));
fs.writeFileSync(ROOT+'/motion-concepts.html',`<!doctype html><meta charset="utf-8"><title>Varin director / internal motion concepts</title><style>body{background:#eef2f7;color:#4c5268;font:14px system-ui;margin:28px}.grid{display:flex;gap:18px;flex-wrap:wrap}article{width:360px}svg{background:#e8eef4;border-radius:18px}button{padding:8px 16px}</style><h1>Varin → 项目队长 → 子精灵</h1><p>内部动画概念 · 角色与头像为现有资源 · 示例项目/事件非真实状态</p><button id="toggle">暂停 / 播放</button><div class="grid">${stories.map(([m,t])=>`<article><h3>${t}</h3><svg id="${m}" width="360" height="365" viewBox="0 0 360 365">${defs}</svg></article>`).join('')}</div><script>const frames=${JSON.stringify(stages)},actors=${JSON.stringify(motionPlates)},defs=${JSON.stringify(defs)};let playing=true,start=performance.now();document.getElementById('toggle').onclick=()=>playing=!playing;function tick(now){if(playing){const t=(now-start)%5000;const i=t<700?0:t<2600?Math.min(24,Math.floor((t-700)/1900*24)):24;for(const [key,list] of Object.entries(frames))document.getElementById(key).innerHTML=defs+'<image href="'+actors[key==='report'&&i<24?'overview':key]+'" x="62" y="55" width="236" height="236"/>'+list[i]}requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`);
console.log('Three variants, exact-size identity family, four360px director storyboards and browser motion concepts ready.');
