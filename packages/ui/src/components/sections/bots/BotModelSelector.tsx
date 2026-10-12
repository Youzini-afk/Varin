import React from 'react';
import type { BotModelSelection, ThreadModelInfo } from '@varin/application-client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';

type Props = { runtime: 'pi' | 'agent'; model: BotModelSelection | null; disabled?: boolean; cwd: string; onChange(providerId: string, modelId: string): Promise<void> | void };
export function BotModelSelector(props: Props) {
  return props.runtime === 'pi' ? <ModelSelector providerId={props.model?.providerId ?? ''} modelId={props.model?.modelId ?? ''}
    cwd={props.cwd} allowNone defaultSelectionLabel="Use Pi default model" disabled={props.disabled} onChange={props.onChange} />
    : <AgentBotModelSelector {...props} />;
}
function AgentBotModelSelector({ model, disabled, onChange }: Props) {
  const { threads } = useRuntimeAPIs();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [models, setModels] = React.useState<ThreadModelInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    let alive = true; setModels(null); setError(null);
    if (!threads) { setError('Agent model catalog unavailable'); return; }
    void threads.listModels().then(value => { if (alive) setModels(value); }, cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Agent model catalog unavailable'); });
    return () => { alive = false; };
  }, [threads, host, revision]);
  const value = model ? JSON.stringify([model.providerId, model.modelId]) : '';
  return <div className="space-y-2">
    <select aria-label="Bot Agent model" className="w-full rounded border bg-background p-2 text-sm" value={value} disabled={disabled || models === null} onChange={event => {
      const chosen = models?.find(item => JSON.stringify([item.providerId, item.modelId]) === event.target.value);
      void onChange(chosen?.providerId ?? '', chosen?.modelId ?? '');
    }}>
      <option value="">Use Agent runtime default model</option>
      {model && !models?.some(item => item.providerId === model.providerId && item.modelId === model.modelId) && <option value={value}>{model.providerId} · {model.modelId} (unavailable)</option>}
      {models?.map(item => <option key={JSON.stringify([item.providerId, item.modelId])} value={JSON.stringify([item.providerId, item.modelId])}>{item.providerId} · {item.name ?? item.modelId}</option>)}
    </select>
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={refresh}>Retry</Button></p>}
  </div>;
}
