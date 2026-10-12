import React from 'react';
import { getRuntimeKey, runtimeFetch, subscribeRuntimeEndpointChanged,
  type ChatMemoryDraft, type ChatMemoryExtraction, type ChatMemoryPassage, type ChatMemoryReceipt } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface ChatMemoryDialogProps {
  sessionId: string;
  sources: ChatMemoryPassage[];
  onClose(): void;
}
type RetryDisposition = 'observe' | 'new_attempt' | 'none';
interface PreviewRequest { requestKey: string; retryOf?: string }

export const ChatMemoryDialog: React.FC<ChatMemoryDialogProps> = (props) => {
  // A new array or a language change is not a new selection. A genuinely different
  // selection remounts the editor, cancelling its observer and discarding old receipts.
  const selection = JSON.stringify([props.sessionId, props.sources.map(source =>
    [source.entryId, source.start, source.text, source.revision ?? null])]);
  return <SelectionMemoryDialog key={selection} {...props} />;
};

const SelectionMemoryDialog: React.FC<ChatMemoryDialogProps> = ({ sessionId, sources: selectedSources, onClose }) => {
  const { t } = useI18n();
  const [runtimeKey] = React.useState(getRuntimeKey);
  const [sources] = React.useState(() => selectedSources.map(source => ({ ...source })));
  const [request, setRequest] = React.useState<PreviewRequest>(() => ({ requestKey: crypto.randomUUID() }));
  const requestRef = React.useRef(request);
  const [retryDisposition, setRetryDisposition] = React.useState<RetryDisposition | null>(null);
  const previewController = React.useRef<AbortController | null>(null);
  const retrying = React.useRef(false);
  const callbacks = React.useRef({ onClose, failed: t('chat.context.failed') });
  callbacks.current = { onClose, failed: t('chat.context.failed') };
  const [result, setResult] = React.useState<ChatMemoryExtraction | null>(null);
  const [error, setError] = React.useState('');
  const [target, setTarget] = React.useState<'owner' | 'user'>('owner');
  const [saving, setSaving] = React.useState(false);
  const [receipts, setReceipts] = React.useState<Record<number, ChatMemoryReceipt>>({});
  const [attempt, setAttempt] = React.useState(0);
  const mounted = React.useRef(true);
  const current = () => mounted.current && runtimeKey === getRuntimeKey();
  const base = `/api/harness/sessions/${encodeURIComponent(sessionId)}/knowledge/extracted`;
  const close = React.useCallback(() => {
    mounted.current = false;
    // Stop waiting locally. This does not claim a dispatched provider request stopped.
    previewController.current?.abort();
    callbacks.current.onClose();
  }, []);
  React.useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeRuntimeEndpointChanged(close);
    return () => { mounted.current = false; unsubscribe(); };
  }, [close]);
  React.useEffect(() => {
    const controller = new AbortController();
    previewController.current = controller;
    const isCurrent = () => mounted.current && !controller.signal.aborted && runtimeKey === getRuntimeKey()
      && requestRef.current.requestKey === request.requestKey;
    setError('');
    setResult(null);
    setRetryDisposition(null);
    retrying.current = true;
    void (async () => {
      let disposition: RetryDisposition = 'observe';
      try {
        const response = await runtimeFetch(`${base}/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources, ...request }), signal: controller.signal,
        });
        const body = await response.json();
        if (!isCurrent()) return;
        if (!body || body.requestKey !== request.requestKey) throw new Error(callbacks.current.failed);
        if (!response.ok) {
          if (body.retryDisposition === 'observe' || body.retryDisposition === 'new_attempt' || body.retryDisposition === 'none') {
            disposition = body.retryDisposition;
          }
          throw new Error(typeof body.error === 'string' && body.error ? body.error : callbacks.current.failed);
        }
        if (!body.owner || !['workspace', 'bot', 'session', 'user'].includes(body.owner.scope)
          || (body.owner.ownerId !== null && typeof body.owner.ownerId !== 'string') || !Array.isArray(body.drafts)
          || !body.drafts.every((draft: ChatMemoryDraft) => typeof draft.content === 'string'
            && typeof draft.trigger === 'string' && ['experience', 'decision', 'preference', 'judgment', 'instruction'].includes(draft.nature)
            && Array.isArray(draft.sources) && draft.sources.length > 0
            && draft.sources.every((source) => typeof source.entryId === 'string' && typeof source.text === 'string'
              && Number.isSafeInteger(source.start) && typeof source.revision === 'string'))) throw new Error(callbacks.current.failed);
        if (isCurrent()) setResult(body);
      } catch (cause) {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause.message : String(cause));
          // A lost response is an observation failure, never proof of no external send.
          setRetryDisposition(disposition);
        }
      } finally { if (isCurrent()) retrying.current = false; }
    })();
    return () => controller.abort();
  }, [attempt, base, request, runtimeKey, sources]);

  const retry = () => {
    if (!current() || retrying.current || !error || !retryDisposition || retryDisposition === 'none') return;
    retrying.current = true;
    if (retryDisposition === 'new_attempt') {
      const next = { requestKey: crypto.randomUUID(), retryOf: requestRef.current.requestKey };
      requestRef.current = next;
      setRequest(next);
    } else setAttempt(value => value + 1);
  };

  const save = async () => {
    if (!result || saving || !current()) return;
    setSaving(true);
    setError('');
    try {
      for (const [index, draft] of result.drafts.entries()) {
        if (receipts[index] || !draft.content.trim()) continue;
        if (!current()) return;
        const response = await runtimeFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, expectedOwner: result.owner, draft }) });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error || t('chat.context.failed'));
        if (!receipt.item || !Number.isSafeInteger(receipt.item.id) || typeof receipt.created !== 'boolean'
          || typeof receipt.item.content !== 'string' || typeof receipt.item.trigger !== 'string' || receipt.item.status !== 'accepted') throw new Error(t('chat.context.failed'));
        if (!current()) return;
        setReceipts((previous) => ({ ...previous, [index]: receipt }));
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) setSaving(false); }
  };
  const undo = async (index: number) => {
    const receipt = receipts[index];
    if (!receipt?.created || !result || saving || !current()) return;
    setSaving(true);
    setError('');
    try {
      const response = await runtimeFetch(`${base}/${receipt.item.id}`, { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          target, expectedOwner: result.owner, expected: {
            content: receipt.item.content, trigger: receipt.item.trigger,
            status: receipt.item.status, invalidAt: receipt.item.invalidAt ?? null,
          },
        }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('chat.context.failed'));
      if (current()) setReceipts((previous) => { const next = { ...previous }; delete next[index]; return next; });
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) setSaving(false); }
  };
  const allSaved = !!result?.drafts.length && result.drafts.every((draft, index) => receipts[index] || !draft.content.trim());
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{t('chat.context.extract')}</DialogTitle></DialogHeader>
      {error ? <div role="alert" className="typography-meta text-[var(--status-error)]">{error}</div> : null}
      {!result && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.context.extracting')}</p> : null}
      {!result && error && retryDisposition && retryDisposition !== 'none' ? <Button variant="outline" onClick={retry}>{t('chat.context.retry')}</Button> : null}
      {result?.drafts.length === 0 ? <p className="typography-meta text-muted-foreground">{t('chat.context.empty')}</p> : null}
      {result && result.drafts.length > 0 ? <>
        <label className="grid gap-1.5 typography-meta">
          {t('chat.context.destination')}
          <select value={target} disabled={saving || Object.keys(receipts).length > 0}
            onChange={(event) => setTarget(event.target.value as 'owner' | 'user')}
            className="rounded-md border border-border bg-background px-2 py-2 text-foreground">
            <option value="owner">{t(`chat.context.owner.${result.owner.scope}`)}</option>
            {result.owner.scope !== 'user' ? <option value="user">{t('chat.context.owner.user')}</option> : null}
          </select>
        </label>
        {result.drafts.map((draft, index) => <section key={index} className="space-y-2 border-t border-border pt-3">
          <label className="grid gap-1 typography-meta">{t('harness.knowledge.content')}
            <textarea value={draft.content} disabled={saving || !!receipts[index]} rows={3}
              className="w-full resize-y rounded-md border border-border bg-background p-2 text-foreground"
              onChange={(event) => setResult({ ...result, drafts: result.drafts.map((row, at) => at === index ? { ...row, content: event.target.value } : row) })} />
          </label>
          <label className="grid gap-1 typography-meta">{t('harness.knowledge.trigger')}
            <input value={draft.trigger} disabled={saving || !!receipts[index]}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              onChange={(event) => setResult({ ...result, drafts: result.drafts.map((row, at) => at === index ? { ...row, trigger: event.target.value } : row) })} />
          </label>
          <details className="typography-meta text-muted-foreground">
            <summary className="cursor-pointer">{t('chat.context.source')}</summary>
            {draft.sources.map((source, at) => <blockquote key={at} className="mt-2 whitespace-pre-wrap break-words border-l border-border pl-3">{source.text}</blockquote>)}
          </details>
          {receipts[index] ? <div className="flex items-center gap-3 typography-meta" role="status">
            <span>{t('chat.context.saved')}</span>
            {receipts[index].created ? <button disabled={saving} onClick={() => void undo(index)} className="text-primary hover:underline">{t('chat.context.undo')}</button> : null}
          </div> : null}
        </section>)}
        <div className="flex justify-end"><Button disabled={saving || allSaved} onClick={() => void save()}>{t('chat.context.save')}</Button></div>
      </> : null}
    </DialogContent>
  </Dialog>;
};
