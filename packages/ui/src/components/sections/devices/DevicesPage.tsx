import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type RemoteClientRecord } from '@varin/application-client';
import { AddDeviceDialog } from '@/components/sections/connections/AddDeviceDialog';
import { DesktopLocalHostSettings } from '@/components/sections/connections/DesktopLocalHostSettings';
import { DesktopHostSwitcherDialog, DesktopHostSwitcherInline, resolveCurrentHost } from '@/components/desktop/DesktopHostSwitcher';
import type { IconName } from '@/components/icon/icons';
import { Av, Btn, Catalog, CatalogGroup, CatalogItem, Dot, Ic, LinkRow, Loading, Note, ObjectHeader, Row, Section, Tabs, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { browserDeviceLabel, browserResourceLabel } from '@/lib/browser-presentation';
import { isDesktopShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getDesktopHostApiUrl, redactSensitiveUrl } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { getClientPlatform } from '@/lib/platform';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { refreshServiceIdentity, useServiceIdentity } from '@/lib/settings/service-identity';
import { DeviceConnectionMap, type ConnectionMapNode } from './DeviceConnectionMap';
import { attachConnection, detachConnection, useDeviceAssociations } from './device-associations';
import { collectResourceOwners, useDeviceOverview, type ResourceKind, type ResourceOwner } from './device-overview';

type Role = 'service' | 'client' | 'resources';
type Device = { id: string; name: string; roles: Role[]; icon: IconName; resource?: ResourceOwner; paired?: RemoteClientRecord };
const serviceRecord = 'service:self';
const pairedDeviceName = (record: RemoteClientRecord) => record.label || record.deviceName || '';
const pairedDeviceIcon = (record: RemoteClientRecord): IconName => record.clientKind === 'mobile' ? 'smartphone'
  : record.clientKind === 'browser' ? 'global' : 'computer';

export function DevicesPage() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <DevicesOnService key={generation} />;
}

