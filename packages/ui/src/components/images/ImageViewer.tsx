import React from 'react';
import type { ImageAttachment } from '@varin/protocol';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ImageAnnotationCanvas, type AnnotationCanvasHandle } from './ImageAnnotationCanvas';
import { ImageAnnotationTools } from './ImageAnnotationTools';
import { commitMarks, createAnnotationDocument, flattenAnnotations, imageUrl, readImageSource, undoMarks, redoMarks, type AnnotationTool, type AnnotationOutline, type ImageMark, type ImageAnnotationDocument } from '@/lib/images/annotations';
import type { MarkdownImageAsset, MarkdownImageItem } from '@/components/chat/markdown/markdownImages';

export interface ImageAnnotationBinding {
  mode:'draft'|'reply'; get(source:string):ImageAnnotationDocument|undefined;
  quote?(source:string, prepare:()=>Promise<ImageAttachment>, document?:ImageAnnotationDocument):Promise<void>;
  save(source:string,document:ImageAnnotationDocument):void;
  apply(source:string,image:ImageAttachment,document:ImageAnnotationDocument):void|Promise<void>;
}
/** The same viewer serves composer attachments, message images and retained tool media. */
export function ImageViewer({items,initialIndex,load,onClose,annotation,initiallyEditing=false,footer}: {
  items:MarkdownImageItem[]; initialIndex:number;load(source:string,signal:AbortSignal):Promise<MarkdownImageAsset>;onClose():void;
  annotation?:ImageAnnotationBinding;initiallyEditing?:boolean;
  footer?:React.ReactNode;
}) {
  const {t}=useI18n();
  const [host]=React.useState(getRuntimeEndpointGeneration);
  const closeOwner=React.useRef(onClose);closeOwner.current=onClose;
  React.useEffect(()=>subscribeRuntimeEndpointWillChange(()=>closeOwner.current()),[]);
  const [open,setOpen]=React.useState(true),[index,setIndex]=React.useState(initialIndex);
  const [asset,setAsset]=React.useState<{source:string;value:MarkdownImageAsset}>(),[failed,setFailed]=React.useState(false),[retry,setRetry]=React.useState(0);
  const [size,setSize]=React.useState({width:0,height:0}),[viewportSize,setViewportSize]=React.useState({width:0,height:0}),[zoom,setZoom]=React.useState(1);
  const [doc,setDoc]=React.useState<ImageAnnotationDocument>(),[editing,setEditing]=React.useState(initiallyEditing),[selected,setSelected]=React.useState<string|null>(null);
  const [tool,setTool]=React.useState<AnnotationTool>('arrow'),[color,setColor]=React.useState('#e34d59'),[weight,setWeight]=React.useState(3);
  const [previewWeight,setPreviewWeight]=React.useState<number>();
  const [outline,setOutline]=React.useState<AnnotationOutline>('none'),[opacity,setOpacity]=React.useState(1),[previewOpacity,setPreviewOpacity]=React.useState<number>();
  const [busy,setBusy]=React.useState(false),[editError,setEditError]=React.useState(''),[space,setSpace]=React.useState(false),[showOriginal,setShowOriginal]=React.useState(false);
  const viewport=React.useRef<HTMLDivElement>(null),canvas=React.useRef<AnnotationCanvasHandle>(null),alive=React.useRef(true);
  const binding=React.useRef(annotation);binding.current=annotation;
  const documents=React.useRef(new Map<string,ImageAnnotationDocument>()),dirty=React.useRef(new Set<string>());
  const originals=React.useRef(new Map<string,{controller:AbortController;result:Promise<MarkdownImageAsset>}>());
  const editingRead=React.useRef<AbortController|null>(null),working=React.useRef(false);
  const item=items[index]??items[0]!,source=item.originalSource??item.source;
  const loaded=asset?.source===source?asset.value:undefined;
  const fit=size.width&&size.height&&viewportSize.width&&viewportSize.height?Math.min(1,viewportSize.width/size.width,viewportSize.height/size.height):1;
  const scale=fit*zoom, rendered={width:size.width*scale,height:size.height*scale};
  const anchor=React.useRef<{x:number;y:number;contentX:number;contentY:number}|null>(null),previous=React.useRef({width:0,height:0});
  const points=React.useRef(new Map<number,{x:number;y:number}>()),pan=React.useRef<{x:number;y:number;left:number;top:number}|null>(null),pinch=React.useRef<{distance:number;zoom:number;contentX:number;contentY:number}|null>(null);
  const sourceRef=React.useRef(source);sourceRef.current=source;
  React.useEffect(()=>{
    let active=true;editingRead.current?.abort();setBusy(false);working.current=false;setAsset(undefined);setFailed(false);setEditError('');setZoom(1);setSize({width:0,height:0});setSelected(null);setShowOriginal(false);previous.current={width:0,height:0};
    const retained=documents.current.get(source),saved=retained??binding.current?.get(source);setDoc(undefined);
    let entry=originals.current.get(source);
    if(!entry){const controller=new AbortController();entry={controller,result:load(source,controller.signal)};originals.current.set(source,entry);}
    const check=new AbortController();
    void entry.result.then(async value=>{
      // A path/URL can change between visits. Reuse edits only for their original pixels.
      let matching=saved;
      if(saved&&!retained&&binding.current?.mode==='reply'){
        try{const bytes=await readImageSource(value.src,check.signal);if(bytes.data!==saved.source.data||bytes.mimeType!==saved.source.mimeType)matching=undefined;}
        catch{matching=undefined;}
      }
      if(active){if(matching)documents.current.set(source,matching);setDoc(matching);setAsset({source,value});}
    },()=>{if(active)setFailed(true);});
    return()=>{active=false;check.abort();};
  },[source,load,retry]);
  React.useEffect(()=>{alive.current=true;const cache=originals.current;return()=>{
    alive.current=false;editingRead.current?.abort();for(const value of cache.values()){value.controller.abort();void value.result.then(asset=>asset.release?.(),()=>{});}cache.clear();
  };},[]);
  const detachViewport=React.useRef<(()=>void)|undefined>(undefined);
  const attachViewport=React.useCallback((element:HTMLDivElement|null)=>{
    detachViewport.current?.();detachViewport.current=undefined;viewport.current=element;if(!element)return;
    const measure=()=>setViewportSize({width:element.clientWidth,height:element.clientHeight});measure();
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);observer?.observe(element);
    detachViewport.current=()=>observer?.disconnect();
  },[]);
  const hasDocument=Boolean(doc);
  React.useLayoutEffect(()=>{
    const element=viewport.current;if(element)setViewportSize({width:element.clientWidth,height:element.clientHeight});
  },[editing,hasDocument,busy,editError]);
  const changeZoom=(value:number,x?:number,y?:number)=>{
    const element=viewport.current;if(!element||!Number.isFinite(value)||value<=0)return;
    const px=x??element.clientWidth/2,py=y??element.clientHeight/2,old=previous.current;
    anchor.current={x:px,y:py,contentX:(element.scrollLeft+px-(old.width-size.width*scale)/2)/scale,contentY:(element.scrollTop+py-(old.height-size.height*scale)/2)/scale};setZoom(value);
  };
  const zoomRef=React.useRef(changeZoom);zoomRef.current=changeZoom;
  React.useEffect(()=>{
    const element=viewport.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const b=element.getBoundingClientRect();zoomRef.current(zoom*Math.exp(-event.deltaY*.002),event.clientX-b.left,event.clientY-b.top);};
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[zoom,loaded]);
  React.useLayoutEffect(()=>{
    const element=viewport.current;if(!element)return;
    const old=previous.current,w=Math.max(rendered.width,viewportSize.width),h=Math.max(rendered.height,viewportSize.height),a=anchor.current;
    if(a){element.scrollLeft=a.contentX*scale+(w-rendered.width)/2-a.x;element.scrollTop=a.contentY*scale+(h-rendered.height)/2-a.y;anchor.current=null;}
    else if(old.width&&old.height){element.scrollLeft=(element.scrollLeft+element.clientWidth/2)/old.width*w-element.clientWidth/2;element.scrollTop=(element.scrollTop+element.clientHeight/2)/old.height*h-element.clientHeight/2;}
    previous.current={width:w,height:h};
  },[rendered.width,rendered.height,viewportSize.width,viewportSize.height,scale]);
  const change=(next:ImageAnnotationDocument)=>{documents.current.set(source,next);dirty.current.add(source);setDoc(next);binding.current?.save(source,next);};
  const enterEditing=async()=>{
    setEditing(true);if(doc||!loaded||!binding.current||working.current)return;
    working.current=true;setBusy(true);setEditError('');const controller=new AbortController();editingRead.current=controller;const original=source;
    try{const next=await createAnnotationDocument(loaded.src,controller.signal);if(!alive.current||controller.signal.aborted||sourceRef.current!==original)return;documents.current.set(source,next);setDoc(next);binding.current.save(source,next);}
    catch{if(!controller.signal.aborted)setEditError(t('imageEditor.readFailed'));}
    finally{if(!controller.signal.aborted){editingRead.current=null;working.current=false;setBusy(false);}}
  };
  const editRef=React.useRef(enterEditing);editRef.current=enterEditing;
  React.useEffect(()=>{if(editing&&loaded&&!doc&&!editError)void editRef.current();},[editing,loaded,doc,editError]);
  const exportDocument=flattenAnnotations;
  const close=async(applyReply=false)=>{
    if(editingRead.current){editingRead.current.abort();editingRead.current=null;working.current=false;}
    if(working.current)return;canvas.current?.finishText();commitStyle();working.current=true;setBusy(true);setEditError('');
    try{
      if(binding.current?.mode==='draft')for(const key of dirty.current){const document=documents.current.get(key)!,image=await exportDocument(document);if(host!==getRuntimeEndpointGeneration()||!alive.current)return;await binding.current.apply(key,image,document);}
      else if(applyReply&&binding.current){const document=documents.current.get(source)??doc;if(document){const target=binding.current;if(target.quote)await target.quote(source,()=>exportDocument(document),document);else{const image=await exportDocument(document);if(host!==getRuntimeEndpointGeneration()||!alive.current)return;await target.apply(source,image,document);}}}
      if(alive.current)setOpen(false);
    }catch{if(alive.current)setEditError(t('imageEditor.failed'));}
    finally{working.current=false;if(alive.current)setBusy(false);}
  };
  const undo=()=>{if(cancelStyle()||canvas.current?.cancelGesture())return;if(doc)change(undoMarks(doc));setSelected(null);};
  const redo=()=>{if(cancelStyle())return;canvas.current?.cancelGesture();if(doc)change(redoMarks(doc));setSelected(null);};
  const remove=()=>{if(doc&&selected)change(commitMarks(doc,doc.marks.filter(m=>m.id!==selected)));setSelected(null);};
  const updateSelected=(update:Partial<Pick<ImageMark,'color'|'width'|'outline'|'opacity'>>)=>{if(doc&&selected&&doc.marks.some(mark=>mark.id===selected&&Object.entries(update).some(([key,value])=>mark[key as keyof typeof update]!==value)))change(commitMarks(doc,doc.marks.map(mark=>mark.id===selected?{...mark,...update}:mark)));};
  const select=(id:string|null)=>{setSelected(id);setPreviewWeight(undefined);setPreviewOpacity(undefined);const mark=doc?.marks.find(mark=>mark.id===id);if(mark){setColor(mark.color);setWeight(mark.width*scale);setOutline(mark.outline??'auto');setOpacity(mark.opacity??1);}};
  const stylePreview={...(previewWeight===undefined?{}:{width:previewWeight/scale}),...(previewOpacity===undefined?{}:{opacity:previewOpacity})};
  const shownDoc=doc&&(previewWeight!==undefined||previewOpacity!==undefined)?{...doc,marks:doc.marks.map(mark=>mark.id===selected?{...mark,...stylePreview}:mark)}:doc;
  const cancelStyle=()=>{
    if(previewWeight===undefined&&previewOpacity===undefined)return false;
    const mark=doc?.marks.find(mark=>mark.id===selected);
    const changed=Boolean(mark&&(previewWeight!==undefined&&previewWeight/scale!==mark.width||previewOpacity!==undefined&&previewOpacity!==(mark.opacity??1)));
    if(mark){setWeight(mark.width*scale);setOpacity(mark.opacity??1);}
    setPreviewWeight(undefined);setPreviewOpacity(undefined);return changed;
  };
  const commitStyle=()=>{updateSelected(stylePreview);setPreviewWeight(undefined);setPreviewOpacity(undefined);};
  const selectedMark=doc?.marks.find(mark=>mark.id===selected);
  const step=(delta:number)=>{if(working.current)return;canvas.current?.finishText();canvas.current?.cancelGesture();commitStyle();setIndex(value=>(value+delta+items.length)%items.length);};
  const button=(label:string,icon:React.ComponentProps<typeof Icon>['name'],action:()=>void)=> <button type="button" className="md-image-viewer-action" title={label} aria-label={label} onClick={action}><Icon name={icon} className="size-4"/></button>;
  const quote=async()=>{
    if (!loaded || !binding.current?.quote || working.current) return;
    canvas.current?.finishText(); commitStyle();
    const capturedSource = source, capturedAsset = loaded, capturedDocument = documents.current.get(source) ?? doc;
    const capturedBinding = binding.current;
    working.current = true; setBusy(true); setEditError('');
    try {
      await capturedBinding.quote!(capturedSource, () => capturedDocument ? exportDocument(capturedDocument) : readImageSource(capturedAsset.src), capturedDocument);
    } catch (failure) { if (alive.current) setEditError(failure instanceof Error ? failure.message : t('imageEditor.failed')); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const download=async()=>{
    try{
      canvas.current?.finishText();commitStyle();const document=documents.current.get(source);const image=document?await exportDocument(document):undefined;
      const link=window.document.createElement('a');link.href=image?imageUrl(image):loaded!.src;
      const name=item.label.split(/[\\/]/).at(-1)||'image',extension=image?.mimeType.split('/')[1]?.replace('jpeg','jpg');
      link.download=extension?`${name.replace(/\.[^.]+$/,'')}.${extension}`:name;link.click();
    }catch{setEditError(t('imageEditor.failed'));}
  };
  return <Dialog open={open} onOpenChange={next=>{if(!next)void close();}} onOpenChangeComplete={next=>{if(!next)onClose();}}>
    <DialogContent className="md-image-viewer" onKeyDown={event=>{
      const target=event.target as HTMLElement;
      if(target.matches('textarea,[contenteditable=true],input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=radio]):not([type=button])')){event.stopPropagation();return;}
      if(editing&&annotation&&(event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();if(event.key.toLowerCase()==='y'||event.shiftKey)redo();else undo();return;}
      if(editing&&annotation&&['Delete','Backspace'].includes(event.key)){event.preventDefault();event.stopPropagation();remove();return;}
      if(event.code==='Space'&&!target.closest('button,input')){event.preventDefault();setSpace(true);}
      if(items.length>1&&!editing&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();step(event.key==='ArrowLeft'?-1:1);}
    }} onKeyUp={event=>{if(event.code==='Space')setSpace(false);}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setSpace(false);}}>
      <div className="md-image-viewer-toolbar">
        <DialogTitle className="min-w-0 flex-1 truncate typography-ui-label">{item.label||t('chat.media.image')}</DialogTitle>
        {items.length>1&&<div className="md-image-viewer-navigation">{button(t('chat.toolOutputDialog.image.previousAria'),'arrow-left-s',()=>step(-1))}<span className="typography-micro">{index+1} / {items.length}</span>{button(t('chat.toolOutputDialog.image.nextAria'),'arrow-right-s',()=>step(1))}</div>}
        {button(t('markdownRenderer.mermaid.actions.zoomOutTitle'),'subtract',()=>changeZoom(zoom/1.25))}
        <button type="button" className="md-image-viewer-action md-image-viewer-scale typography-micro" onClick={()=>changeZoom(1)} title={t('chat.images.fit')}>{size.width?`${Math.round(scale*100)}%`:'—'}</button>
        {button(t('markdownRenderer.mermaid.actions.zoomInTitle'),'add',()=>changeZoom(zoom*1.25))}
        <button type="button" className="md-image-viewer-action typography-micro" onClick={()=>changeZoom(1/fit)} title={t('chat.images.actualSize')}>1:1</button>
        {loaded&&button(t('chat.media.download'),'download',()=>void download())}
        {annotation?.quote&&loaded&&<button type="button" className="md-image-viewer-action" disabled={busy} onClick={()=>void quote()}>{t('chat.context.quoteImage')}</button>}
        {annotation&&loaded&&<button type="button" className="md-image-viewer-action image-annotation-entry" disabled={busy} aria-pressed={editing} onClick={()=>{canvas.current?.finishText();if(editing)setEditing(false);else void enterEditing();}}>{t('imageEditor.annotate')}</button>}
        {editing&&doc&&annotation&&<button type="button" className="image-annotation-done" disabled={busy} onClick={()=>void close(annotation.mode==='reply')}>{t(annotation.mode==='reply'?'imageEditor.reply':'imageEditor.done')}</button>}
      </div>
      {editing&&doc&&annotation&&<ImageAnnotationTools document={doc} tool={tool} setTool={value=>{canvas.current?.finishText();commitStyle();setTool(value);if(value!=='select')setSelected(null);}} color={color} setColor={value=>{setColor(value);updateSelected({color:value});}} weight={weight} setWeight={value=>{setWeight(value);setPreviewWeight(value);}} commitWeight={commitStyle} outline={outline} setOutline={value=>{setOutline(value);updateSelected({outline:value});}} opacity={opacity} setOpacity={value=>{setOpacity(value);setPreviewOpacity(value);}} commitOpacity={commitStyle} styleTool={selectedMark?.kind??tool} undo={undo} redo={redo} remove={remove} selected={Boolean(selected&&doc.marks.some(m=>m.id===selected))} clear={()=>{change(commitMarks(doc,[]));setSelected(null);}}/>}
      {editError&&<p role="alert" className="image-annotation-status">{editError}<button type="button" onClick={()=>{setEditError('');if(!doc)void enterEditing();}}>{t('chat.media.retry')}</button></p>}
      {busy&&<p role="status" className="image-annotation-status">{t('imageEditor.saving')}</p>}
      <div ref={attachViewport} className="md-image-viewer-viewport" data-zoomed={zoom>1||space} data-annotating={editing||undefined} onPointerDownCapture={event=>{
        if((event.target as HTMLElement).closest('textarea'))return;
        if(event.pointerType==='touch')points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(points.current.size===2){canvas.current?.cancelGesture();pan.current=null;const [a,b]=[...points.current.values()],bounds=event.currentTarget.getBoundingClientRect();
          const x=(a!.x+b!.x)/2-bounds.left,y=(a!.y+b!.y)/2-bounds.top;
          pinch.current={distance:Math.max(1,Math.hypot(b!.x-a!.x,b!.y-a!.y)),zoom,contentX:(event.currentTarget.scrollLeft+x-(previous.current.width-rendered.width)/2)/scale,contentY:(event.currentTarget.scrollTop+y-(previous.current.height-rendered.height)/2)/scale};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();return;}
        if((!editing||showOriginal||space||event.button===1)&&(event.button===0||event.button===1)){
          pan.current={x:event.clientX,y:event.clientY,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();
        }
      }} onPointerMoveCapture={event=>{
        if(points.current.has(event.pointerId))points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(pinch.current&&points.current.size===2){const [a,b]=[...points.current.values()],bounds=event.currentTarget.getBoundingClientRect(),p=pinch.current;
          const nextZoom=p.zoom*Math.hypot(b!.x-a!.x,b!.y-a!.y)/p.distance,x=(a!.x+b!.x)/2-bounds.left,y=(a!.y+b!.y)/2-bounds.top;
          if(nextZoom>0){anchor.current={x,y,contentX:p.contentX,contentY:p.contentY};setZoom(nextZoom);if(nextZoom===zoom){event.currentTarget.scrollLeft=p.contentX*scale+(previous.current.width-rendered.width)/2-x;event.currentTarget.scrollTop=p.contentY*scale+(previous.current.height-rendered.height)/2-y;anchor.current=null;}}
          event.preventDefault();event.stopPropagation();return;}
        if(pan.current){event.currentTarget.scrollLeft=pan.current.left+pan.current.x-event.clientX;event.currentTarget.scrollTop=pan.current.top+pan.current.y-event.clientY;event.stopPropagation();}
      }} onPointerUpCapture={event=>{const wasPinching=Boolean(pinch.current);points.current.delete(event.pointerId);if(points.current.size<2)pinch.current=null;const remaining=points.current.values().next().value;pan.current=wasPinching&&remaining?{x:remaining.x,y:remaining.y,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop}:null;}} onPointerCancel={()=>{points.current.clear();pinch.current=null;pan.current=null;canvas.current?.cancelGesture();}}>
        {failed?<button type="button" className="md-image-viewer-empty typography-meta" onClick={()=>{const old=originals.current.get(source);old?.controller.abort();if(old)void old.result.then(value=>value.release?.(),()=>{});originals.current.delete(source);setRetry(value=>value+1);}}>{t('chat.images.failed')} · {t('chat.media.retry')}</button>:<>
          {!size.width&&<span role="status" className="md-image-viewer-empty typography-meta">{t('chat.media.loading')}</span>}
          {loaded&&<div className="md-image-viewer-plane" style={{width:Math.max(rendered.width,viewportSize.width),height:Math.max(rendered.height,viewportSize.height)}}>
            <div className="image-annotation-image" style={size.width?{width:rendered.width,height:rendered.height}:{visibility:'hidden'}}>
              <img src={doc?imageUrl(doc.source):loaded.src} alt={item.label} draggable={false} referrerPolicy="no-referrer" decoding="async" onError={()=>setFailed(true)} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} style={size.width?{width:rendered.width,height:rendered.height}:{visibility:'hidden'}}/>
              {shownDoc&&!showOriginal&&<ImageAnnotationCanvas ref={canvas} document={shownDoc} scale={scale} active={Boolean(annotation)&&editing&&!space&&!busy} tool={tool} color={color} weight={weight} outline={outline} opacity={opacity} selected={selected} onSelect={select} onChange={change} textLabel={t('imageEditor.text')}/>}
            </div>
          </div>}
        </>}
      </div>
      {doc&&<div className="image-annotation-footer"><button type="button" aria-pressed={showOriginal} onClick={()=>setShowOriginal(value=>!value)}>{t('imageEditor.original')}</button><span>{t('imageEditor.edited')} · {doc.marks.length}</span></div>}
      {footer&&<div className="image-viewer-extra-actions">{footer}</div>}
    </DialogContent>
  </Dialog>;
}
