import React from 'react';
import type { BrowserConnection, BrowserManagementSnapshot, BrowserSettingsDevice } from '@varin/protocol';
import { browserResources, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { SettingsPageLink } from '../shared/SettingsPageLink';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { browserDeviceLabel, browserResourceLabel } from '@/lib/browser-presentation';
import { useUIStore } from '@/stores/useUIStore';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { CdpConnectionDialog } from './CdpConnectionDialog';
import { BrowserConnectorDialog } from './BrowserConnectorDialog';

export function BrowserSettingsPage() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <BrowserSettingsContent key={host} />;
}
function BrowserSettingsContent() {
  const { t } = useI18n();
  const [device, setDevice] = React.useState('local');
  const [devices, setDevices] = React.useState<BrowserSettingsDevice[]>([]);
  const [catalog, setCatalog] = React.useState<BrowserManagementSnapshot>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [epoch, setEpoch] = React.useState(0);
  const [editing, setEditing] = React.useState<BrowserConnection>();
  const [connecting, setConnecting] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    void browserResources.devices(controller.signal).then(setDevices, cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [epoch]);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setCatalog(undefined); setError('');
    void browserResources.configuration(device, controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }, cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [device, epoch]);
  const save = async (settings: BrowserManagementSnapshot['settings']) => {
    setSaving(true); setError('');
    try { setCatalog(await browserResources.saveConfiguration(settings, device)); }
    finally { setSaving(false); }
  };
  const remove = async (connection: BrowserConnection) => {
    if (!catalog) return;
    try { await save({ ...catalog.settings, connections: catalog.settings.connections.filter(item => item.id !== connection.id),
      defaultBrowserId: catalog.settings.defaultBrowserId === connection.id ? null : catalog.settings.defaultBrowserId }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openBrowser = (browserId: string) => {
    const resource = catalog?.resources.find(item => item.browserId === browserId);
    if (!resource?.instanceId) return;
    const viewBrowserId = catalog?.viewBrowserIds?.[browserId] ?? browserId, ui = useUIStore.getState();
    ui.openContextPanelTab('', { mode: 'browser', label: browserResourceLabel(resource, t),
      dedupeKey: `browser-resource:${viewBrowserId}`, browserBinding: { browserId: viewBrowserId, instanceId: resource.instanceId } });
    ui.setSettingsDialogOpen(false);
  };
  return <SettingsPageLayout title={t('settings.browser.title')} description={t('settings.browser.description')}
    headerEnd={<Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => requestSettingsNavigation(() => setEpoch(value => value + 1))}><Icon name="refresh" className="size-4" />{t('settings.common.actions.refresh')}</Button>}>
    <SettingsSection divider={false} contentClassName="space-y-5">
      <SettingsFieldRow label={t('settings.browser.device')} description={t('settings.browser.deviceHint')}>
        <Select value={device} disabled={saving} onValueChange={value => requestSettingsNavigation(() => setDevice(value))}>
          <SelectTrigger size="settings" className="w-full max-w-72" aria-label={t('settings.browser.device')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="local">{t('settings.browser.currentHost')}</SelectItem>{devices.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      {catalog && <SettingsFieldRow label={t('settings.browser.default')} description={t('settings.browser.defaultHint')}>
        <Select value={catalog.settings.defaultBrowserId ?? 'automatic'} disabled={saving} onValueChange={value => void save({ ...catalog.settings, defaultBrowserId: value === 'automatic' ? null : value }).catch(cause => setError(String(cause)))}>
          <SelectTrigger size="settings" className="w-full max-w-72" aria-label={t('settings.browser.default')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="automatic">{t('settings.browser.automatic')}</SelectItem>
            {catalog.settings.defaultBrowserId && !catalog.resources.some(item => item.browserId === catalog.settings.defaultBrowserId) && <SelectItem value={catalog.settings.defaultBrowserId}>{t('browser.resource.offline')}</SelectItem>}
            {catalog.resources.map(item => <SelectItem key={item.browserId} value={item.browserId}>{browserResourceLabel(item, t)} · {browserDeviceLabel(item, t)}</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsFieldRow>}
    </SettingsSection>
    <SettingsSection title={t('settings.browser.connections')} headerAction={<div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => requestSettingsNavigation(() => { setDevice('local'); setConnecting(true); })}>{t('settings.browser.connectExisting')}</Button>
      <Button size="sm" disabled={!catalog || saving} onClick={() => setEditing({ id: `cdp:${crypto.randomUUID()}`, label: '', endpoint: '' })}><Icon name="add" className="size-4" />{t('settings.browser.addCdp')}</Button>
    </div>}>
      {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
      {error && <p role="alert" className="break-words typography-meta text-destructive">{error}</p>}
      {catalog && <div className="divide-y divide-border/60">{catalog.resources.map(resource => {
        const connection = catalog.settings.connections.find(item => item.id === resource.browserId);
        return <div key={resource.browserId} className="group py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Icon name="global" className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="typography-ui-label">{browserResourceLabel(resource, t)}</p><p className="mt-1 typography-meta text-muted-foreground">{browserDeviceLabel(resource, t)}{resource.source ? ` · ${t(`settings.browser.source.${resource.source}`)}` : ''}</p></div>
            <span className="typography-meta text-muted-foreground">{t(`browser.resource.state.${resource.state}`)}</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={!resource.instanceId} onClick={() => openBrowser(resource.browserId)}>{t('settings.browser.view')}</Button>
              {connection && <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(connection)} aria-label={t('settings.browser.edit', { name: browserResourceLabel(resource, t) })}><Icon name="edit" className="size-4" /></Button>}
            </div>
          </div>
          <details className="ml-9 mt-2 typography-meta text-muted-foreground"><summary className="w-fit cursor-pointer select-none">{t('settings.browser.details')}</summary>
            <p className="mt-2">{resource.capabilities.map(capability => t(`settings.browser.capability.${capability}`)).join(' · ') || t('settings.browser.noCapabilities')}</p>
            {connection && <Button variant="ghost" size="sm" disabled={saving} className="mt-2 text-destructive" onClick={() => void remove(connection)}>{t('settings.browser.remove')}</Button>}
          </details>
        </div>;
      })}{!catalog.resources.length && <p className="py-6 typography-meta text-muted-foreground">{t('settings.browser.empty')}</p>}</div>}
    </SettingsSection>
    <SettingsSection title={t('settings.browser.otherDevice')} description={t('settings.browser.otherDeviceHint')}>
      <SettingsPageLink page="work-connections">{t('settings.page.connections.title')}</SettingsPageLink>
    </SettingsSection>
    {editing && catalog && <CdpConnectionDialog connection={editing} device={device} onClose={() => setEditing(undefined)} onSave={async connection => {
      const connections = catalog.settings.connections.some(item => item.id === connection.id)
        ? catalog.settings.connections.map(item => item.id === connection.id ? connection : item) : [...catalog.settings.connections, connection];
      await save({ ...catalog.settings, connections }); setEditing(undefined);
    }} />}
    {connecting && <BrowserConnectorDialog onClose={() => { setConnecting(false); setEpoch(value => value + 1); }} />}
  </SettingsPageLayout>;
}
