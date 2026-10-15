import type { JsonValue, VarinExtensionServiceRequirement } from './types.js';
import { VarinExtensionContractError } from './contract-error.js';

/** Immutable implementation identities. This graph records a binding, never grants permission. */
export interface VarinHostCompositionDependency {
  id: string;
  version: number;
  binding: 'single' | 'selected' | 'all';
  optional: boolean;
  providers: Array<{ nodeId: string; providerKey: string }>;
}
export interface VarinHostCompositionNode {
  id: string;
  extensionId: string;
  entrypointId: 'host';
  extensionVersion: string;
  artifactIntegrity: string;
  /** Host activation currently has no independent configuration input. Mutable storage is not configuration. */
  activationConfiguration: null;
  grants: Array<{ capability: string; granted: boolean }>;
  dependencies: VarinHostCompositionDependency[];
}
export interface VarinHostServiceComposition {
  schemaVersion: 1;
  root: string;
  nodes: VarinHostCompositionNode[];
}
/** The actual activation binding sent to a worker. Exact IDs are not a selection table. */
export interface VarinHostServiceDependencyBinding extends VarinExtensionServiceRequirement {
  providerIds: string[];
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new VarinExtensionContractError('Invalid Host service composition', [message]); };
const text = (value: unknown, label: string): string => typeof value === 'string' && value.trim() ? value : fail(`${label} must be non-empty`);
const fields = (value: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('unknown field');
};

export function parseVarinHostServiceComposition(value: unknown): VarinHostServiceComposition {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes)) return fail('unsupported graph');
  fields(value, ['schemaVersion', 'root', 'nodes']);
  const nodes = value.nodes.map((raw): VarinHostCompositionNode => {
    if (!record(raw) || raw.entrypointId !== 'host' || raw.activationConfiguration !== null
      || !Array.isArray(raw.grants) || !Array.isArray(raw.dependencies)) return fail('invalid node');
    fields(raw, ['id', 'extensionId', 'entrypointId', 'extensionVersion', 'artifactIntegrity', 'activationConfiguration', 'grants', 'dependencies']);
    const grants = raw.grants.map(grant => {
      if (!record(grant) || typeof grant.granted !== 'boolean') return fail('invalid grant identity');
      fields(grant, ['capability', 'granted']);
      return { capability: text(grant.capability, 'capability'), granted: grant.granted };
    });
    if (new Set(grants.map(grant => grant.capability)).size !== grants.length) fail('duplicate grant identity');
    const dependencies = raw.dependencies.map((dependency): VarinHostCompositionDependency => {
      if (!record(dependency) || !['single', 'selected', 'all'].includes(String(dependency.binding))
        || typeof dependency.optional !== 'boolean' || !Number.isSafeInteger(dependency.version) || Number(dependency.version) <= 0
        || !Array.isArray(dependency.providers)) return fail('invalid dependency');
      fields(dependency, ['id', 'version', 'binding', 'optional', 'providers']);
      const providers = dependency.providers.map(provider => {
        if (!record(provider)) return fail('invalid dependency provider');
        fields(provider, ['nodeId', 'providerKey']);
        return { nodeId: text(provider.nodeId, 'dependency node'), providerKey: text(provider.providerKey, 'provider key') };
      });
      if (new Set(providers.map(provider => provider.providerKey)).size !== providers.length) fail('duplicate dependency provider');
      if ((!dependency.optional && !providers.length) || (dependency.binding !== 'all' && providers.length > 1)) fail('invalid dependency cardinality');
      return { id: text(dependency.id, 'service ID'), version: Number(dependency.version),
        binding: dependency.binding as VarinHostCompositionDependency['binding'], optional: dependency.optional, providers };
    });
    if (new Set(dependencies.map(dependency => `${dependency.id}@${dependency.version}`)).size !== dependencies.length) fail('duplicate dependency');
    return { id: text(raw.id, 'node ID'), extensionId: text(raw.extensionId, 'extension ID'), entrypointId: 'host',
      extensionVersion: text(raw.extensionVersion, 'extension version'), artifactIntegrity: text(raw.artifactIntegrity, 'artifact integrity'),
      activationConfiguration: null, grants, dependencies };
  });
  const root = text(value.root, 'root');
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || !byId.has(root)) fail('duplicate or missing root node');
  const visited = new Set<string>(), active = new Set<string>();
  const stack: Array<{ id: string; exit: boolean }> = [{ id: root, exit: false }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.exit) { active.delete(item.id); visited.add(item.id); continue; }
    if (active.has(item.id)) fail('dependency cycle');
    if (visited.has(item.id)) continue;
    const node = byId.get(item.id);
    if (!node) return fail('missing dependency node');
    active.add(item.id); stack.push({ id: item.id, exit: true });
    for (const dependency of node.dependencies) for (const provider of dependency.providers) {
      const target = byId.get(provider.nodeId);
      if (!target || provider.providerKey !== `${target.extensionId}:${target.entrypointId}:${dependency.id}@${dependency.version}`) fail('dependency identity mismatch');
      stack.push({ id: provider.nodeId, exit: false });
    }
  }
  if (visited.size !== nodes.length) fail('unreachable node');
  return { schemaVersion: 1, root, nodes };
}

