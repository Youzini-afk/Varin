import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type TerminalShellOption } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { isTerminalShell } from '@/lib/terminalShell';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCheckboxRow, SettingsFieldRow, SETTINGS_SELECT_SIZE } from '../shared/SettingsSection';

export function TerminalShellSettings() {
  const { t } = useI18n();
  const { terminal } = useRuntimeAPIs();
  const shell = useUIStore(state => state.terminalShell);
  const setShell = useUIStore(state => state.setTerminalShell);
  const logins = useUIStore(state => state.terminalLoginShells);
  const setLogins = useUIStore(state => state.setTerminalLoginShells);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [refresh, setRefresh] = React.useState(0);
  const [result, setResult] = React.useState<{ host: number; shells: TerminalShellOption[]; loading: boolean; error: string | null }>({ host, shells: [], loading: true, error: null });
  React.useEffect(() => {
    let cancelled = false;
    setResult({ host, shells: [], loading: true, error: null });
    const read = terminal.listShells?.() ?? Promise.reject(new Error(t('settings.varin.visual.terminal.discoveryUnavailable')));
    void read.then(shells => {
      if (!cancelled) setResult({ host, shells, loading: false, error: null });
    }).catch(error => {
      if (!cancelled) setResult({ host, shells: [], loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [terminal, host, refresh, t]);
  const current = result.host === host ? result : { shells: [], loading: true, error: null };
  const selected = current.shells.find(option => option.id === shell);
  const auto = current.shells.find(option => option.id === 'auto');
  const autoName = auto?.executable
    ? current.shells.find(option => option.id !== 'auto' && option.executable === auto.executable)?.name ?? auto.executable.split(/[\\/]/).pop()
    : null;
  const autoLabel = autoName ? t('settings.varin.visual.terminal.autoResolved', { shell: autoName }) : t('settings.varin.visual.option.terminalShell.auto');
  const explicit = current.shells.filter(option => option.id !== 'auto');
  const unavailable = !current.loading && !current.error && !selected;
  return <>
    <SettingsFieldRow label={t('settings.varin.visual.field.terminalShell')}
      info={t('settings.varin.visual.field.terminalShellHint')} settingsItem="appearance.terminal-shell" className="pt-2">
      <div className="w-full max-w-md space-y-2">
        <div className="flex items-center gap-2">
          <Select value={shell} onValueChange={value => { if (isTerminalShell(value)) setShell(value); }}>
            <SelectTrigger aria-label={t('settings.varin.visual.field.terminalShellAria')} size={SETTINGS_SELECT_SIZE} className="w-full min-w-40">
              <SelectValue>{shell === 'auto' ? autoLabel : selected?.name ?? shell}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{autoLabel}</SelectItem>
              {shell !== 'auto' && !selected && <SelectItem value={shell}>{shell}</SelectItem>}
              {explicit.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={current.loading} onClick={() => setRefresh(value => value + 1)}>
            {t('settings.varin.visual.terminal.refresh')}
          </Button>
        </div>
        {selected?.executable && <p className="break-all font-mono typography-meta text-muted-foreground">{selected.executable}</p>}
        {current.loading && <p role="status" className="typography-meta text-muted-foreground">{t('settings.varin.visual.terminal.discovering')}</p>}
        {current.error && <p role="alert" className="typography-meta text-destructive">{t('settings.varin.visual.terminal.discoveryError', { message: current.error })}</p>}
        {(unavailable || selected?.executable === null) && <p role="status" className="typography-meta text-muted-foreground">{t('settings.varin.visual.terminal.notFound')}</p>}
      </div>
    </SettingsFieldRow>
    {selected?.supportsLogin && <SettingsCheckboxRow checked={logins.includes(shell)}
      onChange={enabled => setLogins(enabled ? [...logins.filter(value => value !== shell), shell] : logins.filter(value => value !== shell))}
      label={t('settings.varin.visual.field.terminalLoginShell')} ariaLabel={t('settings.varin.visual.field.terminalLoginShell')}
      settingsItem="appearance.terminal-login-shell" />}
    <p className="typography-meta text-muted-foreground">{t('settings.varin.visual.terminal.encoding')}</p>
  </>;
}
