import React from 'react';
import type { DesktopHostsConfig } from '@varin/application-client';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { hostConnectionRequest } from '@/lib/hostConnections';
import { prepareComputerDesktop, type ComputerCatalog } from '@/lib/computers';

export function ComputerDesktopSetup({ catalog, onPrepared }: { catalog: ComputerCatalog; onPrepared(): Promise<void> }) {
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<DesktopHostsConfig['hosts']>([]);
  const [target, setTarget] = React.useState('local');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const local = catalog.machines.find((machine) => machine.provider === 'local');
  React.useEffect(() => {
    let disposed = false;
    void hostConnectionRequest<DesktopHostsConfig>('/hosts').then((config) => {
      if (!disposed) setConnections(config.hosts);
    }).catch((error) => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; };
  }, []);
  const prepare = async () => {
    setBusy(true); setError(null);
    try { await prepareComputerDesktop(target === 'local' ? {} : { connectionId: target }); await onPrepared(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <SettingsSection title={t('settings.computers.setup.title')} contentClassName="space-y-3">
    <p className="typography-meta text-muted-foreground">{t('settings.computers.setup.description')}</p>
    <SettingsFieldRow label={t('settings.computers.coordinator')}>
      <Select value={target} onValueChange={setTarget} disabled={busy}>
        <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="local" disabled={local?.platform !== 'linux'}>{local?.name ?? 'Host'}</SelectItem>
          {connections.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    <Button size="sm" disabled={busy || (target === 'local' && local?.platform !== 'linux')} onClick={() => void prepare()}>
      {busy ? t('settings.computers.setup.preparing') : t('settings.computers.setup.prepare')}
    </Button>
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
  </SettingsSection>;
}
