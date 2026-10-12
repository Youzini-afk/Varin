import {
  parseVarinPackageSourcePath, parseVarinRuntimeSourceRequest, parseVarinRuntimeSourceResult,
  parseVarinRuntimeSourceArtifact, VARIN_RUNTIME_SOURCE_REQUEST_SCHEMA,
  type VarinRuntimeSourceArtifact, type VarinRuntimeSourceRequest, type VarinRuntimeSourceResult,
} from './runtime-source.js';
import type {
  JsonObject, JsonValue, VarinExtensionActualStatus, VarinExtensionServiceRequirement,
  VarinExtensionServiceProviderStatus,
} from './types.js';
import type { VarinExtensionServiceRoutingContext } from './service-routing.js';
import type { VarinWorkbenchResolutionContext } from './workbench.js';
import { parseVarinToolJson } from './tools.js';

export type VarinContractSchema = JsonObject | boolean;
export interface VarinContractSource { path: string; line?: number }
export interface VarinServiceMethodContract {
  inputSchema: VarinContractSchema;
  outputSchema: VarinContractSchema;
  description?: string;
  examples?: JsonValue[];
  source?: VarinContractSource;
}
export interface VarinServiceEventContract {
  schema: VarinContractSchema;
  description?: string;
  source?: VarinContractSource;
}
/** Optional declarative metadata. Absence is not an empty method/event contract. */
export interface VarinExtensionServiceContract {
  participation?: 'provider' | 'transform' | 'decision' | 'observer';
  /** Explicit selection order is part of this contract. Omission never implies collection support. */
  composition?: 'ordered';
  methods: Record<string, VarinServiceMethodContract>;
  events?: Record<string, VarinServiceEventContract>;
}

export type VarinRuntimeContractRequest = VarinRuntimeSourceRequest
  | { action: 'list'; kind: 'service' | 'ui_slot' }
  | { action: 'describe'; kind: 'service'; serviceId: string; version: number; extensionId?: string;
      member?: { kind: 'method' | 'event'; name: string } }
  | { action: 'describe'; kind: 'ui_slot'; id: string };

/** The ordinary tool additionally has a live invocation. The User catalog API does not. */
export type VarinRuntimeInspectionRequest = VarinRuntimeContractRequest
  | { action: 'list'; kind: 'tool' }
  | { action: 'describe'; kind: 'tool'; name: string };
export type VarinRuntimeInspectionResult = VarinRuntimeContractResult
  | import('./nested-tools.generated.js').NestedToolInspection;

/** Trusted caller context, deliberately separate from the external query. */
export interface VarinRuntimeContractScope {
  routing?: VarinExtensionServiceRoutingContext;
  workbench?: VarinWorkbenchResolutionContext;
}
export interface VarinRuntimeContractBasis {
  origin: 'current_catalog';
  permission: 'checked_on_invocation';
  hostId: string;
  authoritative: boolean;
  revisions: { catalog: number; services: number; routing: number; workbench: number };
}
export interface VarinRuntimeServiceImplementation {
  extensionId: string;
  extensionVersion: string;
  /** Current selected descriptor; candidate is only an exact package reference, not this descriptor's contract. */
  artifacts: { selected: VarinRuntimeSourceArtifact | null; candidate: VarinRuntimeSourceArtifact | null };
  providerKey: string;
  enabled: boolean;
  registration: 'declared' | 'registered';
  /** Original owner observations. An empty array provides no lifecycle evidence. */
  actual: Array<{ status: VarinExtensionActualStatus; generation: number; codes: string[] }>;
  contractStatus: 'declared' | 'undeclared';
  composition?: 'ordered';
  methods: string[] | null;
  events: string[] | null;
  /** Manifest dependency declarations, never inferred readiness or capability grants. */
  requirements: VarinExtensionServiceRequirement[];
}
export interface VarinRuntimeServiceInstance {
  providerId: string;
  providerKey: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  status: VarinExtensionServiceProviderStatus;
}
export interface VarinRuntimeServiceSummary {
  serviceId: string;
  version: number;
  implementations: VarinRuntimeServiceImplementation[];
  /** Original registry facts. Older instances do not inherit the current manifest's dependencies. */
  instances: VarinRuntimeServiceInstance[];
  selection: {
    status: 'resolved' | 'ambiguous' | 'unavailable' | 'stale';
    providerKey?: string;
    providerId?: string;
    composition?: 'ordered';
    providerKeys?: string[];
    providerIds?: string[];
    codes: string[];
  };
}
export interface VarinRuntimeSlotSummary {
  id: string;
  version: number;
  placement: 'list';
  hosting: 'declared' | 'dormant' | 'unresolved';
  live: 'unobserved';
  codes?: string[];
  selectedShell: { extensionId: string; contributionId: string } | null;
}
export type VarinRuntimeContractResult = VarinRuntimeSourceResult | VarinRuntimeContractBasis & (
  | { action: 'list'; kind: 'service'; entries: VarinRuntimeServiceSummary[] }
  | { action: 'list'; kind: 'ui_slot'; entries: VarinRuntimeSlotSummary[] }
  | { action: 'describe'; kind: 'service'; status: 'found' | 'missing' | 'undeclared' | 'unresolved';
      service: VarinRuntimeServiceSummary | null;
      member: null | { kind: 'method'; name: string; extensionId: string; contract: VarinServiceMethodContract }
        | { kind: 'event'; name: string; extensionId: string; contract: VarinServiceEventContract } }
  | { action: 'describe'; kind: 'ui_slot'; status: 'found' | 'missing';
      slot: (VarinRuntimeSlotSummary & { propsSchema: VarinContractSchema }) | null }
);

