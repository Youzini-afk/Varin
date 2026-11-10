import React from 'react';
import { useChatQuoteObject, captureAttachmentReference, addChatObjectReference } from '@/components/conversation/chatQuoteObjects';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { Attachment } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ConversationImageViewer } from '@/components/images/ConversationImage';
import { DraftFileImages } from '@/components/images/DraftFileImages';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { attachmentSize, updateDraftFileAnnotation } from '@/lib/agent-runtime/fileAttachments';
import type { DraftFileAttachment } from '@/stores/useThreadDraftStore';

type Reader = { api: Pick<ThreadsAPI, 'attachments'>; identity: ThreadIdentity };
/** Fixed typed objects only: names, Markdown paths and arbitrary tool JSON never become file grants. */
export function ThreadAttachments({ attachments, api, identity, read }: Partial<Reader> & { attachments?: readonly Attachment[]; read?: (ref: string, signal: AbortSignal) => Promise<Blob> }) {
  const { t } = useI18n();
  if (!attachments?.length) return null;
  return <div role="group" className="my-2 flex flex-wrap gap-2" aria-label={t('chat.attachments.files')}>
    {attachments.map((attachment, index) => <AttachmentCard key={JSON.stringify([getRuntimeEndpointGeneration(), identity, attachment.ref, index])} attachment={attachment} api={api} identity={identity} read={read} />)}
  </div>;
}

