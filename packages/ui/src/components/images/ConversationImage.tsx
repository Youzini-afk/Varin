import React from 'react';
import type { ThreadIdentity, ContentReference } from '@varin/application-client';
import { ImageViewer } from './ImageViewer';
import { useImageReply } from './useImageReply';
import { useI18n } from '@/lib/i18n';

export function ConversationImageViewer({src,sourceId,label,identity,sourceReference,onClose,footer}: {src:string;sourceId?:string;label?:string;identity?:ThreadIdentity;sourceReference?:ContentReference['source'];onClose():void;footer?:React.ReactNode}) {
  const annotation=useImageReply(identity, 'image', sourceReference),load=React.useCallback(async()=>({src}),[src]);
  return <ImageViewer items={[{source:sourceId??src,label:label??''}]} initialIndex={0} load={load} onClose={onClose} annotation={annotation} footer={footer}/>;
}
export function ConversationImage({src,sourceId,label,reference}: {src:string;sourceId:string;label:string;reference?:number}) {
  const {t}=useI18n(),[open,setOpen]=React.useState(false);
  return <><button type="button" onClick={()=>setOpen(true)} aria-label={t('chat.media.view')} className="relative mt-2 block w-fit max-w-full overflow-hidden rounded-lg border border-border/70 bg-background">
    <img src={src} alt={label} className="max-h-[32rem] max-w-full object-contain"/>
    {reference!==undefined&&<span className="absolute bottom-1 left-1 rounded bg-background/85 px-1.5 py-0.5 typography-micro tabular-nums text-muted-foreground">{reference}</span>}
  </button>{open&&<ConversationImageViewer src={src} sourceId={sourceId} label={label} onClose={()=>setOpen(false)}/>}</>;
}
