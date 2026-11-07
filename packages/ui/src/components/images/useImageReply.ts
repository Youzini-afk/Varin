import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity } from '@varin/application-client';
import { ConversationPreviewContext, useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { useThreadStore, threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';
import type { ImageAnnotationBinding } from './ImageViewer';
export const ImageReplyDraftContext=React.createContext<string|null>(null);

export function useImageReply(identity?: ThreadIdentity, sourcePrefix='image'): ImageAnnotationBinding | undefined {
  const conversation=useOptionalConversationPresentation(), target=identity??conversation?.identity, {t}=useI18n();
  const preview=React.useContext(ConversationPreviewContext);
  const explicitDraft=React.useContext(ImageReplyDraftContext);
  const host=getRuntimeEndpointGeneration(), hostKey=useThreadStore(state=>state.hostKey);
  const key=explicitDraft??(target?threadComposerKey(hostKey||threadHostKey(),target):undefined);
  return React.useMemo(()=>!key||conversation?.readOnly||preview?undefined:{
    mode:'reply' as const,
    get:source=>useThreadDraftStore.getState().drafts[key]?.imageAnnotations?.[`${sourcePrefix}:${source}`],
    save:(source,doc)=>{
      if(host!==getRuntimeEndpointGeneration())return;
      useThreadDraftStore.getState().patch(key,draft=>({imageAnnotations:{...draft.imageAnnotations,[`${sourcePrefix}:${source}`]:doc}}));
    },
    apply:(_source,image,doc)=>{
      if(host!==getRuntimeEndpointGeneration())throw new Error('Host changed');
      useThreadDraftStore.getState().patch(key,draft=>{
        const reference=Math.max(draft.imageReferenceSequence??0,...draft.images.map(image=>image.reference??0))+1;
        return {images:[...draft.images,{...image,reference,annotation:doc}],text:[draft.text,t('chat.imageReference.token',{number:reference})].filter(Boolean).join(' ')};
      });
    },
  },[key,host,sourcePrefix,t,conversation?.readOnly,preview]);
}