const textSchema = { type: 'string', minLength: 1 };
const objectSchema = (properties: JsonObject, required: string[]): JsonObject => ({
  type: 'object', additionalProperties: false, properties, required,
});
/** The normal tool and author/API query decoder share this declaration. */
export const VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA: JsonObject = {
  oneOf: [VARIN_RUNTIME_SOURCE_REQUEST_SCHEMA,
    objectSchema({ action: { const: 'list' }, kind: { enum: ['service', 'ui_slot'] } }, ['action', 'kind']),
    objectSchema({ action: { const: 'describe' }, kind: { const: 'service' }, serviceId: textSchema,
      version: { type: 'integer', minimum: 1 }, extensionId: textSchema,
      member: objectSchema({ kind: { enum: ['method', 'event'] }, name: textSchema }, ['kind', 'name']),
    }, ['action', 'kind', 'serviceId', 'version']),
    objectSchema({ action: { const: 'describe' }, kind: { const: 'ui_slot' }, id: textSchema }, ['action', 'kind', 'id']),
  ],
};
export const VARIN_RUNTIME_CONTRACTS_CAPABILITY = 'runtime.contracts';
export const VARIN_RUNTIME_INSPECTION_REQUEST_SCHEMA: JsonObject = {
  oneOf: [VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA,
    objectSchema({ action: { const: 'list' }, kind: { const: 'tool' } }, ['action', 'kind']),
    objectSchema({ action: { const: 'describe' }, kind: { const: 'tool' }, name: textSchema }, ['action', 'kind', 'name']),
  ],
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unknown field`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty`);
  return value;
}
export function parseVarinRuntimeContractRequest(value: unknown): VarinRuntimeContractRequest {
  const raw = record(value, 'Contract query');
  if (raw.kind === 'source') return parseVarinRuntimeSourceRequest(value);
  if (raw.action === 'list' && (raw.kind === 'service' || raw.kind === 'ui_slot')) {
    fields(raw, ['action', 'kind'], 'Contract query');
    return { action: 'list', kind: raw.kind };
  }
  if (raw.action === 'describe' && raw.kind === 'ui_slot') {
    fields(raw, ['action', 'kind', 'id'], 'Contract query');
    return { action: 'describe', kind: 'ui_slot', id: text(raw.id, 'Slot ID') };
  }
  if (raw.action === 'describe' && raw.kind === 'service') {
    fields(raw, ['action', 'kind', 'serviceId', 'version', 'extensionId', 'member'], 'Contract query');
    if (!Number.isSafeInteger(raw.version) || Number(raw.version) < 1) throw new Error('Service version must be a positive integer');
    let member: { kind: 'method' | 'event'; name: string } | undefined;
    if (raw.member !== undefined) {
      const item = record(raw.member, 'Contract member');
      fields(item, ['kind', 'name'], 'Contract member');
      if (item.kind !== 'method' && item.kind !== 'event') throw new Error('Contract member kind is invalid');
      member = { kind: item.kind, name: text(item.name, 'Contract member name') };
    }
    return { action: 'describe', kind: 'service', serviceId: text(raw.serviceId, 'Service ID'), version: Number(raw.version),
      ...(raw.extensionId === undefined ? {} : { extensionId: text(raw.extensionId, 'Extension ID') }), ...(member ? { member } : {}) };
  }
  throw new Error('Contract query action or kind is invalid');
}

export function parseVarinRuntimeInspectionRequest(value: unknown): VarinRuntimeInspectionRequest {
  const raw = record(value, 'Runtime inspection');
  if (raw.kind !== 'tool') return parseVarinRuntimeContractRequest(value);
  if (raw.action === 'list') {
    fields(raw, ['action', 'kind'], 'Tool inspection');
    return { action: 'list', kind: 'tool' };
  }
  if (raw.action === 'describe') {
    fields(raw, ['action', 'kind', 'name'], 'Tool inspection');
    return { action: 'describe', kind: 'tool', name: text(raw.name, 'Tool name') };
  }
  throw new Error('Tool inspection action is invalid');
}

