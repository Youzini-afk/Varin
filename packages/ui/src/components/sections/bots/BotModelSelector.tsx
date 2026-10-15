import React from 'react';
import type { BotModelSelection, ThreadModelInfo } from '@varin/application-client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Button } from '@/components/ui/button';

type Props = { model: BotModelSelection | null; disabled?: boolean; onChange(providerId: string, modelId: string): Promise<void> | void };
export function BotModelSelector({ model, disabled, onChange }: Props) {
  const { threads } = useRuntimeAPIs();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [models, setModels] = React.useState<ThreadModelInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    let alive = true; setModels(null); setError(null);
    if (!threads) { setError('Model catalog unavailable'); return; }
    void threads.listModels().then(value => { if (alive) setModels(value); }, cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Model catalog unavailable'); });
    return () => { alive = false; };
  }, [threads, host, revision]);
  const value = model ? JSON.stringify([model.providerId, model.modelId]) : '';
  return <div className="space-y-2">
    <select aria-label="Bot model" className="w-full rounded border bg-background p-2 text-sm" value={value} disabled={disabled || models === null} onChange={event => {
      const chosen = models?.find(item => JSON.stringify([item.providerId, item.modelId]) === event.target.value);
      void onChange(chosen?.providerId ?? '', chosen?.modelId ?? '');
    }}>
      <option value="">Use configured default model</option>
      {model && !models?.some(item => item.providerId === model.providerId && item.modelId === model.modelId) && <option value={value}>{model.providerId} · {model.modelId} (unavailable)</option>}
      {models?.map(item => <option key={JSON.stringify([item.providerId, item.modelId])} value={JSON.stringify([item.providerId, item.modelId])}>{item.providerId} · {item.name ?? item.modelId}</option>)}
    </select>
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={refresh}>Retry</Button></p>}
  </div>;
}
