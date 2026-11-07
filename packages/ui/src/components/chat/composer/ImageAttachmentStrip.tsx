import React from 'react';
import type { EditableImageAttachment } from '@/lib/images/annotations';
import { Icon } from '@/components/icon/Icon';
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
  return <><div className="flex flex-wrap gap-2 px-3 pt-3">
    {images.map((image, index) => <div key={image.reference ?? index} className="composer-attachment group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
      <button type="button" onClick={() => setPreview({reference:image.reference??index+1,editing:false})} aria-label={`${t('chat.media.view')} ${image.reference ?? index + 1}`}
        className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <img src={imageAttachmentUrl(image)} alt={t('chat.imageReference.token', { number: image.reference ?? index + 1 })} className="size-20 object-cover" />
      </button>
      {onReference ? <button type="button" onMouseDown={event => event.preventDefault()}
        onClick={() => onReference(image.reference ?? index + 1)}
        title={t('chat.imageReference.insert', { number: image.reference ?? index + 1 })}
        aria-label={t('chat.imageReference.insert', { number: image.reference ?? index + 1 })}
        className="absolute bottom-1 left-1 min-w-5 rounded bg-background/85 px-1.5 py-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {image.reference ?? index + 1}
      </button> : <span className="pointer-events-none absolute bottom-1 left-1 min-w-5 rounded bg-background/85 px-1.5 py-0.5 text-center text-[11px] leading-4 tabular-nums text-muted-foreground">{image.reference ?? index + 1}</span>}
      {onRemove && <button type="button" onClick={() => onRemove(index)}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
        aria-label={removeLabel}>
        <Icon name="close" className="size-3.5" />
      </button>}
      {image.annotation?.marks.length ? <span className="composer-image-edited" title={t('imageEditor.edited')} /> : null}
      {onUpdate && <button type="button" className="composer-image-annotate" aria-label={t('imageEditor.annotate')} onClick={()=>setPreview({reference:image.reference??index+1,editing:true})}><Icon name="pencil" className="size-3.5"/></button>}
    </div>)}
  </div>{preview&&initialIndex>=0&&<ImageViewer initialIndex={initialIndex} initiallyEditing={preview.editing} onClose={()=>setPreview(undefined)} load={load}
    items={images.map((image,index)=>({source:String(image.reference??index+1),label:t('chat.imageReference.token',{number:image.reference??index+1})}))}
    annotation={onUpdate?{mode:'draft',get:source=>current.current.images.find((image,index)=>String(image.reference??index+1)===source)?.annotation,
      save:(source,annotation)=>{const index=current.current.images.findIndex((image,index)=>String(image.reference??index+1)===source);if(index>=0)current.current.onUpdate?.(index,{...current.current.images[index]!,annotation});},
      apply:(source,image,annotation)=>{const index=current.current.images.findIndex((image,index)=>String(image.reference??index+1)===source);if(index>=0)current.current.onUpdate?.(index,{...current.current.images[index]!,...image,annotation});},
    }:undefined}/>}</>;
}
