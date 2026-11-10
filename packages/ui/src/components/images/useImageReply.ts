import React from 'react';
import { insertDraftMarker } from '@/lib/agent-editor/contentReferences';
import { ensureDraftImageMarkers, beginImageInsertion } from '@/components/chat/composer/imageAttachments';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ContentReference } from '@varin/application-client';
import { ConversationPreviewContext, useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { useThreadStore, threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';
import { findMarkerComposer } from '@/components/chat/composer/editor/markerComposerRegistry';
import type { ImageAnnotationBinding } from './ImageViewer';
export const ImageReplyDraftContext=React.createContext<string|null>(null);

export function useImageReply(identity?: ThreadIdentity, sourcePrefix='image', provenance?: ContentReference['source']): ImageAnnotationBinding | undefined {
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
    quote: async (_source, prepare, doc) => {
      if (host !== getRuntimeEndpointGeneration()) throw new Error('Host changed');
      const insertion = beginImageInsertion(key, findMarkerComposer(key) ?? null, number => t('chat.imageReference.token', { number }));
      const source = provenance ? structuredClone(provenance) : undefined;
      try {
        const image = await prepare();
        if (host !== getRuntimeEndpointGeneration()) throw new Error('Host changed');
        await insertion.append({ ...image, annotation: doc }, source ? { ref: crypto.randomUUID(), title: t('chat.context.quoteImage'), image: { data: image.data, mimeType: image.mimeType }, source } : undefined);
      } finally { insertion.dispose(); }
    },
    apply:async (_source,image,doc)=>{
      if(host!==getRuntimeEndpointGeneration())throw new Error('Host changed');
      ensureDraftImageMarkers(key);
      const id = crypto.randomUUID();
      await insertDraftMarker(key, { id, host, kind: 'image', number: 1, label: t('chat.imageReference.token', { number: 1 }),
        payload: { kind: 'image', image: { ...image, draftId: id, annotation: doc } } });
    },
  },[key,host,sourcePrefix,t,conversation?.readOnly,preview,provenance]);
}
