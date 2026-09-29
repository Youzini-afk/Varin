import React from 'react';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { changeComputerDesktop, listComputers, probeComputerDesktop, setDefaultComputerTarget, type ComputerCatalog } from '@/lib/computers';
import { ComputerDesktopView } from '@/components/sections/computers/ComputerDesktopView';
import { ComputerVmSection } from '@/components/sections/computers/ComputerVmSection';
import type { ComputerDesktop } from '@varin/protocol';
import { ComputerDesktopSetup } from './ComputerDesktopSetup';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';

/**
 * Computers settings (BC4): the machine/desktop catalog with real probed
 * capabilities and the default Computer Use target. Statuses come from the
 * Host service — an unprobed or driverless desktop shows its honest state.
 */
export function ComputerSettings() {
  const runtimeKey = React.useSyncExternalStore((notify) => subscribeRuntimeEndpointChanged(() => notify()), getRuntimeKey, getRuntimeKey);
  return <ComputerSettingsContent key={runtimeKey} />;
}

function ComputerSettingsContent() {
  const { t } = useI18n();
  const [catalog, setCatalog] = React.useState<ComputerCatalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [probing, setProbing] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [viewing, setViewing] = React.useState<ComputerDesktop | null>(null);
  const directory = useEffectiveDirectory();
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);

  const openDesktopInPanel = (desktop: ComputerDesktop) => {
    if (!directory) return;
    openContextPanelTab(directory, {
      mode: 'computer',
      dedupeKey: `desktop:${desktop.id}`,
      targetPath: desktop.id,
      label: desktop.label,
    });
  };

  const refresh = React.useCallback(async () => {
    try {
      setCatalog(await listComputers());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const probe = async (desktopId: string) => {
    setProbing(desktopId);
    try {
      await probeComputerDesktop(desktopId);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProbing(null);
    }
  };

  const chooseDefault = async (value: string) => {
    setSaving(true);
    try {
      await setDefaultComputerTarget(value === 'none' ? null : value);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const capabilityList = (desktop: ComputerDesktop): string[] => {
    const caps = desktop.capabilities;
    if (!caps) return [t('settings.computers.capability.unprobed')];
    const flags: Array<[boolean | undefined, Parameters<typeof t>[0]]> = [
      [caps.observeTree, 'settings.computers.capability.observeTree'],
      [caps.screenshot, 'settings.computers.capability.screenshot'],
      [caps.elementAction, 'settings.computers.capability.elementAction'],
      [caps.coordinateInput, 'settings.computers.capability.coordinateInput'],
      [caps.textInput, 'settings.computers.capability.textInput'],
      [caps.drag, 'settings.computers.capability.drag'],
    ];
    return flags.filter(([on]) => on).map(([, key]) => t(key));
  };

  return <>
    {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void refresh(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {!catalog && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {catalog ? <>
      <SettingsSection title={t('settings.computers.section.targets')} contentClassName="space-y-5">
        <SettingsFieldRow label={t('settings.computers.defaultTarget.label')} description={t('settings.computers.defaultTarget.description')}>
          <Select value={catalog.defaultDesktopId ?? 'none'} disabled={saving} onValueChange={(value) => { void chooseDefault(value); }}>
            <SelectTrigger size="settings" className="w-64" aria-label={t('settings.computers.defaultTarget.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('settings.computers.defaultTarget.none')}</SelectItem>
              {catalog.desktops.map((desktop) => (
                <SelectItem key={desktop.id} value={desktop.id} disabled={desktop.status === 'stopped'}>
                  {desktop.label} — {desktop.machineId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </SettingsSection>
      <SettingsSection title={t('settings.computers.section.desktops')} contentClassName="space-y-4">
        {catalog.desktops.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.computers.empty')}</p> : null}
        {catalog.desktops.map((desktop) => {
          const machine = catalog.machines.find((m) => m.id === desktop.machineId);
          return <div key={desktop.id} className="rounded-lg border border-border/60 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="typography-ui-label text-foreground truncate">{desktop.label}</p>
                <p className="typography-meta text-muted-foreground">
                  {machine ? `${machine.name} · ${machine.platform}` : desktop.machineId} · {desktop.kind}
                  {machine ? ` · ${t('settings.computers.coordinator')}: ${machine.coordinatorHostId}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {desktop.managed ? <Button variant="outline" size="sm" disabled={probing === desktop.id} onClick={() => {
                  setProbing(desktop.id);
                  void changeComputerDesktop(desktop.id, desktop.status === 'stopped' ? 'start' : 'stop').then(refresh)
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setProbing(null));
                }}>{t(desktop.status === 'stopped' ? 'settings.computers.vm.action.start' : 'settings.computers.vm.action.shutdown')}</Button> : null}
                <span data-status={desktop.status}
                  className={`typography-meta ${desktop.status === 'available' ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {t(desktop.status === 'available' ? 'settings.computers.status.available'
                    : desktop.status === 'stopped' ? 'settings.computers.status.stopped'
                      : 'settings.computers.status.unavailable')}
                </span>
                <Button variant="outline" size="sm" disabled={probing === desktop.id}
                  onClick={() => { void probe(desktop.id); }}>
                  {probing === desktop.id ? t('settings.computers.probing') : t('settings.computers.probe')}
                </Button>
                <Button variant="outline" size="sm" disabled={desktop.status !== 'available'}
                  onClick={() => setViewing(desktop)}>
                  {t('settings.computers.view.open')}
                </Button>
                <Button variant="outline" size="sm" disabled={!directory || desktop.status !== 'available'}
                  title={directory ? undefined : t('settings.computers.view.panelNoDirectory')}
                  onClick={() => openDesktopInPanel(desktop)}>
                  {t('settings.computers.view.panel')}
                </Button>
              </div>
            </div>
            {desktop.statusDetail ? <p className="typography-meta text-muted-foreground">{desktop.statusDetail}</p> : null}
            <p className="typography-meta text-muted-foreground">
              {desktop.capabilities ? `${desktop.capabilities.driver} — ${capabilityList(desktop).join(' · ')}` : capabilityList(desktop)[0]}
            </p>
          </div>;
        })}
      </SettingsSection>
      <ComputerVmSection />
      <ComputerDesktopSetup catalog={catalog} onPrepared={refresh} />
      {viewing ? (
        <ComputerDesktopView desktop={viewing} open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }} />
      ) : null}
    </> : null}
  </>;
}