/** Stable JSON for composition identity; object property insertion order is not authority. */
export const canonicalServiceComposition = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export const serviceCompositionJson = (value: VarinHostServiceComposition): JsonValue => value as unknown as JsonValue;

export interface VarinHostServiceClient {
  readonly providerId: string;
  call(method: string, ...args: JsonValue[]): Promise<JsonValue>;
}
export interface VarinHostServiceUseOptions { providerId?: string; optional?: true }
export interface VarinHostServiceConsumers {
  use(id: string, version: number, options: VarinHostServiceUseOptions & { optional: true }): VarinHostServiceClient | undefined;
  use(id: string, version: number, options?: Omit<VarinHostServiceUseOptions, 'optional'>): VarinHostServiceClient;
  useAll(id: string, version: number): readonly VarinHostServiceClient[];
}
/** Broker, trusted-native and author testing use precisely the same frozen client construction. */
export function createHostServiceDependencyClients(bindings: readonly VarinHostServiceDependencyBinding[],
  invoke: (request: { serviceId: string; version: number; providerId: string; method: string; args: JsonValue[] }) => Promise<JsonValue>,
): VarinHostServiceConsumers {
  if (!Array.isArray(bindings as unknown)) throw new Error('Frozen Host dependency bindings must be an array');
  const clients = new Map<string, readonly VarinHostServiceClient[]>();
  for (const binding of bindings) {
    const key = `${binding.id}@${binding.version}`;
    if (clients.has(key)) throw new Error(`Duplicate frozen Host dependency: ${key}`);
    clients.set(key, Object.freeze(binding.providerIds.map(providerId => Object.freeze({ providerId,
      call: (method: string, ...args: JsonValue[]) => invoke({ serviceId: binding.id, version: binding.version, providerId, method, args }),
    }))));
  }
  const useAll = (id: string, version: number): readonly VarinHostServiceClient[] => {
    const selected = clients.get(`${id}@${version}`);
    if (!selected) throw new Error(`Host service dependency was not declared: ${id}@${version}`);
    return selected;
  };
  const use = (id: string, version: number, options?: VarinHostServiceUseOptions): VarinHostServiceClient | undefined => {
    if (options !== undefined && (!record(options) || Object.keys(options).some(key => !['providerId', 'optional'].includes(key)))) throw new Error('Host dependency options are invalid');
    const all = useAll(id, version);
    const selected = options?.providerId ? all.filter(client => client.providerId === options.providerId) : all;
    if (!selected.length && options?.optional === true && !options.providerId) return undefined;
    if (selected.length !== 1) throw new Error(`Host dependency requires one exact frozen implementation: ${id}@${version}`);
    return selected[0];
  };
  return Object.freeze({ use: use as VarinHostServiceConsumers['use'], useAll });
}
