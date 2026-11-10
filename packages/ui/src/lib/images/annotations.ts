import type { ImageAttachment } from '@varin/protocol';
import { getRuntimeEndpointGeneration, runtimeFetch } from '@varin/application-client';

export type AnnotationTool = 'select' | 'pen' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'number' | 'cover';
export type AnnotationOutline = 'none' | 'auto' | 'light' | 'dark';
export type Point = { x: number; y: number };
export interface ImageMark {
  id: string;
  kind: Exclude<AnnotationTool, 'select'>;
  color: string;
  width: number;
  from: Point;
  to: Point;
  points?: readonly Point[];
  text?: string;
  number?: number;
  fontSize: number;
  outline?: AnnotationOutline;
  opacity?: number;
}
/** Immutable source bytes are shared by all editing steps; history contains vector objects only. */
export interface ImageAnnotationDocument {
  source: ImageAttachment;
  width: number;
  height: number;
  marks: readonly ImageMark[];
  past: ReadonlyArray<readonly ImageMark[]>;
  future: ReadonlyArray<readonly ImageMark[]>;
}
/** Frontend draft metadata. Transport serializers emit only ImageAttachment's public fields. */
export interface EditableImageAttachment extends ImageAttachment { draftId?: string; annotation?: ImageAnnotationDocument }
export const imageUrl = (image: ImageAttachment) => `data:${image.mimeType};base64,${image.data}`;
export const commitMarks = (doc: ImageAnnotationDocument, marks: readonly ImageMark[]): ImageAnnotationDocument =>
  marks === doc.marks ? doc : { ...doc, marks, past: [...doc.past, doc.marks], future: [] };
