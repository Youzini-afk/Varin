import { VARIN_EVENTS_CAPABILITY, VARIN_CREDENTIALS_CAPABILITY, type VarinExtensionCatalogSnapshot, type VarinDurableEventSource, type VarinServiceEventContract } from '@varin/extension-contract';
export interface DeclaredEventSource {
  extensionId: string;
  serviceId: string;
  version: number;
  event: string;
  declaration: VarinDurableEventSource;
  contract: VarinServiceEventContract;
  enabled: boolean;
  granted: boolean;
}
/** Current selected declarations only. A short-lived UI notification is not an inbound source. */
export function declaredEventSources(catalog: VarinExtensionCatalogSnapshot): DeclaredEventSource[] {
  if (!catalog.authoritative) throw new Error('Event source catalog unavailable');
  return catalog.extensions.flatMap(entry => !entry.manifest.entrypoints?.host ? [] :
    (entry.manifest.provides?.services ?? []).flatMap(service => Object.entries(service.contract?.events ?? {})
      .flatMap(([event, contract]) => contract.durable ? [{ extensionId: entry.manifest.id,
        serviceId: service.id, version: service.version, event, declaration: contract.durable, contract,
        enabled: entry.desired.enabled,
        granted: [VARIN_EVENTS_CAPABILITY, ...(contract.durable.credentials === 'required' ? [VARIN_CREDENTIALS_CAPABILITY] : [])]
          .every(capability => entry.capabilityGrants.some(grant => grant.realm === 'host' && grant.capability === capability
            && grant.granted && grant.manifestVersion === entry.manifest.version)) }] : [])));
}
