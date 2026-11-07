import React from 'react';
import { RiCursorLine, RiPencilLine, RiArrowRightUpLine, RiCheckboxBlankLine, RiCheckboxBlankCircleLine, RiText, RiHashtag, RiCheckboxBlankFill, RiArrowGoBackLine, RiArrowGoForwardLine, RiDeleteBinLine, RiEqualizer2Line } from '@remixicon/react';
import { Popover } from '@base-ui/react/popover';
import { AnnotationMark } from './ImageAnnotationCanvas';
import { useI18n } from '@/lib/i18n';
import type { AnnotationTool, AnnotationOutline, ImageAnnotationDocument } from '@/lib/images/annotations';

const tools = { select:RiCursorLine,arrow:RiArrowRightUpLine,rectangle:RiCheckboxBlankLine,ellipse:RiCheckboxBlankCircleLine,pen:RiPencilLine,text:RiText,number:RiHashtag,cover:RiCheckboxBlankFill };
const ANNOTATION_COLORS=['#e34d59','#e0a126','#3b9270','#477bc5','#9864be','#202124','#ffffff'];
export function ImageAnnotationTools({tool,setTool,color,setColor,weight,setWeight,commitWeight,outline,setOutline,opacity,setOpacity,commitOpacity,styleTool,document:doc,undo,redo,remove,clear,selected}: {
  tool:AnnotationTool;setTool(tool:AnnotationTool):void;color:string;setColor(color:string):void;weight:number;setWeight(value:number):void;
  document:ImageAnnotationDocument;undo():void;redo():void;remove():void;clear():void;selected:boolean;
  commitWeight():void;
  outline:AnnotationOutline;setOutline(value:AnnotationOutline):void;
  opacity:number;setOpacity(value:number):void;commitOpacity():void;styleTool:AnnotationTool;
}) {
  const {t}=useI18n();
  const [portal,setPortal]=React.useState<HTMLElement|null>(null);
  const attach=React.useCallback((element:HTMLButtonElement|null)=>{setPortal(element?.closest<HTMLElement>('[data-slot="dialog-content"], [role="dialog"]')??null);},[]);
  const strokeVisible=!['cover','text','number'].includes(styleTool);
  const previewKind=styleTool==='select'?'arrow':styleTool;
  return <div className="image-annotation-tools">
    <div role="toolbar" aria-label={t('imageEditor.tools')} className="image-annotation-toolrow">
      {Object.entries(tools).map(([name,Glyph])=><button type="button" key={name} aria-label={t(`imageEditor.tool.${name as AnnotationTool}`)} title={t(`imageEditor.tool.${name as AnnotationTool}`)} aria-pressed={tool===name} onClick={()=>setTool(name as AnnotationTool)}><Glyph size={18}/></button>)}
      <span className="image-annotation-divider" />
      <button type="button" onClick={undo} disabled={!doc.past.length} aria-label={t('imageEditor.undo')} title={`${t('imageEditor.undo')} · Ctrl/⌘ Z`}><RiArrowGoBackLine size={18}/></button>
      <button type="button" onClick={redo} disabled={!doc.future.length} aria-label={t('imageEditor.redo')} title={`${t('imageEditor.redo')} · Ctrl/⌘ Shift Z`}><RiArrowGoForwardLine size={18}/></button>
      <button type="button" onClick={remove} disabled={!selected} aria-label={t('imageEditor.delete')} title={t('imageEditor.delete')}><RiDeleteBinLine size={18}/></button>
      <button type="button" className="image-annotation-clear" onClick={clear} disabled={!doc.marks.length}>{t('imageEditor.clear')}</button>
    </div>
    <div className="image-annotation-properties">
      <div role="group" aria-label={t('imageEditor.color')} className="image-annotation-colors">{ANNOTATION_COLORS.map((value,index)=><button type="button" key={value} disabled={styleTool==='cover'} aria-label={t(`imageEditor.color.${index as 0|1|2|3|4|5|6}`)} aria-pressed={color===value} onClick={()=>setColor(value)} style={{'--swatch':value} as React.CSSProperties}/>)}</div>
      {strokeVisible&&<label>{t('imageEditor.weight')}<input type="range" min="1" max="12" step="1" value={weight} onChange={e=>setWeight(Number(e.target.value))} onPointerUp={commitWeight} onPointerCancel={commitWeight} onKeyUp={commitWeight} onBlur={commitWeight}/><output>{Math.round(weight)} px</output></label>}
      {styleTool!=='cover'&&<Popover.Root onOpenChange={open=>{if(!open)commitOpacity();}}>
        <Popover.Trigger ref={attach} className="image-annotation-style-trigger"><RiEqualizer2Line size={15}/>{t('imageEditor.style')}</Popover.Trigger>
        <Popover.Portal container={portal}>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-[70]">
            <Popover.Popup className="image-annotation-style-popup motion-popover" onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}}>
              <div className="image-annotation-style-heading"><Popover.Title>{t('imageEditor.style')}</Popover.Title><span>{t(selected?'imageEditor.styleSelected':'imageEditor.styleNext')}</span></div>
              <div className="image-annotation-style-preview" aria-hidden="true"><svg viewBox="0 0 240 66">
                <AnnotationMark mark={{id:'preview',kind:previewKind,color,width:weight,fontSize:22,outline,opacity,from:{x:28,y:25},to:{x:210,y:42},points:[{x:28,y:38},{x:70,y:28},{x:115,y:38},{x:170,y:25},{x:210,y:30}],text:t('imageEditor.text'),number:1}} />
              </svg></div>
              <div className="image-annotation-style-field"><span>{t('imageEditor.outline')}</span>
                <div className="image-annotation-outline-options" role="group" aria-label={t('imageEditor.outline')}>
                  {(['none','light','dark','auto'] as const).map(value=><button type="button" key={value} aria-pressed={outline===value} onClick={()=>setOutline(value)}>{t(`imageEditor.outline.${value}`)}</button>)}
                </div>
              </div>
              <label className="image-annotation-style-field"><span>{t('imageEditor.opacity')}<output>{Math.round(opacity*100)}%</output></span>
                <input type="range" min="0" max="100" step="1" value={Math.round(opacity*100)} onChange={event=>setOpacity(Number(event.target.value)/100)} onPointerUp={commitOpacity} onPointerCancel={commitOpacity} onKeyUp={commitOpacity} onBlur={commitOpacity}/>
              </label>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>}
      <span className="image-annotation-hint">{t(styleTool==='cover'?'imageEditor.coverHint':'imageEditor.panHint')}</span>
    </div>
  </div>;
}
