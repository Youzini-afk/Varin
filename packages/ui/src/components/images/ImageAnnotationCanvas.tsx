import React from 'react';
import { arrowPoints, commitMarks, hitMark, markBounds, markHalo, markOutline, markOpacity, moveMark, resizeMark, type AnnotationTool, type AnnotationOutline, type ImageAnnotationDocument, type ImageMark, type Point } from '@/lib/images/annotations';

export function AnnotationMark({ mark }: { mark: ImageMark }) {
  const outline = markOutline(mark), opacity = markOpacity(mark);
  const b = markBounds(mark), stroke = { fill: 'none', stroke: mark.color, strokeWidth: mark.width, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let shape: React.ReactElement;
  if (mark.kind === 'cover') return <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="#101010" />;
  if (mark.kind === 'number') return <g opacity={opacity}><circle cx={mark.from.x} cy={mark.from.y} r={mark.fontSize*.85} fill={mark.color} stroke={outline ?? 'none'} strokeWidth={Math.max(2,mark.width*.6)} /><text x={mark.from.x} y={mark.from.y} fill={markHalo(mark.color)} textAnchor="middle" dominantBaseline="central" fontSize={mark.fontSize} fontWeight="600">{mark.number}</text></g>;
  if (mark.kind === 'text') return <text x={mark.from.x} y={mark.from.y} opacity={opacity} fill={mark.color} stroke={outline ?? 'none'} strokeWidth={Math.max(2,mark.fontSize/8)} paintOrder="stroke" strokeLinejoin="round" dominantBaseline="text-before-edge" fontSize={mark.fontSize} fontWeight="600">
    {(mark.text ?? '').split('\n').map((line,i)=><tspan key={i} x={mark.from.x} dy={i ? mark.fontSize*1.3 : 0}>{line || '\u00a0'}</tspan>)}</text>;
  if (mark.kind === 'rectangle') shape=<rect x={b.x} y={b.y} width={b.width} height={b.height} />;
  else if (mark.kind === 'ellipse') shape=<ellipse cx={b.x+b.width/2} cy={b.y+b.height/2} rx={b.width/2} ry={b.height/2} />;
  else if (mark.kind === 'pen') shape=<path d={(mark.points ?? []).map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ')} />;
  else { const p=arrowPoints(mark); shape=<path d={`M${mark.from.x},${mark.from.y} L${mark.to.x},${mark.to.y} M${p[0]!.x},${p[0]!.y} L${p[1]!.x},${p[1]!.y} L${p[2]!.x},${p[2]!.y}`} />; }
  return <g {...stroke} opacity={opacity}>{outline && React.cloneElement(shape as React.ReactElement<React.SVGProps<SVGElement>>, {stroke:outline,strokeWidth:mark.width+Math.max(1,mark.width*.5)})}{shape}</g>;
}
export interface AnnotationCanvasHandle { cancelGesture(): boolean; finishText(): void }
export const ImageAnnotationCanvas = React.forwardRef<AnnotationCanvasHandle, {
  document: ImageAnnotationDocument; scale: number; active: boolean; tool: AnnotationTool; color: string; weight: number; outline: AnnotationOutline; opacity: number;
  selected: string | null; onSelect(id: string | null): void; onChange(doc: ImageAnnotationDocument): void; textLabel: string;
}>(function ImageAnnotationCanvas({ document: doc, scale, active, tool, color, weight, outline, opacity, selected, onSelect, onChange, textLabel }, ref) {
  const svg=React.useRef<SVGSVGElement>(null), frame=React.useRef<number | undefined>(undefined);
  const gesture=React.useRef<{ start: Point; original: ImageMark; current: ImageMark; mode:'draw'|'move'|'resize'|'start' } | null>(null);
  const [transient,setTransient]=React.useState<ImageMark | null>(null);
  const [text,setText]=React.useState<{ mark:ImageMark; value:string } | null>(null);
  const textRef=React.useRef(text); textRef.current=text;
  const textarea=React.useRef<HTMLTextAreaElement>(null);
  const cancelGesture=()=>{ const hadGesture=Boolean(gesture.current);if(frame.current!==undefined)cancelAnimationFrame(frame.current);frame.current=undefined;gesture.current=null;setTransient(null);return hadGesture; };
  const finishText=()=>{
    const edit=textRef.current;if(!edit)return;
    textRef.current=null;setText(null);
    const existing=doc.marks.some(m=>m.id===edit.mark.id);
    if(!existing&&!edit.value.trim())return;
    const marks=edit.value.trim() ? existing ? doc.marks.map(m=>m.id===edit.mark.id?{...edit.mark,text:edit.value}:m) : [...doc.marks,{...edit.mark,text:edit.value}] : doc.marks.filter(m=>m.id!==edit.mark.id);
    if(edit.value!==edit.mark.text || !existing)onChange(commitMarks(doc,marks));
  };
  React.useImperativeHandle(ref,()=>({cancelGesture,finishText}));
  React.useEffect(()=>()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current);},[]);
  const editingText=Boolean(text);
  React.useEffect(()=>{if(editingText)textarea.current?.focus();},[editingText]);
  const point=(event:{clientX:number;clientY:number}):Point=>{
    const b=svg.current!.getBoundingClientRect();return {x:Math.max(0,Math.min(doc.width,(event.clientX-b.left)/scale)),y:Math.max(0,Math.min(doc.height,(event.clientY-b.top)/scale))};
  };
  const selection=doc.marks.find(m=>m.id===selected), bounds=selection?markBounds(transient?.id===selected?transient:selection):null;
  const marks=transient ? doc.marks.some(m=>m.id===transient.id)?doc.marks.map(m=>m.id===transient.id?transient:m):[...doc.marks,transient] : doc.marks;
  return <div className="image-annotation-layer" data-active={active || undefined} data-tool={tool}>
    <svg ref={svg} tabIndex={active?0:undefined} width="100%" height="100%" viewBox={`0 0 ${doc.width} ${doc.height}`} onPointerDown={event=>{
      if(!active||event.button!==0||!event.isPrimary&&event.pointerType==='touch')return;
      if(textRef.current)finishText();
      event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
      const p=point(event), handle=(event.target as Element).getAttribute('data-handle');
      if(tool==='select'){
        const mark=handle?selection:hitMark(doc.marks,p,7/scale);onSelect(mark?.id??null);
        if(mark)gesture.current={start:p,original:mark,current:mark,mode:handle==='end'?'resize':handle==='start'?'start':'move'};
        return;
      }
      const base=1/scale, mark:ImageMark={id:crypto.randomUUID(),kind:tool,from:p,to:p,color,outline,opacity,width:weight*base,fontSize:26*base};
      if(tool==='number')mark.number=doc.marks.reduce((n,m)=>Math.max(n,m.number??0),0)+1;
      if(tool==='pen')mark.points=[p];
      gesture.current={start:p,original:mark,current:mark,mode:'draw'};onSelect(mark.id);setTransient(mark);
    }} onPointerMove={event=>{
      const g=gesture.current;if(!g)return;const p=point(event);
      if(g.mode==='move')g.current=moveMark(g.original,p.x-g.start.x,p.y-g.start.y);
      else if(g.mode==='resize')g.current=resizeMark(g.original,p);
      else if(g.mode==='start')g.current={...g.original,from:p};
      else if(g.current.kind==='text'||g.current.kind==='number')g.current={...g.current,from:p,to:p};
      else if(g.current.kind==='pen') { const events=event.nativeEvent.getCoalescedEvents?.()??[];g.current={...g.current,to:p,points:[...g.current.points!,...(events.length?events:[event]).map(point)]}; }
      else g.current={...g.original,to:p};
      frame.current??=requestAnimationFrame(()=>{frame.current=undefined;setTransient(gesture.current?.current??null);});
    }} onPointerUp={event=>{
      const g=gesture.current;if(!g)return;
      let mark=g.current;
      if(g.mode==='draw'&&mark.kind==='text'){cancelGesture();setText({mark,value:''});return;}
      if(mark.kind==='pen'&&mark.points?.length===1)mark={...mark,points:[mark.from,{x:mark.from.x+.01,y:mark.from.y+.01}]};
      if(g.mode!=='draw'&&JSON.stringify(g.original)===JSON.stringify(mark)){cancelGesture();return;}
      if(g.mode==='draw'&&!['pen','number'].includes(mark.kind)&&Math.hypot(mark.to.x-mark.from.x,mark.to.y-mark.from.y)*scale<2){cancelGesture();return;}
      const next=g.mode==='draw'?[...doc.marks,mark]:doc.marks.map(m=>m.id===mark.id?mark:m);
      cancelGesture();onChange(commitMarks(doc,next));
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={cancelGesture} onLostPointerCapture={()=>{if(gesture.current)cancelGesture();}} onDoubleClick={event=>{
      if(!active)return;const mark=hitMark(doc.marks,point(event),7/scale);if(mark?.kind==='text'){setText({mark,value:mark.text??''});onSelect(mark.id);}
    }}>
      <g style={{fontFamily:'system-ui, sans-serif',pointerEvents:'none'}}>{marks.filter(m=>m.id!==text?.mark.id).map(mark=><AnnotationMark key={mark.id} mark={mark} />)}</g>
      {active&&tool==='select'&&bounds&&selection&&!text&&<g className="image-annotation-selection" strokeWidth={1/scale}>
        <rect x={bounds.x-3/scale} y={bounds.y-3/scale} width={bounds.width+6/scale} height={bounds.height+6/scale} fill="none" strokeDasharray={`${4/scale} ${3/scale}`} pointerEvents="none" />
        {selection.kind==='arrow'&&<circle data-handle="start" cx={selection.from.x} cy={selection.from.y} r={5/scale} />}
        <circle data-handle="end" cx={selection.kind==='arrow'?selection.to.x:bounds.x+bounds.width} cy={selection.kind==='arrow'?selection.to.y:bounds.y+bounds.height} r={5/scale} />
      </g>}
    </svg>
    {text&&<textarea ref={textarea} className="image-annotation-text" aria-label={textLabel} value={text.value} style={{left:text.mark.from.x*scale,top:text.mark.from.y*scale,fontSize:text.mark.fontSize*scale,lineHeight:1.3,color:text.mark.color,width:Math.max(180,markBounds({...text.mark,text:text.value}).width*scale+24),minHeight:text.mark.fontSize*scale*1.5}}
      onChange={event=>setText({...text,value:event.target.value})} onBlur={finishText} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{
        event.stopPropagation();
        if(event.key==='Escape'){event.preventDefault();textRef.current=null;setText(null);}
        if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();finishText();svg.current?.focus();}
      }} />}
  </div>;
});
