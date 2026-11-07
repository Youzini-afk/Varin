import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ConversationImageViewer } from '@/components/images/ConversationImage';
import { ThreadMedia } from '@/components/thread/ThreadMedia';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import type { ChatToolExecutionState } from './types';
import type { ViewedImage } from './viewedImages';
import { ExpandedToolContext, ViewedImageDetailsContext } from './toolDisclosureContext';

export function ChatViewedImages({ callId, images, status, children }: {
  callId: string; images: ViewedImage[]; status: ChatToolExecutionState['status']; children: React.ReactNode;
}) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const [preview, setPreview] = React.useState<{src:string;id:string}>();
  return <ToolDisclosure id={`images:${callId}`} className="tool-viewed-images">
    <summary className="tool-viewed-images-heading typography-meta">
      <Icon name="file-image" className="size-3.5 shrink-0" />
      <span>{t('chat.images.viewed', { count: images.length })}</span>
      {status !== 'success' && <ToolStatus status={status} />}
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5 shrink-0" />
    </summary>
    <div className="tool-viewed-images-body">
      <div className="tool-viewed-images-grid">
        {images.map(image => {
          if (image.kind === 'stored') return conversation
            ? <ThreadMedia key={`${JSON.stringify(image.holder)}:${image.partIndex}`} api={conversation.api} identity={conversation.identity}
              holder={image.holder}
              media={image.media} partIndex={image.partIndex} thumbnail />
            : <span key={image.partIndex} className="typography-micro text-muted-foreground">{t('chat.images.unavailable')}</span>;
          const src = image.image.data.startsWith('data:') ? image.image.data : `data:${image.image.mimeType};base64,${image.image.data}`;
          return <button key={image.partIndex} type="button" className="tool-viewed-image" aria-label={t('chat.media.view')} onClick={() => setPreview({src,id:`${callId}:${image.partIndex}`})}>
            <img src={src} alt={t('chat.media.image')} loading="lazy" decoding="async" />
          </button>;
        })}
      </div>
      <ToolDisclosure id={`image-details:${callId}`} className="tool-invocation-details">
        <summary>{t('chat.tools.details')}</summary>
        <ViewedImageDetailsContext.Provider value={callId}>
          <ExpandedToolContext.Provider value={true}>{children}</ExpandedToolContext.Provider>
        </ViewedImageDetailsContext.Provider>
      </ToolDisclosure>
      {preview && <ConversationImageViewer src={preview.src} sourceId={preview.id} onClose={()=>setPreview(undefined)} />}
    </div>
  </ToolDisclosure>;
}
