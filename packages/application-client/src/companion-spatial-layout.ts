/** Candidate B: one geometry authority for native bounds and the SVG scene.
 * All coordinates use the existing upright character design space. No DOM,
 * project data, actor deformation, or viewport-side mirroring lives here. */
export interface CompanionSpatialRect { left:number; top:number; right:number; bottom:number }
export interface CompanionSpatialPoint { x:number; y:number }
export interface CompanionSpatialSeat {
  label:'A'|'B'|'C'; home:CompanionSpatialPoint; size:number; childSize:number;
  children:CompanionSpatialPoint[]; layer:'behind'|'front'; depth:number;
  captionY:number; statusY:number; captionBudget:number; childrenVisible:boolean;
  shadow:{x:number;y:number;rx:number;ry:number;opacity:number}; bounds:CompanionSpatialRect;
}
export interface CompanionSpatialLayout {
  id:'spatial-b-v1'; available:CompanionSpatialRect; bounds:CompanionSpatialRect;
  compression:number; avoidance:number; seats:CompanionSpatialSeat[];
}
export const COMPANION_SPATIAL_B = {
  id:'spatial-b-v1' as const,
  character:{x:50,y:25,width:200,height:200},
  requestedExtent:{left:5,top:-15,right:295,bottom:285},
  computer:{x:166,y:147},palm:{x:231,y:107},paperAbovePalm:{x:231,y:96},
  report:{left:{x:42,y:128},right:{x:250,y:128}},
  seats:[
    {label:'A' as const,x:248.333333,y:110.555556,size:26.666667,layer:'behind' as const,depth:.67,compact:{x:248,y:74},children:[[17.777778,-8.333333],[11.111111,17.777778],[-12.222222,10.555556]]},
    {label:'B' as const,x:78.888889,y:222.222222,size:38.888889,layer:'front' as const,depth:1,compact:{x:42,y:172},children:[[-29.444444,-3.333333],[15.555556,21.111111],[-11.111111,18.888889]]},
    {label:'C' as const,x:222.777778,y:225.555556,size:41.111111,layer:'front' as const,depth:1.06,compact:{x:250,y:170},children:[[-16.666667,21.666667],[31.111111,-2.222222],[12.222222,22.777778]]},
  ],
} as const;
const clamp=(n:number,lo=0,hi=1)=>Math.max(lo,Math.min(hi,n));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const union=(boxes:CompanionSpatialRect[]):CompanionSpatialRect=>({left:Math.min(...boxes.map(b=>b.left)),top:Math.min(...boxes.map(b=>b.top)),right:Math.max(...boxes.map(b=>b.right)),bottom:Math.max(...boxes.map(b=>b.bottom))});
/** Compression moves each identity only within its own sector; selection and
 * tool events are intentionally not inputs. Native may animate between receipts. */
export function resolveCompanionSpatialLayout(input:{available?:CompanionSpatialRect;avoidance?:number}={}):CompanionSpatialLayout {
  const available=input.available??{...COMPANION_SPATIAL_B.requestedExtent};
  const compression=clamp((285-available.bottom)/60),avoidance=clamp(input.avoidance??0);
  const seats:CompanionSpatialSeat[]=COMPANION_SPATIAL_B.seats.map(source=>{
    const scale=(1-.24*compression)*(1-.28*avoidance),size=source.size*scale,childSize=size*.45;
    const fan=scale*(1-.45*avoidance);
    let x=mix(source.x,source.compact.x,compression),y=mix(source.y,source.compact.y,compression);
    x+=avoidance*(source.label==='B'?-12:12);
    const sideRoom=source.label==='B'?82-available.left:available.right-216;
    const childrenVisible=sideRoom>=42&&avoidance<.65;
    const captionBudget=sideRoom<42?3:5;
    const labelHalf=captionBudget===3?13:24;
    const offsets=source.children.map(([dx,dy])=>({x:dx*fan,y:dy*fan}));
    const leftLocal=Math.min(-size/2,-labelHalf,...(childrenVisible?offsets.map(p=>p.x-childSize/2):[]));
    const rightLocal=Math.max(size/2,labelHalf,...(childrenVisible?offsets.map(p=>p.x+childSize/2):[]));
    // Minimal local edge translation, never switching A/B/C sectors or mirroring.
    const minX=available.left-leftLocal+2,maxX=available.right-rightLocal-2;
    if(minX<=maxX)x=clamp(x,minX,maxX);
    const bottomObject=Math.max(size*.64,...(childrenVisible?offsets.map(p=>p.y+childSize*.65):[]));
    const captionOffset=bottomObject+12,statusOffset=captionOffset+8;
    y=Math.min(y,available.bottom-statusOffset-3);
    y=Math.max(y,available.top+size/2+3);
    // Rear portraits cannot be clamped into the face. If a screen is so narrow
    // that the outer lane is unavailable, move below the face, not through it.
    if(source.layer==='behind'&&x-size/2<218&&y-size/2<110)y=Math.max(y,110+size/2+2);
    const children=offsets.map(p=>({x:x+p.x,y:y+p.y}));
    const bounds={left:x+leftLocal-1,top:Math.min(y-size/2,...(childrenVisible?children.map(p=>p.y-childSize/2):[]))-1,right:x+rightLocal+1,bottom:y+statusOffset+2};
    return {label:source.label,home:{x,y},size,childSize,children,layer:source.layer,depth:source.depth,captionY:y+captionOffset,statusY:y+statusOffset,captionBudget,childrenVisible,shadow:{x,y:y+size*.55,rx:size*.45,ry:size*.095,opacity:source.layer==='behind'?.13:.19},bounds};
  });
  return {id:'spatial-b-v1',available,bounds:union(seats.map(s=>s.bounds)),compression,avoidance,seats};
}
