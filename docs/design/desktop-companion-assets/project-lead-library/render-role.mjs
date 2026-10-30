import {agentAvatarSvg,AGENT_AVATAR_ART} from './avatar-art.mjs';
import fits from './profiles.json' with {type:'json'};
const art=id=>agentAvatarSvg(id).replace(/^<svg[^>]*>/,'').replace('</svg>','');
// Authored per actual composite silhouette, including its accent layer.
// No generic fallback: additional identities need their own fit review first.
export const FITTED_AVATAR_IDS=Object.keys(fits);let serial=0;
const p=(d,fill,stroke='#4c5268',w=.9)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
/** Only the two lower lining polygons inherit the existing identity's primary color. */
export function captainLiningColor(id){const hex=Object.hasOwn(AGENT_AVATAR_ART,id)?AGENT_AVATAR_ART[id].color:null;if(!hex)throw Error('Unknown avatar '+id);const base=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)),cream=[255,250,240];return '#'+base.map((v,i)=>Math.round(v*.78+cream[i]*.22).toString(16).padStart(2,'0')).join('');}
export function fitted(id,x=0,y=0,size=80,{layer='full',guides=false,liningMode='identity'}={}){const f=Object.hasOwn(fits,id)?fits[id]:null;if(!f)throw Error('Unreviewed captain fit: '+id);const uid='fit'+(++serial),[lx,ly,rx,ry]=f.shoulders,[cx,cy]=f.center,[fx,fy,fw,fh]=f.folio;
 const [, ,lcx,lcy,nx,ny,rcx,rcy]=f.neck.match(/-?\d+(?:\.\d+)?/g).map(Number);
 const headClip=f.headClip??`M-8 -8 H72 V${ry} H${rx} Q${rcx} ${rcy} ${nx} ${ny} Q${lcx} ${lcy} ${lx} ${ly} H-8 Z`;
 const defs=`<defs><linearGradient id="${uid}-cloth" x1="0" y1="0" x2=".25" y2="1"><stop stop-color="#5a6279"/><stop offset="1" stop-color="#454c62"/></linearGradient><linearGradient id="${uid}-collar" x2=".3" y2="1"><stop stop-color="#fffdf4"/><stop offset="1" stop-color="#e7e5dd"/></linearGradient><clipPath id="${uid}-head">${p(headClip,'white','none',0)}</clipPath><clipPath id="${uid}-cape">${p(f.cape,'white','none',0)}</clipPath></defs>`;
 const cape=p(f.cape,`url(#${uid}-cloth)`,'#4c5268',.8)+`<g clip-path="url(#${uid}-cape)">${p(f.lining,liningMode==='legacy'?'#ada0c6':captainLiningColor(id),'none',0)}${p(`M${lx+1} ${ly+3} Q${lx-1} 55 ${lx-4} 63 M${rx-1} ${ry+3} Q${rx+1} 54 ${rx+4} 63`,'none','#697187',.8)}</g>`;
 const head=`<g clip-path="url(#${uid}-head)">${art(id)}</g>`;
 const collar=p(f.collarL,`url(#${uid}-collar)`,'#b3bbca',.75)+p(f.collarR,`url(#${uid}-collar)`,'#b3bbca',.75);
 const clasp=p(`M${cx} ${cy-3.3} l3.3 3.3 l-3.3 3.3 l-3.3 -3.3 Z`,'#fffaf0','#c8a267',1.6);
 const folio=`<g transform="rotate(3 ${fx+fw/2} ${fy})">${p(`M${fx+.7} ${fy+1} h${fw} v${fh} h-${fw} Z`,'#394357','none',0)}<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx=".8" fill="#fffaf0" stroke="#9aa8ba" stroke-width="1"/>${p(`M${fx+3} ${fy+5} h${fw-5} M${fx+3} ${fy+9} h${fw-6}`,'none','#8faec5',1.1)}${p(`M${fx+fw/2-1.8} ${fy-1.8} h3.6 v3 h-3.6 Z`,'#f5e5c2','#c8a267',.8)}</g>`;
 const layers={cape,head,collar,clasp,folio};let body=layer==='full'?cape+head+collar+clasp+folio:layers[layer];if(guides)body+=p(f.neck,'none','#d77c72',.7)+`<circle cx="${lx}" cy="${ly}" r="1.4" fill="#d77c72"/><circle cx="${rx}" cy="${ry}" r="1.4" fill="#d77c72"/>`;
 return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 80 80">${defs}<g transform="translate(8 3)">${body}</g></svg>`;
}
export const child=(id,x,y,size)=>`<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 80 80"><g transform="translate(8 3)">${art(id)}</g></svg>`;
const t=(x,y,s,n=16,c='#4c5268',weight=400)=>`<text x="${x}" y="${y}" font-family="Noto Sans CJK SC,sans-serif" font-size="${n}" fill="${c}" font-weight="${weight}">${s}</text>`;
const svg=(w,h,s)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#f0f3f7"/>${s}</svg>`;

export const PROFILE_DEFINITIONS=fits;