export function undoMarks(doc: ImageAnnotationDocument): ImageAnnotationDocument {
  return doc.past.length ? { ...doc, marks: doc.past.at(-1)!, past: doc.past.slice(0, -1), future: [doc.marks, ...doc.future] } : doc;
}
export function redoMarks(doc: ImageAnnotationDocument): ImageAnnotationDocument {
  return doc.future.length ? { ...doc, marks: doc.future[0]!, past: [...doc.past, doc.marks], future: doc.future.slice(1) } : doc;
}
export function markBounds(mark: ImageMark) {
  const points = mark.points?.length ? mark.points : [mark.from, mark.to];
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
  if (mark.kind === 'text') {
    x = mark.from.x; y = mark.from.y;
    right = x + Math.max(1, ...(mark.text ?? '').split('\n').map(line => Array.from(line).reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 1 : .62), 0))) * mark.fontSize;
    bottom = y + Math.max(1, (mark.text ?? '').split('\n').length) * mark.fontSize * 1.3;
  }
  if (mark.kind === 'number') {
    const r = mark.fontSize * .85;
    x = mark.from.x - r; y = mark.from.y - r; right = mark.from.x + r; bottom = mark.from.y + r;
  }
  return { x, y, width: Math.max(right - x, 1), height: Math.max(bottom - y, 1) };
}
export function moveMark(mark: ImageMark, dx: number, dy: number): ImageMark {
  const move = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  return { ...mark, from: move(mark.from), to: move(mark.to), ...(mark.points ? { points: mark.points.map(move) } : {}) };
}
export function resizeMark(mark: ImageMark, target: Point): ImageMark {
  if (mark.kind === 'arrow') return { ...mark, to: target };
  const bounds = markBounds(mark);
  const sx = Math.max(1, target.x - bounds.x) / bounds.width, sy = Math.max(1, target.y - bounds.y) / bounds.height;
  const transform = (p: Point) => ({ x: bounds.x + (p.x - bounds.x) * sx, y: bounds.y + (p.y - bounds.y) * sy });
  return { ...mark, from: transform(mark.from), to: transform(mark.to), fontSize: mark.fontSize * Math.min(sx, sy),
    ...(mark.points ? { points: mark.points.map(transform) } : {}) };
}
function distance(p: Point, a: Point, b: Point) {
  const length = (b.x-a.x)**2 + (b.y-a.y)**2;
  const t = length ? Math.max(0, Math.min(1, ((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/length)) : 0;
  return Math.hypot(p.x-a.x-t*(b.x-a.x), p.y-a.y-t*(b.y-a.y));
}
export function hitMark(marks: readonly ImageMark[], p: Point, tolerance: number) {
  return [...marks].reverse().find(mark => {
    if (mark.kind === 'arrow') return distance(p, mark.from, mark.to) <= mark.width / 2 + tolerance;
    if (mark.kind === 'pen') return (mark.points ?? []).some((point, i, points) => distance(p, point, points[i-1] ?? point) <= mark.width / 2 + tolerance);
    const b = markBounds(mark);
    if (p.x < b.x-tolerance || p.x > b.x+b.width+tolerance || p.y < b.y-tolerance || p.y > b.y+b.height+tolerance) return false;
    if (mark.kind === 'rectangle') return Math.min(Math.abs(p.x-b.x), Math.abs(p.x-b.x-b.width), Math.abs(p.y-b.y), Math.abs(p.y-b.y-b.height)) <= tolerance + mark.width;
    if (mark.kind === 'ellipse') return Math.abs(Math.hypot((p.x-b.x-b.width/2)/(b.width/2), (p.y-b.y-b.height/2)/(b.height/2))-1) * Math.min(b.width,b.height)/2 <= tolerance + mark.width;
    return true;
  });
}
export function arrowPoints(mark: ImageMark) {
  const angle = Math.atan2(mark.to.y-mark.from.y, mark.to.x-mark.from.x), length = Math.max(mark.width*4, mark.fontSize*.65);
  return [ { x: mark.to.x-length*Math.cos(angle-.5), y: mark.to.y-length*Math.sin(angle-.5) }, mark.to,
    { x: mark.to.x-length*Math.cos(angle+.5), y: mark.to.y-length*Math.sin(angle+.5) } ];
}
export const markHalo = (color:string) => ['#ffffff','#e0a126'].includes(color) ? '#202124' : '#ffffff';
export const markOutline = (mark: Pick<ImageMark, 'kind' | 'outline' | 'color'>): string | undefined =>
  mark.kind === 'cover' || mark.outline === 'none' ? undefined : mark.outline === 'light' ? '#ffffff' : mark.outline === 'dark' ? '#202124' : markHalo(mark.color);
export const markOpacity = (mark: Pick<ImageMark, 'kind' | 'opacity'>) => mark.kind === 'cover' ? 1 : mark.opacity ?? 1;
export async function readImageSource(src: string, signal?: AbortSignal): Promise<ImageAttachment> {
  const host=getRuntimeEndpointGeneration();
  signal?.throwIfAborted();
  const inline=/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src);
  if(inline)return {mimeType:inline[1]!,data:inline[2]!};
  const response = /^https?:\/\//i.test(src)
    ? await runtimeFetch('/api/images/read', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:src}),signal })
    : await fetch(src, { signal, referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Image read failed');
  const blob = await response.blob();
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
  signal?.throwIfAborted();
  if(host!==getRuntimeEndpointGeneration())throw new DOMException('Host changed','AbortError');
  return { data, mimeType: blob.type || 'image/png' };
}
export async function decodeImage(source: ImageAttachment) {
  const image = new Image(); image.src = imageUrl(source); await image.decode(); return image;
}
export async function createAnnotationDocument(src: string, signal?: AbortSignal): Promise<ImageAnnotationDocument> {
  const source = await readImageSource(src, signal), image = await decodeImage(source);
  signal?.throwIfAborted();
  return { source, width: image.naturalWidth, height: image.naturalHeight, marks: [], past: [], future: [] };
}
const exports = new WeakMap<ImageAnnotationDocument,Promise<ImageAttachment>>();
export function flattenAnnotations(doc:ImageAnnotationDocument):Promise<ImageAttachment> {
  let result=exports.get(doc);
  if(!result){result=exportAnnotations(doc);exports.set(doc,result);void result.catch(()=>exports.delete(doc));}
  return result;
}
/** Also used at send time if a viewer was unmounted before its edits were exported. */
export async function prepareAnnotatedImages(images:readonly ImageAttachment[]):Promise<ImageAttachment[]> {
  return Promise.all(images.map(async image=>{
    const doc=(image as EditableImageAttachment).annotation, rendered=doc?await flattenAnnotations(doc):image;
    return {data:rendered.data,mimeType:rendered.mimeType,...(image.reference===undefined?{}:{reference:image.reference})};
  }));
}
/** Export at original resolution. Covers are opaque pixels; source/layers never go to the model. */
async function exportAnnotations(doc: ImageAnnotationDocument): Promise<ImageAttachment> {
  if (!doc.marks.length) return doc.source;
  const source = await decodeImage(doc.source), canvas = document.createElement('canvas');
  canvas.width = doc.width; canvas.height = doc.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Image export unavailable');
  ctx.drawImage(source, 0, 0);
  let layer: HTMLCanvasElement | undefined;
  for (const mark of doc.marks) {
    const opacity = markOpacity(mark);
    if (opacity === 1) drawAnnotation(ctx, mark);
    else if (opacity > 0) {
      // Composite each translucent mark once, so overlapping outline/arrow segments
      // have the same opacity as the SVG group used by the live preview.
      layer ??= document.createElement('canvas');
      if (layer.width !== doc.width || layer.height !== doc.height) { layer.width = doc.width; layer.height = doc.height; }
      const paint = layer.getContext('2d'); if (!paint) throw new Error('Image export unavailable');
      paint.clearRect(0, 0, layer.width, layer.height); drawAnnotation(paint, mark);
      ctx.save(); ctx.globalAlpha = opacity; ctx.drawImage(layer, 0, 0); ctx.restore();
    }
  }
  if (layer) { layer.width = 0; layer.height = 0; }
  const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(value=>value ? resolve(value) : reject(new Error('Image export failed')), 'image/png'));
  canvas.width=0;canvas.height=0;
  const url=URL.createObjectURL(blob);
  try { return await readImageSource(url); } finally { URL.revokeObjectURL(url); }
}

