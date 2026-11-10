import React from 'react';
import type { ContentReference, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { Attachment } from '@varin/protocol';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConversationImage } from '@/components/images/ConversationImage';
import { ThreadAttachments } from '@/components/thread/ThreadAttachments';
import { useI18n } from '@/lib/i18n';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { formatPdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import { ReferenceNavigationContext } from './ReferenceNavigation';
import { useOptionalConversationPresentation } from './ConversationContext';
import { contentReferenceSources, sameReferenceThread, type ContentReferenceSourceTarget } from './contentReferenceSources';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useConversationTreeStore } from '@/stores/useConversationTreeStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';

/** Frozen content, shared by draft and sent history. Opening this view never reads
 * the source again or re-runs a tool/interactive work. Resource viewers keep their
 * existing authenticated readers and retained input holder. */
export function ContentReferencePreview({ reference, number, onClose, onInsert, attachments, image, api, identity, readAttachment }: {
  reference: ContentReference;
  number?: number;
  onClose(): void;
  onInsert?(): void;
  attachments?: readonly Attachment[];
  image?: React.ReactNode;
  api?: Pick<ThreadsAPI, 'attachments'>;
  identity?: ThreadIdentity;
  readAttachment?(ref: string, signal: AbortSignal): Promise<Blob>;
}) {
  const { t } = useI18n();
  const navigation = React.useContext(ReferenceNavigationContext);
  const conversation = useOptionalConversationPresentation();
  const openMaterial = React.useContext(MaterialLinkContext);
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sources = contentReferenceSources(reference);
  const fileRef = reference.attachmentRef ?? reference.attachment?.ref;
  const file = attachments?.find(item => item.ref === fileRef);
  const reader = api ?? conversation?.api ?? getRegisteredRuntimeAPIs()?.threads;
  const owner = identity ?? conversation?.identity ?? ('thread' in reference.source ? reference.source.thread : undefined) ?? navigation?.identity;
  const host = getRuntimeEndpointGeneration();
  const assetKey = JSON.stringify([host, owner, fileRef]);
  const [loadedFile, setLoadedFile] = React.useState<{ key: string; file: Attachment; blob: Blob }>();
  const [fileError, setFileError] = React.useState<string>();
  React.useEffect(() => {
    if (image || !fileRef || file || !readAttachment && (!reader || !owner)) return;
    const controller = new AbortController();
    setFileError(undefined);
    void (readAttachment ? readAttachment(fileRef, controller.signal) : reader!.attachments.read(owner!, { ref: fileRef }, controller.signal)).then(blob => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setLoadedFile({ key: assetKey, file: { ref: fileRef, filename: reference.title, mimeType: blob.type || 'application/octet-stream', byteLength: blob.size }, blob });
    }, failure => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setFileError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [image, fileRef, file, reader, owner, host, assetKey, reference.title, readAttachment]);
  const loaded = loadedFile?.key === assetKey ? loadedFile : undefined;
  const locate = async (target: ContentReferenceSourceTarget) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (navigation && sameReferenceThread(target.thread, navigation.identity)) {
        if (!navigation.revealSource) throw new Error(t('chat.quote.sourceUnavailable'));
        await navigation.revealSource(target);
      } else {
        // The normal conversation navigator verifies the exact branch. Its own
        // history owner then loads only as far as this explicit source needs.
        const identity = await openThreadFromNavigation(target.thread);
        if (!sameReferenceThread(identity, target.thread)) throw new Error(t('chat.quote.sourceUnavailable'));
        useConversationTreeStore.getState().request(threadComposerKey(threadHostKey(), identity), {
          kind: 'reveal', entryId: target.entryId, runId: '', source: target,
        });
      }
      if (mounted.current) onClose();
    } catch {
      if (mounted.current) setError(t('chat.quote.sourceUnavailable'));
    } finally { if (mounted.current) setBusy(false); }
  };
  const document = reference.source.kind === 'document' ? reference.source : undefined;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl" aria-describedby={undefined}>
    <DialogHeader><DialogTitle>{reference.imageReference !== undefined ? t('chat.imageReference.token', { number: reference.imageReference }) : t('ui.content.reference', { number: number ?? reference.number ?? 1 })} · {reference.label || reference.title}</DialogTitle></DialogHeader>
    {reference.text !== undefined && <blockquote className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 p-3 text-sm">{reference.text}</blockquote>}
    {image ?? (reference.image && <ConversationImage sourceId={reference.ref} label={reference.title}
      src={`data:${reference.image.mimeType};base64,${reference.image.data}`} />)}
    {!image && (file || loaded) && (readAttachment || reader && owner) && <ThreadAttachments api={reader} identity={owner} attachments={[file ?? loaded!.file]}
      read={loaded ? async () => loaded.blob : readAttachment} />}
    {fileError && <p role="alert" className="typography-meta text-destructive">{fileError}</p>}
    {reference.source.kind === 'chat' && reference.source.streaming || reference.source.kind === 'tool' && reference.source.status === 'running'
      ? <p className="typography-meta text-muted-foreground">{t('chat.quote.capturedWhileRunning')}</p> : null}
    {error ? <p role="status" className="typography-meta text-muted-foreground">{error}</p>
      : !sources.length && !(document && openMaterial) ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.quote.sourceUnavailable')}</p> : null}
    <div className="flex flex-wrap gap-2">
      {sources.map((source, index) => <Button key={`${source.entryId}:${source.start ?? ''}:${index}`} variant="outline" disabled={busy}
        onClick={() => void locate(source)} title={source.text}>
        {t('ui.content.locateSource')}{sources.length > 1 ? ` ${index + 1}` : ''}
      </Button>)}
      {document && openMaterial && <Button variant="outline" onClick={() => { openMaterial(formatPdfMaterialCitationUrl(document), reference.title); onClose(); }}>{t('ui.content.locateSource')}</Button>}
      {onInsert && <Button variant="outline" onClick={onInsert}>{t('chat.quote.insertMarker')}</Button>}
    </div>
  </DialogContent></Dialog>;
}
