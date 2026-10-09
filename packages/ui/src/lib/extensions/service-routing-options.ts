import type { VarinExtensionHostStateSnapshot, VarinExtensionServiceProvision } from '@varin/extension-contract';

export interface ServiceRoutingOption {
  descriptor: VarinExtensionServiceProvision;
  extensionId: string;
  providerKey: string;
  providerId?: string;
  status: 'active' | 'declared';
}

/** Installed lazy Host declarations are selectable before activation. A declaration is not a
 * ready generation; only the Host's prepareService can activate and bind it after selection. */
export function serviceRoutingOptions(snapshot: VarinExtensionHostStateSnapshot): Map<string, ServiceRoutingOption[]> {
  const options = new Map<string, ServiceRoutingOption>();
  if (snapshot.catalog.authoritative) {
    for (const entry of snapshot.catalog.extensions) {
      if (!entry.desired.enabled || !entry.manifest.entrypoints?.host) continue;
      for (const descriptor of entry.manifest.provides?.services ?? []) {
        const providerKey = `${entry.manifest.id}:host:${descriptor.id}@${descriptor.version}`;
        options.set(providerKey, { descriptor, extensionId: entry.manifest.id, providerKey, status: 'declared' });
      }
    }
  }
  for (const provider of snapshot.services.providers) {
    if (provider.status === 'active') options.set(provider.providerKey, { ...provider, status: 'active' });
  }
  const groups = new Map<string, ServiceRoutingOption[]>();
  for (const option of options.values()) {
    const key = `${option.descriptor.id}@${option.descriptor.version}`;
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  return groups;
}