function drawAnnotation(ctx: CanvasRenderingContext2D, mark: ImageMark) {
    ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = mark.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const outline = markOutline(mark);
    const b = markBounds(mark);
    const path = () => {
      ctx.beginPath();
      if (mark.kind === 'rectangle') ctx.rect(b.x,b.y,b.width,b.height);
      else if (mark.kind === 'ellipse') ctx.ellipse(b.x+b.width/2,b.y+b.height/2,b.width/2,b.height/2,0,0,Math.PI*2);
      else if (mark.kind === 'pen') (mark.points ?? []).forEach((p,i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y));
      else { ctx.moveTo(mark.from.x,mark.from.y); ctx.lineTo(mark.to.x,mark.to.y); const points=arrowPoints(mark); ctx.moveTo(points[0]!.x,points[0]!.y); points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); }
    };
    if (mark.kind === 'cover') { ctx.fillStyle = '#101010'; ctx.fillRect(b.x,b.y,b.width,b.height); }
    else if (mark.kind === 'text') {
      ctx.font = `600 ${mark.fontSize}px system-ui, sans-serif`; ctx.textBaseline='top'; ctx.lineWidth=Math.max(2,mark.fontSize/8); if(outline)ctx.strokeStyle=outline;
      (mark.text ?? '').split('\n').forEach((line,i) => { const y=mark.from.y+i*mark.fontSize*1.3; if(outline)ctx.strokeText(line,mark.from.x,y); ctx.fillText(line,mark.from.x,y); });
    } else if (mark.kind === 'number') {
      ctx.beginPath(); ctx.arc(mark.from.x,mark.from.y,mark.fontSize*.85,0,Math.PI*2); ctx.fill(); if(outline){ctx.strokeStyle=outline;ctx.lineWidth=Math.max(2,mark.width*.6);ctx.stroke();}
      ctx.fillStyle=markHalo(mark.color);ctx.font=`600 ${mark.fontSize}px system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(mark.number),mark.from.x,mark.from.y);
    } else {
      if(outline){path(); ctx.strokeStyle=outline;ctx.lineWidth=mark.width+Math.max(1,mark.width*.5);ctx.stroke();}
      path(); ctx.strokeStyle=mark.color;ctx.lineWidth=mark.width;ctx.stroke();
    }
    ctx.restore();
}
