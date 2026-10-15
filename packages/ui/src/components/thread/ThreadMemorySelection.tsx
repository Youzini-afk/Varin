import React from 'react';
import { BotRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ChatMemoryReceipt, ThreadMemoryAPI, ThreadMemoryDraft, ThreadMemoryPassage, ThreadMemorySelection as Selection } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function ThreadMemorySelection({ api, identity, itemId, text }: { api: ThreadMemoryAPI; identity: Selection; itemId: string; text: string }) {
  const [range, setRange] = React.useState({ start: 0, end: text.length });
  const [selected, setSelected] = React.useState<{ identity: Selection; sources: ThreadMemoryPassage[] } | null>(null);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  React.useEffect(() => { setSelected(null); setRange({ start: 0, end: text.length }); }, [host, itemId, text, identity.threadId, identity.branchId]);
  return <details className="mt-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Remember a passage</summary>
    <p className="py-2">Select the original text below, or keep the whole message. Preview before saving a memory.</p>
    <textarea aria-label="Original memory source" readOnly value={text} rows={4} className="w-full rounded border bg-background p-2"
      onSelect={event => { const input = event.currentTarget; setRange({ start: input.selectionStart, end: input.selectionEnd }); }} />
    <Button variant="ghost" size="sm" disabled={range.end <= range.start} onClick={() => setSelected({ identity: { ...identity }, sources: [{ itemId, start: range.start, text: text.slice(range.start, range.end) }] })}>Preview memory</Button>
    {selected && <MemoryDraftDialog key={JSON.stringify([host, selected.identity, selected.sources])} api={api} selection={selected.identity} sources={selected.sources} onClose={() => setSelected(null)} />}
  </details>;
}

export function MemoryDraftDialog({ api, selection, sources, onClose }: { api: ThreadMemoryAPI; selection: Selection; sources: ThreadMemoryPassage[]; onClose(): void }) {
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const [request, setRequest] = React.useState<{ requestKey: string; retryOf?: string }>(() => ({ requestKey: crypto.randomUUID() }));
  const [attempt, setAttempt] = React.useState(0);
  const [result, setResult] = React.useState<Awaited<ReturnType<ThreadMemoryAPI['preview']>> | null>(null);
  const [failure, setFailure] = React.useState<{ message: string; retry: 'observe' | 'new_attempt' | 'none' } | null>(null);
  const [receipts, setReceipts] = React.useState<Record<number, ChatMemoryReceipt>>({});
  const [target, setTarget] = React.useState<'owner' | 'user'>('owner');
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);
  const controller = React.useRef<AbortController | null>(null);
  const current = React.useCallback(() => alive.current && host === getRuntimeEndpointGeneration(), [host]);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  React.useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setResult(null); setFailure(null);
    void api.preview({ ...selection, ...request, sources }, abort.signal).then(value => {
      if (current() && !abort.signal.aborted) setResult(value);
    }, cause => { if (current() && !abort.signal.aborted) setFailure({ message: cause instanceof Error ? cause.message : 'Memory preview unavailable', retry: cause instanceof BotRequestError ? cause.retryDisposition ?? 'observe' : 'observe' }); });
    return () => abort.abort();
  }, [api, selection, sources, request, attempt, current]);
  const mutate = async (work: () => Promise<void>) => {
    if (busy || !current()) return;
    setBusy(true); setFailure(null);
    try { await work(); } catch (cause) { if (current()) setFailure({ message: cause instanceof Error ? cause.message : 'Memory update failed', retry: 'none' }); }
    finally { if (current()) setBusy(false); }
  };
  const save = (draft: ThreadMemoryDraft, index: number) => mutate(async () => {
    if (!result) return;
    const receipt = await api.save({ ...selection, target, expectedOwner: result.owner, draft });
    if (current()) setReceipts(previous => ({ ...previous, [index]: receipt }));
  });
  const undo = (index: number) => mutate(async () => {
    const receipt = receipts[index]; if (!receipt?.created || !result) return;
    await api.undo({ ...selection, target, expectedOwner: result.owner, id: receipt.item.id,
      expected: { content: receipt.item.content, trigger: receipt.item.trigger, status: 'accepted', invalidAt: receipt.item.invalidAt ?? null } });
    if (current()) setReceipts(previous => { const next = { ...previous }; delete next[index]; return next; });
  });
  return <Dialog open onOpenChange={open => { if (!open) { alive.current = false; controller.current?.abort(); onClose(); } }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Remember selected history</DialogTitle></DialogHeader>
      {failure && <p role="alert" className="text-sm text-destructive">{failure.message}</p>}
      {!result && !failure && <p role="status">Preparing memory preview…</p>}
      {!result && failure && failure.retry !== 'none' && <Button onClick={() => {
        if (failure.retry === 'new_attempt') setRequest({ requestKey: crypto.randomUUID(), retryOf: request.requestKey });
        else setAttempt(value => value + 1);
      }}>Retry preview</Button>}
      {result?.drafts.length === 0 && <p>No lasting memory was found in this selection.</p>}
      {result && result.drafts.length > 0 && <>
        <label className="space-y-1 text-sm">Save to<select aria-label="Memory destination" className="block w-full rounded border bg-background p-2" disabled={busy || Object.keys(receipts).length > 0} value={target} onChange={event => setTarget(event.target.value === 'user' ? 'user' : 'owner')}>
          <option value="owner">{result.owner.scope === 'bot' ? 'This Bot' : result.owner.scope}</option><option value="user">User memory</option>
        </select></label>
        {result.drafts.map((draft, index) => <section key={index} className="space-y-2 border-t pt-3">
          <label className="block text-sm">Memory<textarea aria-label={`Memory draft ${index + 1}`} rows={3} className="block w-full rounded border bg-background p-2" value={draft.content} disabled={busy || Boolean(receipts[index])}
            onChange={event => setResult({ ...result, drafts: result.drafts.map((item, at) => at === index ? { ...item, content: event.target.value } : item) })} /></label>
          <label className="block text-sm">When useful<input aria-label={`Memory trigger ${index + 1}`} className="block w-full rounded border bg-background p-2" value={draft.trigger} disabled={busy || Boolean(receipts[index])}
            onChange={event => setResult({ ...result, drafts: result.drafts.map((item, at) => at === index ? { ...item, trigger: event.target.value } : item) })} /></label>
          <details><summary>Original source</summary>{draft.sources.map((source, at) => <p key={at} className="whitespace-pre-wrap text-sm">{source.text}</p>)}</details>
          {receipts[index] ? <div role="status">Saved{receipts[index].created && <Button variant="ghost" disabled={busy} onClick={() => void undo(index)}>Undo</Button>}</div>
            : <Button disabled={busy || !draft.content.trim()} onClick={() => void save(draft, index)}>Save memory</Button>}
        </section>)}
      </>}
    </DialogContent>
  </Dialog>;
}
