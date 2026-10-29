import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import{stage,projectCard}from'./design.mjs';
const ROOT=path.dirname(new URL(import.meta.url).pathname),repo=process.argv[2]||path.resolve(ROOT,'../../../..'),req=createRequire(repo+'/package.json'),sharp=req('sharp');sharp.concurrency(1);sharp.cache({memory:16,files:4,items:10});
const text=(x,y,s,n=14,c='#4c5268')=>`<text x="${x}" y="${y}" font-family="Noto Sans CJK SC,sans-serif" font-size="${n}" fill="${c}">${s}</text>`;
const pathSVG=(d,fill='none',stroke='#aaa0ca',w=1)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
function inspect(){const old=projectCard(267,215,'lens-lilac','C · 验证项目','等待外部结果',[]);let s=stage('overview',1).replace(old,projectCard(267,215,'lens-lilac','C · 验证项目','查看 C · 细节留在此',['ribbon-blue','scoop-pistachio','overlap-coral']));
 s+=pathSVG('M267 244 L263 244 L263 291 L268 291 M351 244 L357 244 L357 291 L352 291','none','#7895b5',1.6)
 +pathSVG('M293 270 Q244 257 199 199','none','#aaa0ca',.9)
 +pathSVG('M171 181 h35 v24 h-35 Z','#fffaf0','#7895b5')+text(177,192,'C · 简报',7)+pathSVG('M177 197 h20','none','#7895b5',1)
 +pathSVG('M8 279 h81 l-2 29 h-79 Z','#fffaf0','#c7a56c',1.3)+text(14,291,'D · 结果待核查',9)+text(14,302,'独立待处理 · 不抢镜头',7,'#788598');return s;}
const entries=[['01 项目组合总览',stage('overview',1),'A/B/C 三位负责人停驻；细节变化不抢主体。','身体：安静看简报 / 短目光巡视'],['02 接收并分派新项目',stage('delegate',.78),'指令先给真实负责人，子队只随实际派发出现。','身体：接收 → 手势到负责人 → 收手'],['03 检查 C，D 仍待核查',inspect(),'只展开 C 小队；D 的未知结果另列，不自动切走。','身体：看电脑上的 C 简报，不扮演 C 执行'],['04 分别呈递待决事项',stage('decision',1),'B 的权限与 C 的问题保持各自身份和入口。','身体：开放掌心 → 面向你 → 安静保持'],['05 接收 A 本轮结果',stage('report',1),'A 的结果到电脑再回应；B/C 继续保留。','身体：接收 → 小点头 / 指简报 → 归位']];
let body=text(34,42,'VARIN / 执行董事 · 五个管理场景',26)+text(34,72,'完整角色编排候选，不是生产接线；主 Agent 服装亦未获用户批准。旧动作保留，重新编排职责、视线和对象。',14,'#788598');
for(const[i,[title,visual,note,gesture]]of entries.entries()){const x=30+i*380;body+=`<g transform="translate(${x} 101)"><rect width="360" height="365" rx="18" fill="#e8eef4" stroke="#d5dfea"/>${visual}</g>`+text(x,499,title,18)+text(x,525,note,11,'#788598')+text(x,547,gesture,11,'#788598');}
body+=text(34,590,'运动语法：先让对象到达真实手/视线目标，再表演；进入 → 明确一次动作 → 安静保持 → 实际姿态回收。项目不因“少了一张卡”被演成成功。',14,'#788598');
const defs='<defs><linearGradient id="paper" x2=".2" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="#dce7f1"/></linearGradient></defs>';
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1930" height="626">${defs}<rect width="1930" height="626" fill="#f0f3f7"/>${body}</svg>`)).png().toFile(ROOT+'/director-five-scenes.png');
console.log('Five director scenarios rendered at360px stage size; prototype only.');
