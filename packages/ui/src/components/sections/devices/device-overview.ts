import React from 'react';
import { browserResources, type RemoteClientRecord, type ThreadSourceTargets } from '@varin/application-client';
import type { BrowserResource } from '@varin/protocol';
import type { IconName } from '@/components/icon/icons';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { listComputers, type ComputerCatalog } from '@/lib/computers';
import { isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, type DesktopHostsConfig } from '@/lib/desktopHosts';

interface Catalogs {
  sources: ThreadSourceTargets;
  computers: ComputerCatalog;
  browsers: BrowserResource[];
  clients: RemoteClientRecord[];
  services: DesktopHostsConfig;
}

export function useDeviceOverview(revision: number) {
  const { threads, clientAuth } = useRuntimeAPIs();
  const [catalogs, setCatalogs] = React.useState<Partial<Catalogs>>({});
  const [errors, setErrors] = React.useState<Partial<Record<keyof Catalogs, string>>>({});
  React.useEffect(() => {
    const abort = new AbortController();
    const load = <K extends keyof Catalogs>(key: K, request: Promise<Catalogs[K]>) => {
      void request.then(value => {
        if (abort.signal.aborted) return;
        setCatalogs(previous => ({ ...previous, [key]: value }));
        setErrors(previous => ({ ...previous, [key]: undefined }));
      }, cause => {
        if (!abort.signal.aborted) setErrors(previous => ({ ...previous, [key]: cause instanceof Error ? cause.message : String(cause) }));
      });
    };
    if (threads) load('sources', threads.sources.list(null, abort.signal));
    if (clientAuth) load('clients', clientAuth.listClients());
    if (isDesktopShell()) load('services', desktopHostsGet());
    load('computers', listComputers(abort.signal));
    load('browsers', browserResources.list(abort.signal));
    return () => abort.abort();
  }, [threads, clientAuth, revision]);
  return { catalogs, errors, resourcesPending: Boolean(
    (threads && !catalogs.sources && !errors.sources) || (!catalogs.computers && !errors.computers) || (!catalogs.browsers && !errors.browsers)
  ) };
}

export type ResourceKind = 'workspace' | 'computer' | 'browser';
export interface ResourceOwner {
  id: string;
  name: string;
  icon: IconName;
  available: Map<ResourceKind, boolean>;
  unavailable?: string;
}

export function collectResourceOwners({ sources, computers, browsers }: Partial<Catalogs>, options: {
  serviceName: string;
  offline: string;
  browserLabel(resource: BrowserResource): string;
  browserState(resource: BrowserResource): string;
}) {
  const owners = new Map<string, ResourceOwner>();
  const add = (id: string, name: string, icon: IconName, kind: ResourceKind, online: boolean, detail?: string) => {
    const owner = owners.get(id) ?? { id, name, icon, available: new Map<ResourceKind, boolean>() };
    owner.available.set(kind, online || owner.available.get(kind) === true);
    if (detail && !owner.unavailable) owner.unavailable = detail;
    owners.set(id, owner);
  };
  for (const target of sources?.targets ?? []) {
    const owner = target.resourceOwner;
    if (owner.kind === 'local') add('current', options.serviceName, 'computer', 'workspace', true);
    else add(`connection:${owner.connectionId}`, target.label, 'server', 'workspace', true);
  }
  for (const target of sources?.unavailable ?? []) {
    add(`connection:${target.connectionId}`, target.label, 'server', 'workspace', false, target.message);
  }
  for (const machine of computers?.machines ?? []) {
    if (machine.status === 'archived') continue;
    const desktops = computers?.desktops.filter(desktop => desktop.machineId === machine.id) ?? [];
    const online = machine.status === 'active' && desktops.some(desktop => desktop.status === 'available');
    const remote = desktops.find(desktop => desktop.remote)?.remote;
    const id = remote ? `connection:${remote.connectionId}` : machine.provider === 'local' ? 'current' : `machine:${machine.id}`;
    add(id, id === 'current' ? options.serviceName : machine.name, 'computer', 'computer', online, machine.statusDetail);
  }
  for (const browser of browsers ?? []) {
    const device = browser.device;
    const id = device?.kind === 'service' ? 'current'
      : device?.kind === 'managed_host' ? `connection:${device.connectionId}` : `browser:${browser.browserId}`;
    add(id, id === 'current' ? options.serviceName : options.browserLabel(browser), 'global', 'browser',
      browser.state === 'online', options.browserState(browser));
  }
  for (const owner of owners.values()) {
    owner.unavailable = [...owner.available.values()].some(Boolean) ? undefined : owner.unavailable || options.offline;
  }
  return owners;
}
