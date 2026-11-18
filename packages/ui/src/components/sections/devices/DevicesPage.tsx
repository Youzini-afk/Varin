import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadSourceTargets } from '@varin/application-client';
import { AddDeviceDialog } from '@/components/sections/connections/AddDeviceDialog';
import { DesktopLocalHostSettings } from '@/components/sections/connections/DesktopLocalHostSettings';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { Av, Btn, Catalog, CatalogGroup, CatalogItem, Dot, Ic, LinkRow, Loading, Note, ObjectHeader, Row, Section, Tabs, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { getClientPlatform } from '@/lib/platform';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { refreshServiceIdentity, useServiceIdentity } from '@/lib/settings/service-identity';
import { attachConnection, detachConnection, useDeviceAssociations } from './device-associations';

type Role = 'service' | 'client' | 'resources';
type Device = { id: string; name: string; roles: Role[]; unavailable?: string; capabilities?: string[] };
const serviceRecord = 'service:self';

export function DevicesPage() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <DevicesOnService key={generation} />;
}

function DevicesOnService() {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const service = useServiceIdentity();
  const { threads } = useRuntimeAPIs();
  const [sources, setSources] = React.useState<ThreadSourceTargets>();
  const [error, setError] = React.useState<string>();
  const [selected, setSelected] = React.useState('map');
  const [role, setRole] = React.useState<Role>('service');
  const [query, setQuery] = React.useState('');
  const [addingDevice, setAddingDevice] = React.useState(false);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const associations = useDeviceAssociations(revision);
  React.useEffect(() => {
    const abort = new AbortController();
    if (!threads) return;
    void threads.sources.list(null, abort.signal).then(value => {
      if (!abort.signal.aborted) { setSources(value); setError(undefined); }
    }, cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, [threads, revision]);

  const roleNames = {
    service: t('settings.devices.role.service'),
    client: t('settings.devices.role.client'),
    resources: t('settings.devices.role.resources'),
  };
  const clientName = t(`settings.connections.platform.${getClientPlatform()}`);
  const serviceGroup = associations.value?.groups.find(group => group.members.includes(serviceRecord));
  const serviceName = serviceGroup?.name || service?.name || t('settings.shell.connectedService');
  const sameMachine = isDesktopShell() && isDesktopLocalOriginActive();
  const current: Device = { id: 'current', name: serviceName, roles: sameMachine ? ['service', 'client', 'resources'] : ['service', 'resources'] };
  const client: Device = { id: 'client', name: clientName, roles: ['client'] };
  const resources: Device[] = [
    ...(sources?.targets.flatMap(target => target.resourceOwner.kind === 'managed_host' ? [{
      id: `connection:${target.resourceOwner.connectionId}`, name: target.label, roles: ['resources' as const], capabilities: target.capabilities,
    }] : []) ?? []),
    ...(sources?.unavailable.map(target => ({ id: `connection:${target.connectionId}`, name: target.label, roles: ['resources' as const], unavailable: target.message })) ?? []),
  ];
  const mergedResources = resources.filter(device => serviceGroup?.members.includes(device.id));
  const remoteDevices = resources.filter(device => !serviceGroup?.members.includes(device.id));
  const devices = [current, ...(!sameMachine ? [client] : []), ...remoteDevices];
  const selectedDevice = mergedResources.some(device => device.id === selected) ? 'current' : selected;
  const active = devices.find(device => device.id === selectedDevice);
  const selectedRole = active?.roles.includes(role) ? role : active?.roles[0];
  const select = (id: string, nextRole?: Role) => requestSettingsNavigation(() => {
    setSelected(id);
    setRole(nextRole ?? (id === selectedDevice ? selectedRole : devices.find(device => device.id === id)?.roles[0]) ?? 'service');
    shell.setCatalogStage('detail');
  });
  const merge = async (device: Device) => {
    if (associations.value) await associations.save(attachConnection(associations.value, serviceRecord, device.id));
  };
  const split = async (device: Device) => {
    if (associations.value && await associations.save(detachConnection(associations.value, serviceRecord, device.id))) {
      setSelected(value => value === device.id ? 'current' : value);
    }
  };
  const endpoint = redactSensitiveUrl(getRuntimeApiBaseUrl() || window.location.origin);
  return <Catalog title={t('settings.page.devices.title')} description={t('settings.devices.description')}
    scope={<SettingsScopeLabel kind="mixed" />}
    filter={{ value: query, onChange: setQuery, placeholder: t('settings.devices.search') }}
    headActions={<Btn kind="ghost" icon="refresh" disabled={associations.busy} tip={t('settings.common.actions.refresh')}
      onClick={() => { refresh(); refreshServiceIdentity(); }} />}
    items={<>
      <CatalogItem pinned selected={selected === 'map'} opensDetail={false} lead={<Av><Ic name="node-tree" size="sm" /></Av>}
        name={t('settings.devices.map')} onSelect={() => select('map')} />
      <CatalogGroup label={t('settings.page.devices.title')} />
      {devices.filter(device => device.name.toLowerCase().includes(query.trim().toLowerCase())).map(device => <CatalogItem
        key={device.id} name={device.name} lead={<Av><Ic name={device.id === 'current' ? 'server' : 'computer'} size="sm" /></Av>}
        meta={device.roles.map(kind => roleNames[kind]).join(' · ')} end={device.unavailable ? <Dot state="warn" /> : undefined}
        selected={selectedDevice === device.id} opensDetail={false} onSelect={() => select(device.id)} />)}
      {!sources && threads && !error ? <Loading /> : null}
      <CatalogItem selected={selected === 'services'} opensDetail={false} lead={<Av><Ic name="server" size="sm" /></Av>}
        name={t('settings.devices.services')} onSelect={() => select('services')} />
    </>}
    foot={<>
      <Btn kind="ghost" icon="add" onClick={() => setAddingDevice(true)}>{t('settings.devices.addResource')}</Btn>
      <Btn kind="ghost" icon="qr-code" onClick={() => shell.openPage('remote-access', { item: 'remote-instances.client-auth' })}>{t('settings.devices.pair')}</Btn>
    </>}
    detailKey={selectedDevice}
    detail={selected === 'services' ? <RemoteInstancesPage /> : <>
      {error ? <Note kind="warn">{error}</Note> : null}
      {associations.error ? <Note kind="warn">{associations.error}</Note> : null}
      {active && selectedRole ? <>
        <ObjectHeader title={active.name} avatar={<Av><Ic name={active.id === 'current' ? 'server' : 'computer'} size="sm" /></Av>}
          sub={active.unavailable ?? active.roles.map(kind => roleNames[kind]).join(' · ')} />
        {active.roles.length > 1 && <Tabs value={selectedRole} label={active.name}
          tabs={active.roles.map(value => ({ value, label: roleNames[value] }))} onChange={value => requestSettingsNavigation(() => setRole(value))} />}
        {selectedRole === 'service' && <>
          <Section title={roleNames.service}>
            <Row label={t('settings.shell.connectedService')} description={<span className="break-all font-mono">{endpoint}</span>}>
              <Dot state={service?.reachable ? 'ok' : 'off'} />
            </Row>
            <LinkRow lead="qr-code" label={t('settings.page.remoteAccess.title')} onClick={() => shell.openPage('remote-access')} />
            <LinkRow lead="router" label={t('settings.page.proxy.title')} onClick={() => shell.openPage('proxy')} />
          </Section>
          {isDesktopShell() ? <><DesktopHostSwitcherInline /><DesktopLocalHostSettings /></> : null}
        </>}
        {selectedRole === 'client' && <Section title={roleNames.client}>
          <Row label={t('settings.connections.interface')}>{clientName}</Row>
          <LinkRow lead="server" label={t('settings.shell.connectedService')} end={serviceName} onClick={() => select('current', 'service')} />
          <LinkRow lead="qr-code" label={t('settings.devices.pair')} onClick={() => shell.openPage('remote-access', { item: 'remote-instances.client-auth' })} />
        </Section>}
        {selectedRole === 'resources' && <>
          <Section title={roleNames.resources}>
            <Row label={t('settings.connections.files')} description={active.unavailable ?? active.capabilities?.join(' · ')}>
              <Dot state={active.unavailable ? 'warn' : 'ok'} />
            </Row>
            <LinkRow lead="hard-drive-2" label={t('settings.page.workspaces.title')} onClick={() => shell.openPage('workspaces')} />
            <LinkRow lead="computer" label={t('settings.page.harness.page.computers.title')} onClick={() => shell.openPage('harness-computers')} />
            <LinkRow lead="global" label={t('settings.browser.title')} onClick={() => shell.openPage('browsers')} />
          </Section>
          {active.id === 'current' && mergedResources.length > 0 && <Section title={t('settings.devices.associations')}>
            {mergedResources.map(device => <Row key={device.id} label={device.name} description={device.unavailable}>
              <Btn kind="ghost" disabled={associations.busy} onClick={() => void split(device)}>{t('settings.devices.split')}</Btn>
            </Row>)}
          </Section>}
          {active.id.startsWith('connection:') && associations.value &&
            !associations.value.groups.some(group => group.members.includes(active.id)) && <Section>
              <Row label={t('settings.devices.associations')} description={t('settings.devices.associationsHint', { name: serviceName })}>
                <Btn kind="ghost" disabled={associations.busy} onClick={() => void merge(active)}>{t('settings.devices.merge')}</Btn>
              </Row>
            </Section>}
        </>}
      </> : <>
        <ObjectHeader title={t('settings.devices.map')} sub={t('settings.devices.mapHint')} />
        <Section title={roleNames.client}>
          <LinkRow lead="computer" label={clientName} end={t('settings.scope.device')} onClick={() => select(sameMachine ? 'current' : 'client', 'client')} />
        </Section>
        <Section title={roleNames.service}>
          <LinkRow lead="server" label={serviceName} description={<span className="break-all font-mono">{endpoint}</span>} onClick={() => select('current', 'service')} />
        </Section>
        <Section title={roleNames.resources}>
          {[current, ...remoteDevices].map(device => <LinkRow key={device.id} lead="computer" label={device.name}
            description={device.unavailable} onClick={() => select(device.id, 'resources')} />)}
        </Section>
      </>}
    </>}
    dock={addingDevice ? <AddDeviceDialog onClose={() => setAddingDevice(false)} onChanged={refresh} /> : null}
  />;
}
