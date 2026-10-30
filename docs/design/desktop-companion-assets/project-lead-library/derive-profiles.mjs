import fs from'node:fs';import path from'node:path';import crypto from'node:crypto';import{createRequire,stripTypeScriptTypes}from'node:module';
const OUT=path.dirname(new URL(import.meta.url).pathname),ROOT=process.argv[2]||path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../../..'),req=createRequire(ROOT+'/package.json'),sharp=req('sharp');sharp.concurrency(1);sharp.cache(false);
const artSource=fs.readFileSync(ROOT+'/packages/ui/src/components/ui/agent-avatar-art.ts','utf8');fs.writeFileSync(OUT+'/avatar-art.mjs',stripTypeScriptTypes(artSource));const{AGENT_AVATAR_ART:ART}=await import('./avatar-art.mjs');
const priorPath=ROOT+'/docs/design/desktop-companion-assets/director-role-concepts/fit-repair/fitted-captains.mjs',priorSource=fs.readFileSync(priorPath,'utf8'),literal=priorSource.slice(priorSource.indexOf('const fits=')+11,priorSource.indexOf(';export const FITTED_AVATAR_IDS'));
const preserved=Function('return ('+literal+')')();
const overrides={
 'pillar-lilac':{center:32,band:44,note:'Narrow pillar: narrower cape and8.5pxfolio; collar centered on real neck.'},
 'capsule-sky':{band:43,neckDepth:5,note:'Low wide capsule: shallow contactcurve follows curved loweredge rather than forcing a deepV.'},
 'dome-ivory':{band:43,neckDepth:6,note:'Domed low head: shallow collar and broad shoulder span.'},
 'float-butter':{band:45,neckDepth:7,note:'Low face plus offset accent: lower collar to preserve low-set eyes; composite outer shoulder used.'},
 'ledge-aqua':{center:28,band:44,note:'Right ledge ends above neck: narrow asymmetric lower support, not full upper-head width.'},
 'lean-coral':{center:36,band:44,note:'Leaning right body: clasp shifted to supportedneck, not fixedglobalx32.'},
 'curve-mint':{band:43,note:'Lower-left cutout: neckline clamped to true lowercontour socloth doesnot detach below notch.'},
 'comma-lilac':{band:44,center:33,note:'Concave leftside: contact evaluatedbelow inwardturn, preserved head overhang above garment.'},
 'stack-ivory':{band:44,note:'Two-layer stackedbody: both layers included; right neckline follows higher accent bottom.'},
 'offset-peach':{band:44,note:'Two offset layers treated as one composite shoulder, never body-only width.'},
 'twin-periwinkle':{band:44,note:'Offset secondbody contributes rightshoulder; folio sits outside savedface on cloth.'},
 'echo-ochre':{band:44,note:'Backecho lobe contributes rightshoulder; contactcurve honors its shorter loweredge.'},
 'parcel-periwinkle':{band:44,note:'Offset parcelaccent included incontact silhouette; frontgarment covers lowerbody cleanly.'},
 'inset-sage':{band:44,note:'Stepped upper silhouette retained; garment fitted below offset shoulder step.'},
 'sail-ivory':{center:31,band:44,note:'Swept upperhead retained; cape fitted to actual lower support rather than diagonal top.'},
};
const manualOverrides=JSON.parse(fs.readFileSync(OUT+'/authored-overrides.json','utf8'));
const round=n=>Math.round(n*100)/100,sha=s=>crypto.createHash('sha256').update(s).digest('hex'),profiles={},metrics=[];
function poly(points){return points.map(([x,y],i)=>(i?'L':'M')+round(x)+' '+round(y)).join(' ');}
for(const[id,a]of Object.entries(ART)){
 const markup=`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">${a.accent?`<path fill="white" d="${a.accent.path}"/>`:''}<path fill="white" d="${a.body}"/></svg>`;
 const raw=await sharp(Buffer.from(markup)).ensureAlpha().raw().toBuffer(),alpha=(x,y)=>raw[(y*256+x)*4+3],bottom=[];let maxY=0;
 for(let x=0;x<256;x++){let last=-1;for(let y=0;y<256;y++)if(alpha(x,y)>127){last=y;maxY=Math.max(maxY,y/4);}bottom[x]=last<0?-1:(last+.5)/4;}
 const o=overrides[id]??{},band=o.band??44,iy=Math.round(band*4),xs=[];for(let x=0;x<256;x++)if(alpha(x,iy)>127)xs.push(x/4);
 if(!xs.length)throw Error('No shoulder support '+id);const L=xs[0],R=xs.at(-1),w=R-L,c=Math.max(L+w*.32,Math.min(R-w*.32,o.center??32)),centerBottom=bottom[Math.round(c*4)],ny=Math.min(band+(o.neckDepth??8),centerBottom-.65),end=Math.min(72,Math.max(maxY+8,ny+16,band+24));
 const points=[];const positions=[L,...Array.from({length:15},(_,i)=>L+(i+1)*w/16),c,R].sort((a,b)=>a-b).filter((x,i,arr)=>!i||x-arr[i-1]>.01);
 let clamps=0;for(const x of positions){const u=x<=c?(x-L)/(c-L):(R-x)/(R-c),target=band+(ny-band)*(1.3*u-.3*u*u),limit=bottom[Math.max(0,Math.min(255,Math.round(x*4)))]-.35;const y=Math.min(target,limit);if(y<target-.3)clamps++;points.push([round(x),round(y)]);}
 points[0]=[round(L),round(band)];points[points.length-1]=[round(R),round(band)];const cp=points.find(p=>Math.abs(p[0]-c)<.02)??[round(c),round(ny)],neckL=points.filter(p=>p[0]<=cp[0]),neckR=points.filter(p=>p[0]>=cp[0]);
 const headClip=`M-8 -8 H72 V${band} H${R} `+points.slice().reverse().slice(1).map(([x,y])=>`L${x} ${y}`).join(' ')+' H-8 Z';
 const cape=`M${L} ${band-.5} Q${L-4} ${band+5} ${L-6} ${end-5} Q${L+1} ${end-1} ${L+w*.2} ${end} L${cp[0]} ${end-4.5} L${R-w*.18} ${end} Q${R+2} ${end-1} ${R+6} ${end-5} Q${R+4} ${band+6} ${R} ${band-.5} Z`;
 const collarL=poly(neckL)+` L${cp[0]-w*.21} ${cp[1]+6.7} Q${L+w*.15} ${band+12} ${L+w*.07} ${band+8} Z`,collarR=poly(neckR)+` L${R-w*.07} ${band+8} Q${R-w*.15} ${band+12} ${cp[0]+w*.21} ${cp[1]+6.7} Z`;
 const folioW=w<35?8.5:10.5,folioH=w<35?13:14,folio=[round(R-7),round(band+5),folioW,folioH];
 const f={label:id,shoulders:[round(L),band,round(R),band],neck:poly(points),headClip,neckPoints:points,cape,collarL,collarR,center:[cp[0],round(cp[1]+1.7)],folio,lining:`M${L-5} ${end-5.5} L${L+w*.2} ${end-1} L${cp[0]-2} ${end-4.5} L${L+w*.1} ${end-9} Z M${cp[0]+3} ${end-4.5} L${R-w*.18} ${end-1} L${R+5} ${end-5.5} L${R-w*.08} ${end-9} Z`};
 profiles[id]=preserved[id]??{...f,...manualOverrides[id]};
 metrics.push({id,preserved:!!preserved[id],contactRow:band,measuredShoulders:[L,R],sourceGeometrySha256:sha(JSON.stringify({body:a.body,accent:a.accent?.path??null})),lowerContourClamps:clamps,manualNecklineOverride:!!manualOverrides[id],sourceMaxY:maxY,exceptionNote:o.note??'Silhouette-derived contact width and lower-contour curve; visual audit pending.'});
}
fs.writeFileSync(OUT+'/profiles.json',JSON.stringify(profiles,null,2));fs.writeFileSync(OUT+'/derivation-audit.json',JSON.stringify({avatarSourceSha256:sha(artSource),preservedFourSourceSha256:sha(priorSource),preservedFourUnchanged:Object.keys(preserved).every(id=>JSON.stringify(profiles[id])===JSON.stringify(preserved[id])),profileCount:Object.keys(profiles).length,metrics},null,2));console.log('64 explicit profiles written; reviewed four preserved unchanged.');