export function ThreadFileDrafts({ files = [], locked, onRemove, draftKey, onReference }: {
  files?: readonly DraftFileAttachment[]; locked: boolean; onRemove(id: string): void; draftKey?: string; onReference?(reference: number): void;
}) {
  const { t } = useI18n();
  const images = React.useMemo(() => files.filter(file => file.mimeType.startsWith('image/')), [files]);
  return files.length ? <div role="group" className="flex flex-wrap gap-2" aria-label={t('chat.attachments.files')}>
    <DraftFileImages key={draftKey} files={images} locked={locked} onRemove={onRemove} onReference={onReference}
      onUpdate={draftKey ? (id, doc, image) => updateDraftFileAnnotation(draftKey, id, doc, image) : undefined} />
    {files.filter(file => !file.mimeType.startsWith('image/')).map(file => <div key={file.id} className="min-w-0 max-w-full rounded-lg border border-border/60 p-2">
      <div className="flex items-start gap-2">
        <AttachmentCard draft attachment={{ ref: '', filename: file.filename, mimeType: file.mimeType, byteLength: file.data.size }} data={file.data} />
        <button type="button" disabled={locked || file.status === 'preparing'} aria-label={t('chat.attachments.remove', { name: file.filename })}
          onClick={() => onRemove(file.id)} className="text-muted-foreground hover:text-foreground disabled:opacity-40"><Icon name="close" className="size-4" /></button>
      </div>
    </div>)}
    {files.filter(file => file.status === 'preparing' || file.status === 'failed').map(file => <p key={file.id} role={file.status === 'failed' ? 'alert' : 'status'} className={`w-full typography-micro ${file.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
      {file.filename} · {t(`chat.attachments.${file.status}`)}{file.error ? `: ${file.error}` : ''}
    </p>)}
  </div> : null;
}

function AttachmentCard({ attachment, data, api, identity, read, draft }: { attachment: Attachment; data?: Blob; draft?: boolean; read?: (ref: string, signal: AbortSignal) => Promise<Blob> } & Partial<Reader>) {
  const { t } = useI18n();
  const localId=React.useId();
  const host = getRuntimeEndpointGeneration();
  const image = attachment.mimeType.startsWith('image/');
  const pdf = attachment.mimeType === 'application/pdf';
  const text = attachment.mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(attachment.mimeType);
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState<string>();
  const [preview, setPreview] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const card = React.useRef<HTMLDivElement>(null);
  const captureReference = React.useCallback(() => captureAttachmentReference(identity!, attachment,
    card.current?.closest<HTMLElement>('[data-conversation-entry-id]')?.dataset.conversationEntryId), [attachment, identity]);
  const quoteTarget = useChatQuoteObject(!draft && api && identity && attachment.ref ? captureReference : undefined);
  const owner = React.useRef<{ controller?: AbortController; url?: string; blob?: Blob }>({});
  React.useEffect(() => {
    const state = owner.current;
    return () => {
      state.controller?.abort();
      if (state.url) URL.revokeObjectURL(state.url);
      state.controller = undefined; state.url = undefined; state.blob = undefined;
    };
  }, []);
  const load = async () => {
    const state = owner.current;
    if (state.blob || state.controller) return state.blob;
    const controller = new AbortController(); state.controller = controller;
    setBusy(true); setError(undefined);
    try {
      const blob = data ?? (read ? await read(attachment.ref, controller.signal) : api && identity ? await api.attachments.read(identity, { ref: attachment.ref }, controller.signal) : undefined);
      if (!blob) throw new Error('The original attachment reader is unavailable.');
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      state.blob = blob; state.url = URL.createObjectURL(blob.slice(0, blob.size, attachment.mimeType)); setUrl(state.url);
      if (text) {
        const value = await blob.text();
        if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setPreview(value);
      }
      return blob;
    } catch (failure) {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (!controller.signal.aborted) { state.controller = undefined; setBusy(false); } }
  };
  const quote = async () => {
    if (!identity || !api || !attachment.ref || host !== getRuntimeEndpointGeneration()) return;
    try { await addChatObjectReference(identity, captureReference(), api); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const download = async () => {
    const blob = await load();
    if (!blob || !owner.current.url || host !== getRuntimeEndpointGeneration()) return;
    const link = document.createElement('a'); link.href = owner.current.url; link.download = attachment.filename;
    link.hidden = true; document.body.append(link); link.click(); link.remove();
  };
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    if (!image) return;
    if (data) { void loadRef.current(); return; }
    if (!card.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void loadRef.current(); }
    });
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [data, image]);
  return <div ref={node => { card.current = node; quoteTarget(node); }} data-chat-quote-object={!draft && api && identity && attachment.ref ? true : undefined} role="group" aria-label={attachment.filename} aria-busy={busy} className="min-w-0 max-w-full space-y-1 typography-meta" data-attachment-ref={attachment.ref || undefined}>
    <button type="button" title={attachment.filename} aria-label={t('chat.attachments.preview', { name: attachment.filename })}
      className="flex max-w-full items-center gap-2 text-left hover:text-primary" onClick={() => { setOpen(true); void load(); }}>
      {image && url ? <img src={url} alt={attachment.filename} className="size-12 rounded object-cover" /> : <Icon name={image ? 'file-image' : pdf ? 'file-pdf' : 'file'} className="size-5 shrink-0" />}
      <span className="min-w-0"><span className="block max-w-64 break-words" title={attachment.filename}>{attachment.filename}</span>
        <span className="block typography-micro text-muted-foreground">{attachmentSize(attachment.byteLength)}</span></span>
    </button>
    {!draft && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      {api && identity && attachment.ref && <button type="button" disabled={busy} onClick={() => void quote()}>{t(image ? 'chat.context.quoteImage' : 'chat.context.quoteFile')}</button>}
      <button type="button" aria-label={`${t('chat.media.download')}: ${attachment.filename}`} disabled={busy} onClick={() => void download()}>{t('chat.media.download')}</button>
      {attachment.ref && <button type="button" aria-label={`${t('chat.attachments.copyRef')}: ${attachment.filename}`} onClick={() => void copyTextToClipboard(attachment.ref).then(result => { if (!result.ok) setError(result.error); }).catch(failure => setError(String(failure)))}>{t('chat.attachments.copyRef')}</button>}
    </div>}
    {busy && <p role="status">{t('chat.media.loading')}</p>}
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    {open && url && image ? <ConversationImageViewer src={url} identity={identity} sourceId={attachment.ref || localId} sourceReference={identity ? captureReference().source : undefined} label={attachment.filename} onClose={()=>setOpen(false)}/> : <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-[90vw]" aria-describedby={undefined}><DialogTitle className="break-words">{attachment.filename}</DialogTitle>
      {url && image ? <img src={url} alt={attachment.filename} className="max-h-[70vh] max-w-full object-contain" />
        : url && pdf ? <iframe sandbox="" src={url} title={attachment.filename} className="h-[65vh] w-full" />
          : preview !== undefined ? <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words text-sm">{preview}</pre>
            : !busy && !error ? <p>{t('chat.attachments.noPreview')}</p> : null}
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-3 typography-meta">
        {!draft && <button type="button" aria-label={`${t('chat.media.download')}: ${attachment.filename}`} disabled={busy} onClick={() => void download()}>{t('chat.media.download')}</button>}
        {/* Do not open executable/HTML bytes under the application's Blob origin. */}
        {url && (image && attachment.mimeType !== 'image/svg+xml' || pdf) && <a href={url} target="_blank" rel="noopener noreferrer">{t('chat.attachments.open')}</a>}
      </div>
    </DialogContent></Dialog>}
  </div>;
}
