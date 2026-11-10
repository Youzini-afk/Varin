import React from 'react';
import { bindRenderedMarkdownSource } from '@/components/chat/markdown/sourceBlocks';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ConversationImage, ConversationImageViewer } from '@/components/images/ConversationImage';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ThreadAttachments } from '@/components/thread/ThreadAttachments';
import { ThreadMedia } from '@/components/thread/ThreadMedia';
import { useI18n } from '@/lib/i18n';
import { flattenAnnotations, imageUrl } from '@/lib/images/annotations';
import { ChatTextSource } from './ChatContextMenu';
import { ChatCollapsibleUserContent } from './ChatCollapsibleUserContent';
import { ContentReferencePreview } from './ContentReferencePreview';
import { BoundReferenceContext, boundReferenceClassName, validReferenceOccurrences, type BoundReferenceMarker } from './chatBoundReferenceMarkers';
import { useOptionalConversationPresentation } from './ConversationContext';
import type { ChatUserMessage, ChatImageContent } from './types';

/** Presentation of the same frozen input used for admission. The full quote stays
 * collapsed in its preview and only explicitly bound occurrences become buttons. */
export function ChatUserReferences({ message, messageId, plain, readAttachment }: {
  message: ChatUserMessage; messageId: string; plain: boolean;
  readAttachment?(ref: string, signal: AbortSignal): Promise<Blob>;
}) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const [selected, setSelected] = React.useState<{ kind: 'content'; ref: string } | { kind: 'image'; reference: number }>();
  const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const references = message.contentReferences ?? [];
  const images = typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'image');
  const number = (ref: string) => references.find(item => item.ref === ref)?.number ?? references.findIndex(item => item.ref === ref) + 1;
  const markers = React.useMemo(() => validReferenceOccurrences(text, message.contentReferenceOccurrences).flatMap((occurrence): BoundReferenceMarker[] => {
    const reference = occurrence.kind === 'content' ? references.find(item => item.ref === occurrence.ref) : undefined;
    const imageExists = occurrence.kind === 'image' && (message.imageParts?.some(item => item.reference === occurrence.reference) || images.some(item => item.reference === occurrence.reference)
      || message.fileAttachments?.some(item => message.attachmentImageReferences?.[item.ref] === occurrence.reference)
      || message.pendingImageFiles?.some(item => item.reference === occurrence.reference));
    if (!reference && !imageExists) return [];
    const label = text.slice(occurrence.start, occurrence.end);
    return [{ occurrence, label, description: reference ? `${label} · ${reference.label || reference.title}` : label }];
  // The input is frozen; the arrays are replaced only when the original receipt changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [message, text]);
  const bound = React.useMemo(() => ({ markers, open(index: number) {
    const occurrence = markers[index]?.occurrence;
    if (occurrence) setSelected(occurrence.kind === 'content' ? { kind: 'content', ref: occurrence.ref } : { kind: 'image', reference: occurrence.reference });
  } }), [markers]);
  const plainContent: React.ReactNode[] = [];
  let offset = 0;
  for (const [index, marker] of markers.entries()) {
    plainContent.push(text.slice(offset, marker.occurrence.start));
    plainContent.push(<button key={index} type="button" data-bound-reference={index} className={boundReferenceClassName} aria-label={marker.description} onClick={() => bound.open(index)}>{marker.label}</button>);
    offset = marker.occurrence.end;
  }
  plainContent.push(text.slice(offset));
  const reference = selected?.kind === 'content' ? references.find(item => item.ref === selected.ref) : selected?.kind === 'image' ? references.find(item => item.imageReference === selected.reference) : undefined;
  const imageNumber = selected?.kind === 'image' ? selected.reference : reference?.imageReference;
  const inlineImage = images.find(item => item.reference === imageNumber);
  const storedImage = message.imageParts?.find(item => item.reference === imageNumber);
  const fileImage = message.fileAttachments?.find(item => message.attachmentImageReferences?.[item.ref] === imageNumber);
  const pendingImage = message.pendingImageFiles?.find(item => item.reference === imageNumber);
  const image = storedImage && conversation ? <ThreadMedia api={conversation.api} identity={conversation.identity}
    holder={{ kind: 'history', itemId: messageId }} media={storedImage.media} partIndex={storedImage.partIndex} imageReference={storedImage.reference} thumbnail />
    : fileImage && (conversation || readAttachment) ? <ThreadAttachments api={conversation?.api} identity={conversation?.identity} read={readAttachment} attachments={[fileImage]} />
      : pendingImage ? <FrozenFileImage file={pendingImage} messageId={messageId} />
        : inlineImage ? <FrozenInlineImage image={inlineImage} messageId={messageId} /> : undefined;
  return <>
    <ChatCollapsibleUserContent><ChatTextSource entryId={messageId} text={text} offset={0} role="user">
      {plain ? <div ref={element => { if (element) bindRenderedMarkdownSource(element, text, 0, 0, true); }} data-chat-source-start={0} data-chat-source-end={text.length} className="markdown-content whitespace-pre-wrap break-words">{plainContent}</div>
        : <BoundReferenceContext.Provider value={bound}><div onClickCapture={event => {
          const button = (event.target as Element).closest?.('[data-bound-reference]');
          if (!button) return;
          const index = Number(button.getAttribute('data-bound-reference'));
          if (!Number.isInteger(index) || !markers[index]) return;
          event.preventDefault(); event.stopPropagation(); bound.open(index);
        }}><MarkdownRenderer content={text} messageId={messageId} /></div></BoundReferenceContext.Provider>}
    </ChatTextSource></ChatCollapsibleUserContent>
    {references.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('ui.content.preview')}>
      {references.filter(item => item.imageReference === undefined).map(item => <button key={item.ref} type="button" onClick={() => setSelected({ kind: 'content', ref: item.ref })}
        className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-background/40 px-2 py-1 text-left typography-micro">
        <span className="shrink-0">{t('ui.content.reference', { number: number(item.ref) })}</span>
        <span className="min-w-0 max-w-72 truncate">· {item.label || item.title}{item.text ? `: ${item.text.replace(/\s+/gu, ' ').slice(0, 100)}` : ''}</span>
      </button>)}
    </div>}
    {images.map((part, index) => <FrozenInlineImage key={index} image={part} messageId={messageId} />)}
    {message.pendingImageFiles?.map(file => <FrozenFileImage key={file.reference} file={file} messageId={messageId} />)}
    {reference && <ContentReferencePreview key={reference.ref} reference={reference} number={number(reference.ref)} attachments={message.fileAttachments} image={image} readAttachment={readAttachment} onClose={() => setSelected(undefined)} />}
    {selected?.kind === 'image' && !reference && (inlineImage && !inlineImage.annotation ? <ConversationImageViewer sourceId={`${messageId}:image:${imageNumber}`} label={t('chat.imageReference.token', { number: imageNumber })}
      src={`data:${inlineImage.mimeType};base64,${inlineImage.data}`} onClose={() => setSelected(undefined)} />
      : <Dialog open onOpenChange={open => { if (!open) setSelected(undefined); }}><DialogContent aria-describedby={undefined}>
        <DialogTitle>{t('chat.imageReference.token', { number: imageNumber })}</DialogTitle>{image}
      </DialogContent></Dialog>)}
  </>;
}

function FrozenFileImage({ file, messageId }: { file: NonNullable<ChatUserMessage['pendingImageFiles']>[number]; messageId: string }) {
  const { t } = useI18n();
  const [url, setUrl] = React.useState<string>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let active = true; setError(false); setUrl(undefined);
    if (file.annotation) {
      void flattenAnnotations(file.annotation).then(image => { if (active) setUrl(imageUrl(image)); }, () => { if (active) setError(true); });
      return () => { active = false; };
    }
    const url = URL.createObjectURL(file.data); setUrl(url); return () => URL.revokeObjectURL(url);
  }, [file.data, file.annotation]);
  return url ? <ConversationImage sourceId={`${messageId}:file-image:${file.reference}`} src={url} label={file.filename} reference={file.reference} />
    : <p role={error ? 'alert' : 'status'}>{t(error ? 'imageEditor.failed' : 'imageEditor.saving')}</p>;
}

function FrozenInlineImage({ image, messageId }: { image: ChatImageContent; messageId: string }) {
  const { t } = useI18n();
  const [rendered, setRendered] = React.useState<{ annotation: ChatImageContent['annotation']; src: string }>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let active = true; setError(false);
    if (image.annotation) void flattenAnnotations(image.annotation).then(value => { if (active) setRendered({ annotation: image.annotation, src: imageUrl(value) }); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [image.annotation]);
  const src = image.annotation ? rendered?.annotation === image.annotation ? rendered.src : undefined : imageUrl(image);
  return src ? <ConversationImage sourceId={`${messageId}:image:${image.reference}`} src={src} label={image.mimeType} reference={image.reference} />
    : <p role={error ? 'alert' : 'status'}>{t(error ? 'imageEditor.failed' : 'imageEditor.saving')}</p>;
}