/** Source metadata is a logical package location, never a Host path or source read permission. */
export function parseVarinContractSource(value: unknown): VarinContractSource {
  const raw = record(value, 'Contract source');
  fields(raw, ['path', 'line'], 'Contract source');
  const path = parseVarinPackageSourcePath(raw.path);
  if (raw.line !== undefined && (!Number.isSafeInteger(raw.line) || Number(raw.line) < 1)) throw new Error('Contract source line must be positive');
  return { path, ...(raw.line === undefined ? {} : { line: Number(raw.line) }) };
}
function schema(value: unknown): VarinContractSchema {
  const parsed = parseVarinToolJson(value, 'Contract schema');
  if (typeof parsed !== 'boolean' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Contract schema must be an object or boolean');
  return parsed;
}
export function parseVarinExtensionServiceContract(value: unknown): VarinExtensionServiceContract {
  const raw = record(parseVarinToolJson(value), 'Service contract');
  fields(raw, ['participation', 'composition', 'methods', 'events'], 'Service contract');
  if (raw.participation !== undefined && !['provider', 'transform', 'decision', 'observer'].includes(String(raw.participation))) throw new Error('Service participation is invalid');
  if (raw.composition !== undefined && raw.composition !== 'ordered') throw new Error('Service composition is invalid');
  const methods = Object.fromEntries(Object.entries(record(raw.methods, 'Service methods')).map(([name, value]) => {
    text(name, 'Method name');
    const method = record(value, 'Service method');
    fields(method, ['inputSchema', 'outputSchema', 'description', 'examples', 'source'], 'Service method');
    if (method.examples !== undefined && !Array.isArray(method.examples)) throw new Error('Method examples must be an array');
    return [name, { inputSchema: schema(method.inputSchema), outputSchema: schema(method.outputSchema),
      ...(method.description === undefined ? {} : { description: text(method.description, 'Method description') }),
      ...(method.examples === undefined ? {} : { examples: method.examples as JsonValue[] }),
      ...(method.source === undefined ? {} : { source: parseVarinContractSource(method.source) }),
    } satisfies VarinServiceMethodContract];
  }));
  const events = raw.events === undefined ? undefined : Object.fromEntries(Object.entries(record(raw.events, 'Service events')).map(([name, value]) => {
    text(name, 'Event name');
    const event = record(value, 'Service event');
    fields(event, ['schema', 'description', 'source'], 'Service event');
    return [name, { schema: schema(event.schema),
      ...(event.description === undefined ? {} : { description: text(event.description, 'Event description') }),
      ...(event.source === undefined ? {} : { source: parseVarinContractSource(event.source) }),
    } satisfies VarinServiceEventContract];
  }));
  return { methods, ...(events ? { events } : {}), ...(raw.composition === undefined ? {} : { composition: 'ordered' as const }),
    ...(raw.participation === undefined ? {} : { participation: raw.participation as NonNullable<VarinExtensionServiceContract['participation']> }) };
}

/** Validate the public response at the transport boundary without calling an extension. */
export function parseVarinRuntimeContractResult(value: unknown): VarinRuntimeContractResult {
  const raw = record(parseVarinToolJson(value), 'Contract result');
  if (raw.kind === 'source') return parseVarinRuntimeSourceResult(raw);
  const requireValue = (condition: unknown): void => { if (!condition) throw new Error('Invalid contract result'); };
  const number = (value: unknown): void => requireValue(Number.isSafeInteger(value) && Number(value) >= 0);
  const strings = (value: unknown): void => {
    requireValue(Array.isArray(value));
    for (const item of value as unknown[]) text(item, 'Contract result identifier');
  };
  const list = (value: unknown): unknown[] => {
    requireValue(Array.isArray(value));
    return value as unknown[];
  };
  requireValue(raw.origin === 'current_catalog' && raw.permission === 'checked_on_invocation' && typeof raw.authoritative === 'boolean');
  text(raw.hostId, 'Contract Host');
  const revisions = record(raw.revisions, 'Contract revisions');
  fields(revisions, ['catalog', 'services', 'routing', 'workbench'], 'Contract revisions');
  for (const key of ['catalog', 'services', 'routing', 'workbench']) number(revisions[key]);
  const service = (value: unknown): void => {
    const item = record(value, 'Service summary');
    text(item.serviceId, 'Service ID'); number(item.version); requireValue(Number(item.version) > 0);
    const selection = record(item.selection, 'Service selection');
    requireValue(['resolved', 'ambiguous', 'unavailable', 'stale'].includes(String(selection.status)));
    strings(selection.codes);
    for (const key of ['providerId', 'providerKey']) if (selection[key] !== undefined) text(selection[key], key);
    if (selection.composition !== undefined) requireValue(selection.composition === 'ordered');
    for (const key of ['providerIds', 'providerKeys']) if (selection[key] !== undefined) strings(selection[key]);
    if (selection.composition === 'ordered') {
      requireValue(selection.providerId === undefined && selection.providerKey === undefined);
      if (selection.providerKeys !== undefined) requireValue(new Set(selection.providerKeys as string[]).size === (selection.providerKeys as string[]).length);
      if (selection.providerIds !== undefined) requireValue(Array.isArray(selection.providerKeys)
        && (selection.providerIds as string[]).length === selection.providerKeys.length);
    } else requireValue(selection.providerKeys === undefined && selection.providerIds === undefined);
    for (const value of list(item.instances)) {
      const instance = record(value, 'Service instance');
      for (const key of ['providerId', 'providerKey', 'extensionId', 'extensionVersion']) text(instance[key], key);
      number(instance.generation); requireValue(['active', 'candidate', 'draining'].includes(String(instance.status)));
    }
    for (const value of list(item.implementations)) {
      const implementation = record(value, 'Service implementation');
      if (implementation.composition !== undefined) requireValue(implementation.composition === 'ordered');
      const artifacts = record(implementation.artifacts, 'Implementation artifacts');
      for (const slot of ['selected', 'candidate']) if (artifacts[slot] !== null) {
        const artifact = parseVarinRuntimeSourceArtifact(artifacts[slot]);
        requireValue(artifact.slot === slot && artifact.extensionId === implementation.extensionId);
      }
      for (const key of ['providerKey', 'extensionId', 'extensionVersion']) text(implementation[key], key);
      requireValue(typeof implementation.enabled === 'boolean' && ['declared', 'registered'].includes(String(implementation.registration))
        && ['declared', 'undeclared'].includes(String(implementation.contractStatus)));
      for (const key of ['methods', 'events']) if (implementation[key] !== null) strings(implementation[key]);
      for (const value of list(implementation.actual)) {
        const actual = record(value, 'Service actual state');
        text(actual.status, 'Actual status'); number(actual.generation); strings(actual.codes);
      }
      for (const value of list(implementation.requirements)) {
        const requirement = record(value, 'Service requirement');
        text(requirement.id, 'Requirement ID'); number(requirement.version); requireValue(Number(requirement.version) > 0);
        requireValue(requirement.optional === undefined || typeof requirement.optional === 'boolean');
        requireValue(requirement.binding === undefined || ['all', 'selected', 'single'].includes(String(requirement.binding)));
      }
    }
  };
  const slot = (value: unknown, detail: boolean): void => {
    const item = record(value, 'Slot contract');
    text(item.id, 'Slot ID'); number(item.version); requireValue(Number(item.version) > 0);
    requireValue(item.placement === 'list' && item.live === 'unobserved' && ['declared', 'dormant', 'unresolved'].includes(String(item.hosting)));
    if (item.codes !== undefined) strings(item.codes);
    if (item.selectedShell !== null) {
      const selected = record(item.selectedShell, 'Selected shell');
      text(selected.extensionId, 'Shell extension'); text(selected.contributionId, 'Shell contribution');
    }
    if (detail) schema(item.propsSchema);
  };
  if (raw.action === 'list' && (raw.kind === 'service' || raw.kind === 'ui_slot')) {
    for (const item of list(raw.entries)) {
      if (raw.kind === 'service') service(item);
      else slot(item, false);
    }
  } else if (raw.action === 'describe' && raw.kind === 'service') {
    requireValue(['found', 'missing', 'undeclared', 'unresolved'].includes(String(raw.status)));
    if (raw.service !== null) service(raw.service);
    if (raw.member !== null) {
      const member = record(raw.member, 'Service member');
      text(member.name, 'Member name'); text(member.extensionId, 'Member extension');
      requireValue(raw.status === 'found');
      if (member.kind === 'method') parseVarinExtensionServiceContract({ methods: { [String(member.name)]: member.contract } });
      else if (member.kind === 'event') parseVarinExtensionServiceContract({ methods: {}, events: { [String(member.name)]: member.contract } });
      else throw new Error('Invalid contract member');
    }
  } else if (raw.action === 'describe' && raw.kind === 'ui_slot') {
    requireValue(['found', 'missing'].includes(String(raw.status)));
    requireValue((raw.status === 'found') === (raw.slot !== null));
    if (raw.slot !== null) slot(raw.slot, true);
  } else throw new Error('Invalid contract result action or kind');
  return raw as unknown as VarinRuntimeContractResult;
}
