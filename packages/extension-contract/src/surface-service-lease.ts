import type { VarinApplicationSurface, VarinExtensionArtifactSlot, VarinExtensionServiceProviderSnapshot } from './types.js';
import { VarinExtensionContractError } from './contract-error.js';
import { parseVarinExtensionServiceRoutingContext, type VarinExtensionServiceRoutingContext } from './service-routing.js';
import { parseVarinExtensionServiceCatalogSnapshot } from './validation.js';

export interface VarinSurfaceServiceLeaseOwner {
  hostId: string;
  realmId: string;
  extensionId: string;
  extensionVersion: string;
  entrypointId: string;
  generation: number;
  desiredRevision: number;
}
export interface VarinSurfaceServiceLeaseRequest {
  owner: VarinSurfaceServiceLeaseOwner;
  surface: VarinApplicationSurface;
  artifactIntegrity: string;
  slot: VarinExtensionArtifactSlot;
  routing: VarinExtensionServiceRoutingContext;
  expectedRoutingRevision: number;
  /** Exact Host declaration choices from the original scoped routing resolver; never grants. */
  services: Array<{ serviceId: string; version: number; providerKey: string }>;
}
export interface VarinSurfaceServiceInvocationLease {
  id: string;
  owner: Pick<VarinSurfaceServiceLeaseOwner, 'realmId' | 'extensionId' | 'entrypointId' | 'generation'>;
}
export type VarinSurfaceServiceLeaseEvent =
  | { kind: 'ready'; leaseId: string; routingRevision: number; providers: VarinExtensionServiceProviderSnapshot[] }
  | { kind: 'revoked'; code: string }
  | { kind: 'error'; message: string };

const fail = (message: string): never => { throw new VarinExtensionContractError('Invalid Surface service lease', [message]); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('expected an object');
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('unknown field');
};
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : fail('expected nonempty identity');
const integer = (value: unknown, minimum = 0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  ? value : fail('expected a nonnegative integer');
export function parseVarinSurfaceServiceInvocationLease(value: unknown): VarinSurfaceServiceInvocationLease {
  const input = record(value), owner = record(input.owner);
  exact(input, ['id', 'owner']); exact(owner, ['realmId', 'extensionId', 'entrypointId', 'generation']);
  return { id: text(input.id), owner: { realmId: text(owner.realmId), extensionId: text(owner.extensionId),
    entrypointId: text(owner.entrypointId), generation: integer(owner.generation, 1) } };
}
export function parseVarinSurfaceServiceLeaseRequest(value: unknown): VarinSurfaceServiceLeaseRequest {
  const input = record(value), owner = record(input.owner);
  exact(input, ['owner', 'surface', 'artifactIntegrity', 'slot', 'routing', 'expectedRoutingRevision', 'services']);
  exact(owner, ['hostId', 'realmId', 'extensionId', 'extensionVersion', 'entrypointId', 'generation', 'desiredRevision']);
  if (!['web', 'desktop', 'mobile'].includes(String(input.surface)) || !['selected', 'candidate'].includes(String(input.slot))) fail('unsupported Surface or artifact slot');
  if (!Array.isArray(input.services)) return fail('services must be a declared choice list');
  const services = input.services.map(value => {
    const service = record(value); exact(service, ['serviceId', 'version', 'providerKey']);
    return { serviceId: text(service.serviceId), version: integer(service.version, 1), providerKey: text(service.providerKey) };
  });
  if (new Set(services.map(service => `${service.serviceId}\0${service.version}\0${service.providerKey}`)).size !== services.length) fail('duplicate declared choice');
  return { owner: { hostId: text(owner.hostId), realmId: text(owner.realmId), extensionId: text(owner.extensionId), extensionVersion: text(owner.extensionVersion),
    entrypointId: text(owner.entrypointId), generation: integer(owner.generation, 1), desiredRevision: integer(owner.desiredRevision) },
    surface: input.surface as VarinApplicationSurface, slot: input.slot as VarinExtensionArtifactSlot,
    artifactIntegrity: text(input.artifactIntegrity), routing: parseVarinExtensionServiceRoutingContext(input.routing, { allowEmpty: true }),
    expectedRoutingRevision: integer(input.expectedRoutingRevision), services };
}
export function parseVarinSurfaceServiceLeaseEvent(value: unknown): VarinSurfaceServiceLeaseEvent {
  const input = record(value);
  if (input.kind === 'ready') {
    exact(input, ['kind', 'leaseId', 'routingRevision', 'providers']);
    return { kind: 'ready', leaseId: text(input.leaseId), routingRevision: integer(input.routingRevision),
      providers: parseVarinExtensionServiceCatalogSnapshot({ hostId: '00000000-0000-4000-8000-000000000001', revision: 0, providers: input.providers }).providers };
  }
  if (input.kind === 'revoked') { exact(input, ['kind', 'code']); return { kind: 'revoked', code: text(input.code) }; }
  if (input.kind === 'error') { exact(input, ['kind', 'message']); return { kind: 'error', message: text(input.message) }; }
  return fail('unsupported event');
}
