import React from 'react';
import { getRuntimeKey, runtimeFetch, subscribeRuntimeEndpointChanged,
  type ChatMemoryDraft, type ChatMemoryExtraction, type ChatMemoryPassage, type ChatMemoryReceipt } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export const ChatMemoryDialog: React.FC<{
  sessionId: string;
  sources: ChatMemoryPassage[];
  onClose(): void;
}> = ({ sessionId, sources, onClose }) => {
  const { t } = useI18n();
  const [runtimeKey] = React.useState(getRuntimeKey);
  const [result, setResult] = React.useState<ChatMemoryExtraction | null>(null);
  const [error, setError] = React.useState('');
  const [target, setTarget] = React.useState<'owner' | 'user'>('owner');
  const [saving, setSaving] = React.useState(false);
  const [receipts, setReceipts] = React.useState<Record<number, ChatMemoryReceipt>>({});
  const [attempt, setAttempt] = React.useState(0);
  const mounted = React.useRef(true);
  const current = () => mounted.current && runtimeKey === getRuntimeKey();
  const base = `/api/harness/sessions/${encodeURIComponent(sessionId)}/knowledge/extracted`;
  React.useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeRuntimeEndpointChanged(onClose);
    return () => { mounted.current = false; unsubscribe(); };
  }, [onClose]);
  React.useEffect(() => {
    const controller = new AbortController();
    setError('');
    setResult(null);
    void (async () => {
      try {
        const response = await runtimeFetch(`${base}/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources }), signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || t('chat.context.failed'));
        if (!body.owner || !['workspace', 'bot', 'session', 'user'].includes(body.owner.scope)
          || (body.owner.ownerId !== null && typeof body.owner.ownerId !== 'string') || !Array.isArray(body.drafts)
          || !body.drafts.every((draft: ChatMemoryDraft) => typeof draft.content === 'string'
            && typeof draft.trigger === 'string' && ['experience', 'decision', 'preference', 'judgment', 'instruction'].includes(draft.nature)
            && Array.isArray(draft.sources) && draft.sources.length > 0
            && draft.sources.every((source) => typeof source.entryId === 'string' && typeof source.text === 'string'
              && Number.isSafeInteger(source.start) && typeof source.revision === 'string'))) throw new Error(t('chat.context.failed'));
        if (!controller.signal.aborted && runtimeKey === getRuntimeKey()) setResult(body);
      } catch (cause) {
        if (!controller.signal.aborted && runtimeKey === getRuntimeKey()) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [attempt, base, runtimeKey, sources, t]);

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
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{t('chat.context.extract')}</DialogTitle></DialogHeader>
      {error ? <div role="alert" className="typography-meta text-[var(--status-error)]">{error}</div> : null}
      {!result && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('chat.context.extracting')}</p> : null}
      {!result && error ? <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t('chat.context.retry')}</Button> : null}
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
