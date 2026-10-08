import React from 'react';
import { NativeThreadRequestError } from '@varin/application-client';
import type { NativeThreadIdentity, NativeThreadSnapshot, NativeThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { NativeThreadProjection, nativeHistoryText } from '@/lib/native-runtime/thread-projection';

export function NativeThreadConversation({ api, identity }: { api: NativeThreadsAPI; identity: NativeThreadIdentity }) {
  const [snapshot, setSnapshot] = React.useState<NativeThreadSnapshot>();
  const [progress, setProgress] = React.useState('');
  const [text, setText] = React.useState('');
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [models, setModels] = React.useState<Array<{ providerId: string; modelId: string; name?: string }>>([]);
  React.useEffect(() => { let active = true; void api.listModels().then(value => { if (active) setModels(value); }, value => { if (active) setError(value instanceof Error ? value.message : 'Model catalog unavailable'); }); return () => { active = false; }; }, [api]);
  const [error, setError] = React.useState<string>();
  const [inputMode, setInputMode] = React.useState<'boundary' | 'interrupt' | 'next_run'>('boundary');
  const [pending, setPending] = React.useState(false);
  const pendingInput = React.useRef<{ fingerprint: string; send(): Promise<unknown> } | undefined>(undefined);
  const projection = React.useRef<NativeThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    setSnapshot(undefined); setProgress(''); pendingInput.current = undefined;
    const view = new NativeThreadProjection(api, identity, setSnapshot, value => setError(value instanceof Error ? value.message : 'Native thread unavailable'), setProgress);
    projection.current = view; view.start();
    return () => view.close();
  }, [api, identity]);
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const active = Boolean(branch?.active_run_id);
  React.useEffect(() => {
    const config = run?.configuration as { providerId?: string; model?: string } | undefined;
    if (config?.providerId && config.model && (active || !providerId)) { setProviderId(config.providerId); setModelId(config.model); }
  }, [run?.configuration, active, providerId]);
  const act = async (work: () => Promise<unknown>) => {
    setPending(true); setError(undefined);
    try { await work(); await projection.current?.refresh(); }
    catch (value) {
      if (value instanceof NativeThreadRequestError && value.status === 409) { pendingInput.current = undefined; await projection.current?.refresh(); }
      setError(value instanceof Error ? value.message : 'Native thread request failed');
    }
    finally { setPending(false); }
  };
  return <section className="flex h-full min-h-0 flex-col" aria-label="Native thread conversation">
    <div className="border-b px-4 py-2 text-xs text-muted-foreground">nativeThread · {identity.threadId} · {run?.state ?? 'Ready'}{run?.waiting_on ? ` · ${run.waiting_on}` : ''}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
      {snapshot?.history.map(item => <article key={item.id} className="mx-auto max-w-3xl">
        <div className="mb-1 text-xs text-muted-foreground">{item.source}</div>
        <MarkdownRenderer messageId={item.id} content={nativeHistoryText(item.content)} />
      </article>)}
      {progress && <article className="mx-auto max-w-3xl" aria-label="Streaming assistant response"><MarkdownRenderer messageId={`${identity.threadId}:progress`} isStreaming content={progress} /></article>}
      {snapshot?.operations.map(operation => <div key={operation.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <div>Background operation · {operation.phase} · {operation.outcome ?? 'In progress'} · effect: {operation.effect}</div>
        {operation.external_receipt && <div className="text-xs text-muted-foreground">{operation.external_receipt.executor} · {operation.external_receipt.outcome}</div>}
        {operation.phase !== 'terminal' && <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelOperation(operation.id))}>Cancel operation</Button>}
      </div>)}
      {snapshot?.inputs.filter(input => input.state === 'queued').map(input => <div key={input.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <form onSubmit={event => { event.preventDefault(); const edited = new FormData(event.currentTarget).get('text');
          if (typeof edited === 'string') void act(() => api.editInput(input.id, input.revision, edited)); }}>
          <label className="text-xs text-muted-foreground">{input.mode}</label>
          <Textarea key={`${input.id}:${input.revision}`} name="text" aria-label="Edit queued input" defaultValue={nativeHistoryText(input.content)} />
          <Button type="submit" variant="ghost" size="sm">Save queued input</Button>
        </form>
        <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelInput(input.id, input.revision))}>Cancel queued input</Button>
      </div>)}
    </div>
    <form className="mx-auto w-full max-w-3xl space-y-2 p-4" onSubmit={event => {
      event.preventDefault();
      void act(async () => {
        const fingerprint = JSON.stringify([identity.threadId, identity.branchId, text, providerId, modelId, inputMode]);
        if (pendingInput.current?.fingerprint !== fingerprint) {
          const key = crypto.randomUUID();
          const submit = { ...identity, key, text, expectedHead: branch?.head ?? null, model: { providerId, modelId } };
          const queued = { ...identity, key, text, mode: inputMode };
          pendingInput.current = { fingerprint, send: active ? () => api.enqueue(queued) : () => api.submit(submit) };
        }
        await pendingInput.current.send();
        pendingInput.current = undefined;
        setText('');
      });
    }}>
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">Preparation needs attention: {snapshot.launch.preparation_failure}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <select aria-label="Registered model" disabled={active} className="w-full rounded border bg-background px-2 py-1 text-sm"
        value={JSON.stringify([providerId, modelId])} onChange={event => {
          const [provider, model] = JSON.parse(event.target.value) as [string, string]; setProviderId(provider); setModelId(model);
        }}>
        <option value={JSON.stringify(['', ''])}>Choose a registered model</option>
        {models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.providerId} · {model.name ?? model.modelId}</option>)}
      </select>
      {active && <select aria-label="Input delivery" className="rounded border bg-background text-sm" value={inputMode} onChange={event => setInputMode(event.target.value as typeof inputMode)}>
        <option value="boundary">At next model boundary</option><option value="interrupt">Interrupt current generation</option><option value="next_run">After current run</option>
      </select>}
      <Textarea aria-label="Message native thread" value={text} onChange={event => setText(event.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !text.trim() || (!active && (!providerId || !modelId))}>{active ? 'Queue message' : 'Send'}</Button>
        {active && branch?.active_run_id && <Button type="button" variant="outline" onClick={() => void act(() => api.cancelRun(branch.active_run_id!))}>Stop run</Button>}
        {run && !['completed', 'cancelled', 'failed'].includes(run.state) && <Button type="button" variant="ghost" onClick={() => void act(() => api.resume(run.id))}>Resume preparation</Button>}
      </div>
    </form>
  </section>;
}
