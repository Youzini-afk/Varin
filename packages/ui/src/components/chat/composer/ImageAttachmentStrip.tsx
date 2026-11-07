import React from 'react';
import type { EditableImageAttachment } from '@/lib/images/annotations';
import { ImagePreviewStrip } from '@/components/images/ImagePreviewStrip';
import { imageAttachmentUrl } from './imageAttachments';
import { ImageViewer } from '@/components/images/ImageViewer';
import { useI18n } from '@/lib/i18n';

export function ImageAttachmentStrip({ images, removeLabel, onRemove, onReference, onUpdate }: {
  images: readonly EditableImageAttachment[];
  removeLabel?: string;
  onRemove?: (index: number) => void;
  onReference?: (reference: number) => void;
  onUpdate?: (index: number, image: EditableImageAttachment) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = React.useState<{ reference:number; editing:boolean }>();
  const current = React.useRef({images,onUpdate});current.current={images,onUpdate};
  const load=React.useCallback(async(source:string)=>{const image=current.current.images.find((image,index)=>String(image.reference??index+1)===source);if(!image)throw new Error('Image removed');return {src:imageAttachmentUrl(image.annotation?.source??image)};},[]);
  const initialIndex=preview?images.findIndex((image,index)=>(image.reference??index+1)===preview.reference):-1;
  if (!images.length) return null;
  return <><div className="px-3 pt-3"><ImagePreviewStrip items={images.map((image,index)=>({id:String(image.reference??index+1),src:imageAttachmentUrl(image),reference:image.reference,edited:Boolean(image.annotation?.marks.length)}))}
    onPreview={(index,editing)=>setPreview({reference:images[index]!.reference??index+1,editing})}
    onRemove={onRemove} onReference={onReference} removeLabel={removeLabel} editable={Boolean(onUpdate)} />
  </div>{preview&&initialIndex>=0&&<ImageViewer initialIndex={initialIndex} initiallyEditing={preview.editing} onClose={()=>setPreview(undefined)} load={load}
    items={images.map((image,index)=>({source:String(image.reference??index+1),label:t('chat.imageReference.token',{number:image.reference??index+1})}))}
    annotation={onUpdate?{mode:'draft',get:source=>current.current.images.find((image,index)=>String(image.reference??index+1)===source)?.annotation,
      save:(source,annotation)=>{const index=current.current.images.findIndex((image,index)=>String(image.reference??index+1)===source);if(index>=0)current.current.onUpdate?.(index,{...current.current.images[index]!,annotation});},
      apply:(source,image,annotation)=>{const index=current.current.images.findIndex((image,index)=>String(image.reference??index+1)===source);if(index>=0)current.current.onUpdate?.(index,{...current.current.images[index]!,...image,annotation});},
    }:undefined}/>}</>;
}
