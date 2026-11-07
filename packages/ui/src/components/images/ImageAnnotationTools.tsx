import React from 'react';
import { RiCursorLine, RiPencilLine, RiArrowRightUpLine, RiCheckboxBlankLine, RiCheckboxBlankCircleLine, RiText, RiHashtag, RiCheckboxBlankFill, RiArrowGoBackLine, RiArrowGoForwardLine, RiDeleteBinLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import type { AnnotationTool, ImageAnnotationDocument } from '@/lib/images/annotations';

const tools = { select:RiCursorLine,arrow:RiArrowRightUpLine,rectangle:RiCheckboxBlankLine,ellipse:RiCheckboxBlankCircleLine,pen:RiPencilLine,text:RiText,number:RiHashtag,cover:RiCheckboxBlankFill };
const ANNOTATION_COLORS=['#e34d59','#e0a126','#3b9270','#477bc5','#9864be','#202124','#ffffff'];
export function ImageAnnotationTools({tool,setTool,color,setColor,weight,setWeight,commitWeight,document:doc,undo,redo,remove,clear,selected}: {
  tool:AnnotationTool;setTool(tool:AnnotationTool):void;color:string;setColor(color:string):void;weight:number;setWeight(value:number):void;
  document:ImageAnnotationDocument;undo():void;redo():void;remove():void;clear():void;selected:boolean;
  commitWeight():void;
}) {
  const {t}=useI18n();
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
      <div role="group" aria-label={t('imageEditor.color')} className="image-annotation-colors">{ANNOTATION_COLORS.map((value,index)=><button type="button" key={value} disabled={tool==='cover'} aria-label={t(`imageEditor.color.${index as 0|1|2|3|4|5|6}`)} aria-pressed={color===value} onClick={()=>setColor(value)} style={{'--swatch':value} as React.CSSProperties}/>)}</div>
      <label>{t('imageEditor.weight')}<input type="range" min="1" max="12" step="1" value={weight} onChange={e=>setWeight(Number(e.target.value))} onPointerUp={commitWeight} onKeyUp={commitWeight} onBlur={commitWeight}/></label>
      <span className="image-annotation-hint">{t(tool==='cover'?'imageEditor.coverHint':'imageEditor.panHint')}</span>
    </div>
  </div>;
}