function DevicesOnService() {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const service = useServiceIdentity();
  const [selected, setSelected] = React.useState('map');
  const [role, setRole] = React.useState<Role>('service');
  const [query, setQuery] = React.useState('');
  const [addingDevice, setAddingDevice] = React.useState(false);
  const [switchingHost, setSwitchingHost] = React.useState<string>();
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const associations = useDeviceAssociations(revision);
  const { catalogs, errors, resourcesPending } = useDeviceOverview(revision);

  const roleNames = {
    service: t('settings.devices.role.service'),
    client: t('settings.devices.role.client'),
    resources: t('settings.devices.role.resources'),
  };
  const platform = getClientPlatform();
  const clientName = t(`settings.connections.platform.${platform}`);
  const clientIcon = platform === 'desktop' ? 'computer' : platform === 'web' ? 'global' : 'smartphone';
  const serviceGroup = associations.value?.groups.find(group => group.members.includes(serviceRecord));
  const serviceName = serviceGroup?.name || service?.name || t('settings.shell.connectedService');
  const sameMachine = isDesktopShell() && isDesktopLocalOriginActive();
  const offline = t('settings.devices.offline');
  const owners = collectResourceOwners(catalogs, {
    serviceName, offline,
    browserLabel: resource => resource.device?.kind === 'managed_host' ? browserDeviceLabel(resource, t) : browserResourceLabel(resource, t),
    browserState: resource => t(`browser.resource.state.${resource.state}`),
  });
  const mergedResources = [...owners.values()].filter(owner => serviceGroup?.members.includes(owner.id));
  const localResources = owners.get('current');
  const currentResources = [localResources, ...mergedResources].filter(owner => owner !== undefined);
  const available = new Map<ResourceKind, boolean>();
  for (const owner of currentResources) {
    for (const [kind, usable] of owner.available) available.set(kind, usable || available.get(kind) === true);
  }
  const current: Device = {
    id: 'current', name: serviceName, icon: 'server', roles: ['service'],
    resource: available.size ? {
      id: 'current', name: serviceName, icon: 'computer', available,
      unavailable: [...available.values()].some(Boolean) ? undefined : currentResources[0]?.unavailable,
    } : undefined,
  };
  const now = Date.now();
  const paired = (catalogs.clients ?? []).filter(record => !record.revokedAt &&
    (!record.expiresAt || Date.parse(record.expiresAt) > now) &&
    (record.authMethod === 'pairing' || record.pairingId));
  const currentPair = paired.find(record => record.id === service?.clientId);
  const client: Device = {
    id: 'client', name: (currentPair && pairedDeviceName(currentPair)) || clientName, roles: ['client'], icon: clientIcon,
  };
  const pairedClients = paired.filter(record => record.id !== currentPair?.id).map((record): Device => ({
    id: `client:${record.id}`, name: pairedDeviceName(record) || roleNames.client, roles: ['client'],
    icon: pairedDeviceIcon(record), paired: record,
  }));
  if (sameMachine) current.roles.push('client');
  if (current.resource) current.roles.push('resources');
  const remoteDevices = [...owners.values()]
    .filter(owner => owner.id !== 'current' && !mergedResources.includes(owner))
    .map((owner): Device => ({ id: owner.id, name: owner.name, roles: ['resources'], icon: owner.icon, resource: owner }));
  const savedHosts = catalogs.services?.hosts ?? [];
  const configuredHosts = catalogs.services?.localOrigin
    ? [{ id: 'local', label: t('desktopHostSwitcher.instance.local'), url: catalogs.services.localOrigin }, ...savedHosts]
    : savedHosts;
  const activeHost = catalogs.services && resolveCurrentHost(configuredHosts);
  const otherHosts = configuredHosts.filter(host => host.id !== activeHost?.id);
  const devices = [current, ...(!sameMachine ? [client] : []), ...remoteDevices, ...pairedClients];
  const selectedDevice = mergedResources.some(device => device.id === selected) ? 'current' : selected;
  const active = devices.find(device => device.id === selectedDevice);
  const otherHost = otherHosts.find(host => `service:${host.id}` === selected);
  const selectedRole = active?.roles.includes(role) ? role : active?.roles[0];
  const select = (id: string, nextRole?: Role) => requestSettingsNavigation(() => {
    setSelected(id);
    setRole(nextRole ?? (id === selectedDevice ? selectedRole : devices.find(device => device.id === id)?.roles[0]) ?? 'service');
    shell.setCatalogStage('detail');
  });
  const merge = async (device: Device) => {
    if (associations.value) await associations.save(attachConnection(associations.value, serviceRecord, device.id));
  };
  const split = async (id: string) => {
    if (associations.value && await associations.save(detachConnection(associations.value, serviceRecord, id))) {
      setSelected(value => value === id ? 'current' : value);
    }
  };
  const endpoint = redactSensitiveUrl(getRuntimeApiBaseUrl() || window.location.origin);
  const resourceLabels = {
    workspace: t('settings.page.workspaces.title'),
    computer: t('settings.page.harness.page.computers.title'),
    browser: t('settings.browser.title'),
  };
  const resourceLinks = {
    workspace: { page: 'workspaces', icon: 'hard-drive-2' },
    computer: { page: 'harness-computers', icon: 'computer' },
    browser: { page: 'browsers', icon: 'global' },
  } as const;
  const clientNodes: ConnectionMapNode[] = [{
    id: 'this-client', label: sameMachine ? serviceName : client.name, icon: clientIcon,
    detail: t('settings.devices.usingNow'), onOpen: () => select(sameMachine ? 'current' : 'client', 'client'),
  }, ...pairedClients.map(device => ({
    id: device.id, label: device.name, icon: device.icon, detail: t('settings.devices.paired'), onOpen: () => select(device.id, 'client'),
  }))];
  const resourceNodes = [current, ...remoteDevices].flatMap(device => {
    const owner = device.resource;
    if (!owner) return [];
    const kinds = [...owner.available.keys()];
    const detail = [...kinds.map(kind => resourceLabels[kind]), ...(owner.unavailable ? [offline] : [])].join(' · ');
    return [{ id: device.id, label: device.name, icon: owner.icon, detail, offline: Boolean(owner.unavailable),
      onOpen: () => select(device.id, 'resources') }];
  });
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const resourceErrors = errors.sources || errors.computers || errors.browsers;
  const serviceOffline = service?.reachable === false;
  return <Catalog title={t('settings.page.devices.title')} description={t('settings.devices.description')}
    scope={<SettingsScopeLabel kind="mixed" />}
    filter={{ value: query, onChange: setQuery, placeholder: t('settings.devices.search') }}
    headActions={<Btn kind="ghost" icon="refresh" disabled={associations.busy} tip={t('settings.common.actions.refresh')}
      onClick={() => { refresh(); refreshServiceIdentity(); }} />}
    items={<>
      <CatalogItem pinned selected={selected === 'map'} opensDetail={false} lead={<Av><Ic name="node-tree" size="sm" /></Av>}
        name={t('settings.devices.map')} meta={t('settings.devices.mapLabel')} onSelect={() => select('map')} />
      <CatalogGroup label={t('settings.page.devices.title')} count={devices.length + otherHosts.length} />
      {devices.filter(device => matches(device.name)).map(device => <CatalogItem
        key={device.id} name={device.name} lead={<Av><Ic name={device.icon} size="sm" /></Av>}
        meta={device.paired ? t('settings.devices.paired') : device.roles.map(kind => roleNames[kind]).join(' · ')}
        end={device.resource?.unavailable ? <Dot state="err" tip={offline} /> : undefined}
        selected={selectedDevice === device.id} opensDetail={false} onSelect={() => select(device.id)} />)}
      {resourcesPending ? <Loading /> : null}
      {otherHosts.filter(host => matches(host.label)).map(host => <CatalogItem key={host.id}
        selected={selected === `service:${host.id}`} opensDetail={false} lead={<Av><Ic name="server" size="sm" /></Av>}
        name={host.label} meta={t('settings.devices.otherService')} onSelect={() => select(`service:${host.id}`)} />)}
    </>}
    foot={<>
      <Btn kind="ghost" icon="add" onClick={() => setAddingDevice(true)}>{t('settings.devices.addResource')}</Btn>
      <Btn kind="ghost" icon="qr-code" onClick={() => shell.openPage('remote-access', { item: 'remote-instances.client-auth' })}>{t('settings.devices.pair')}</Btn>
    </>}
    detailKey={otherHost ? selected : active ? selectedDevice : 'map'}
    detail={otherHost ? <>
      <ObjectHeader title={otherHost.label} avatar={<Av><Ic name="server" /></Av>} sub={t('settings.devices.otherService')}
        actions={<Btn onClick={() => setSwitchingHost(otherHost.id)}>{t('settings.devices.switchService')}</Btn>} />
      <Section><Row label={t('settings.devices.serviceAddress')} description={<span className="break-all font-mono">
        {redactSensitiveUrl(getDesktopHostApiUrl(otherHost) || otherHost.url)}
      </span>} /></Section>
    </> : active && selectedRole ? <>
        <ObjectHeader title={active.name} avatar={<Av><Ic name={active.icon} size="sm" /></Av>}
          sub={active.resource?.unavailable ?? active.roles.map(kind => roleNames[kind]).join(' · ')} />
        {associations.error ? <Note kind="warn">{associations.error}</Note> : null}
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
          <Row label={t('settings.connections.interface')}>{active.paired ? t('settings.devices.paired') : clientName}</Row>
          <LinkRow lead="server" label={t('settings.shell.connectedService')} end={serviceName} onClick={() => select('current', 'service')} />
          <LinkRow lead="qr-code" label={t('settings.page.remoteAccess.title')} onClick={() => shell.openPage('remote-access', {
            item: active.paired ? `client-access:${active.paired.id}` : 'remote-instances.client-auth',
          })} />
        </Section>}
        {selectedRole === 'resources' && <>
          <Section title={roleNames.resources}>
            {[...(active.resource?.available ?? [])].map(([kind, usable]) => <LinkRow key={kind}
              lead={resourceLinks[kind].icon} label={resourceLabels[kind]} end={!usable ? offline : undefined}
              onClick={() => shell.openPage(resourceLinks[kind].page)} />)}
          </Section>
          {active.id === 'current' && mergedResources.length > 0 && <Section title={t('settings.devices.associations')}>
            {mergedResources.map(device => <Row key={device.id} label={device.name} description={device.unavailable}>
              <Btn kind="ghost" disabled={associations.busy} onClick={() => void split(device.id)}>{t('settings.devices.split')}</Btn>
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
      <ObjectHeader title={t('settings.devices.map')} sub={t('settings.devices.mapHint')} avatar={<Av><Ic name="node-tree" /></Av>} />
      <DeviceConnectionMap clients={clientNodes} resources={resourceNodes} pending={resourcesPending} resourceError={Boolean(resourceErrors)}
        service={{ id: 'current', label: serviceName, icon: 'server', detail: serviceOffline ? offline : t('settings.devices.mapServiceDetails'),
          offline: serviceOffline, onOpen: () => select('current', 'service') }} />
      <Note>{t('settings.devices.mapBoundary')}</Note>
      {associations.error ? <Note kind="warn">{associations.error}</Note> : null}
      {Object.entries(errors).map(([catalog, error]) => error ? <Note key={catalog} kind="warn">{error}</Note> : null)}
      {otherHosts.length > 0 && <Section title={t('settings.devices.services')} description={t('settings.devices.servicesHint')}>
        {otherHosts.map(host => <Row key={host.id} lead="server" label={host.label}
          description={<span className="break-all">{redactSensitiveUrl(getDesktopHostApiUrl(host) || host.url)}</span>}>
          <div className="device-map-service-actions">
            <Btn onClick={() => setSwitchingHost(host.id)}>{t('settings.devices.switchService')}</Btn>
            <Btn kind="ghost" onClick={() => select(`service:${host.id}`)}>{t('settings.devices.details')}</Btn>
          </div>
        </Row>)}
      </Section>}
    </>}
    dock={<>
      {addingDevice ? <AddDeviceDialog onClose={() => setAddingDevice(false)} onChanged={refresh} /> : null}
      {switchingHost ? <DesktopHostSwitcherDialog open focusedHostId={switchingHost}
        onOpenChange={open => { if (!open) setSwitchingHost(undefined); }} /> : null}
    </>}
  />;
}
