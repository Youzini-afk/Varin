import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadModelInfo } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/** The Agent model registry has no Pi provider/session dependency. */
export function AgentRuntimeModelSelector({ host, providerId, modelId, onChange, disabled, placeholder }: {
  host: string; providerId: string; modelId: string; onChange(providerId: string, modelId: string): void; disabled: boolean; placeholder: string;
}) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    let active = true;
    const generation = getRuntimeEndpointGeneration();
    setLoading(true); setError(null); setModels([]);
    if (!api) { setError(t('settings.agents.modelsUnavailable')); setLoading(false); return; }
    void api.listModels().then(result => {
      if (!active || generation !== getRuntimeEndpointGeneration()) return;
      setModels(result); setLoading(false);
    }, cause => {
      if (!active || generation !== getRuntimeEndpointGeneration()) return;
      setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false);
    });
    return () => { active = false; };
  }, [api, host, attempt, t]);
  const selected = providerId && modelId ? JSON.stringify([providerId, modelId]) : '';
  const known = models.some(model => model.providerId === providerId && model.modelId === modelId);
  return <div className="space-y-2">
    <select aria-label={t('settings.varin.agents.detail.model')} className="h-9 w-full rounded-md border bg-background px-3 typography-meta" value={selected} disabled={disabled || loading}
      onChange={event => { const value = event.target.value ? JSON.parse(event.target.value) as [string, string] : ['', '']; onChange(value[0], value[1]); }}>
      <option value="">{loading ? t('common.loading') : placeholder}</option>
      {selected && !known && <option value={selected}>{providerId}/{modelId} · {t('common.unavailable')}</option>}
      {models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.name ?? model.modelId} · {model.providerId}</option>)}
    </select>
    {error && <div role="alert" className="typography-meta text-destructive">{error} <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={retry}>{t('settings.harness.retry')}</Button></div>}
    {!loading && !error && models.length === 0 && <p role="status" className="typography-meta text-muted-foreground">{t('settings.agents.modelSelector.state.noModelsFound')}</p>}
  </div>;
}
