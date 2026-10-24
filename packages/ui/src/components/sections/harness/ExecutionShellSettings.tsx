import React from 'react';
import { getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow } from '../shared/SettingsSection';

type Environment = { defaultShell: string | null; shells: { id: string; name: string; executable: string }[] };

/** Configuration belongs to the selected Host; discovery never uses renderer PATH. */
export function ExecutionShellSettings({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [refresh, setRefresh] = React.useState(0);
  const refreshed = React.useRef(0);
  const [result, setResult] = React.useState<{ host: number; environment?: Environment; error?: string; loading: boolean }>({ host, loading: true });
  React.useEffect(() => {
    const abort = new AbortController();
    setResult(previous => previous.host === host ? { ...previous, loading: true, error: undefined } : { host, loading: true });
    const shouldRefresh = refresh !== refreshed.current; refreshed.current = refresh;
    void runtimeFetch(`/api/execution-environment${shouldRefresh ? '?refresh=true' : ''}`, { cache: 'no-store', signal: abort.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || response.statusText);
        if (!abort.signal.aborted) setResult({ host, loading: false, environment: body as Environment });
      }).catch(error => { if (!abort.signal.aborted) setResult({ host, loading: false, error: String(error.message ?? error) }); });
    return () => abort.abort();
  }, [host, refresh, value]);
  const current = result.host === host ? result : { loading: true, environment: undefined, error: undefined };
  const options = current.environment?.shells ?? [];
  const selected = value === 'auto' ? options[0] : options.find(option => option.id === value);
  const automatic = selected && value === 'auto' ? `${t('settings.page.harness.shell.option.auto')} · ${selected.name}` : t('settings.page.harness.shell.option.auto');
  return <SettingsFieldRow label={t('settings.page.harness.shell.label')} description={t('settings.page.harness.shell.description')} settingsItem="harness.shell">
    <div className="w-full max-w-md space-y-2">
      <div className="flex items-center gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger size="settings" className="w-full" aria-label={t('settings.page.harness.shell.label')}>
            <SelectValue>{value === 'auto' ? automatic : selected?.name ?? value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{automatic}</SelectItem>
            {value !== 'auto' && !selected && <SelectItem value={value}>{value}</SelectItem>}
            {options.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={current.loading} onClick={() => setRefresh(value => value + 1)}>{t('settings.varin.visual.terminal.refresh')}</Button>
      </div>
      {selected && <p className="break-all font-mono typography-meta text-muted-foreground">{selected.executable}</p>}
      {current.loading && <p role="status" className="typography-meta text-muted-foreground">{t('settings.varin.visual.terminal.discovering')}</p>}
      {current.error && <p role="alert" className="typography-meta text-destructive">{current.error}</p>}
      {!current.loading && !current.error && !selected && <p role="status" className="typography-meta text-muted-foreground">{t('settings.varin.visual.terminal.notFound')}</p>}
    </div>
  </SettingsFieldRow>;
}
