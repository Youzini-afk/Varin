import type { JsonValue } from './types.js';
import type { DriverRunInput, DriverRunOutcome } from './run-driver.generated.js';
import {
  parseVarinExtensionServiceRoutingDocument, resolveVarinExtensionServiceRouting,
  type VarinExtensionServiceRoutingCandidate, type VarinExtensionServiceRoutingContext,
  type VarinExtensionServiceRoutingResolution,
} from './service-routing.js';

export const VARIN_AGENT_DRIVER_SERVICE_ID = 'varin.agent.driver';
export const VARIN_AGENT_DRIVER_VERSION = 1 as const;
/** A native consumer choice, not a registered Host service or extension provider. */
export const VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY = 'varin.builtin.agent-driver';
/** A Host grant and an original live Run invocation are both required. This is not a sandbox. */
export const VARIN_AGENT_DRIVER_CAPABILITY = 'runtime.driver';
export const VARIN_AGENT_DRIVER_SERVICE = {
  id: VARIN_AGENT_DRIVER_SERVICE_ID, version: VARIN_AGENT_DRIVER_VERSION, multiple: true,
} as const;

export interface VarinAgentDriverIdentity { name: string; version: string }
export interface VarinAgentDriverDescription {
  identity: VarinAgentDriverIdentity;
  configuration: JsonValue;
  /** Currently prepared by Varin's model settings; parallel calls can also share the primary model. */
  modelRoles: 'agentPlanning'[];
  recovery: 'none' | 'checkpoint';
  /** An exact private state format, not a semver compatibility guess. Required for checkpoint recovery. */
  checkpointSchema: string | null;
}

export const VARIN_AGENT_DRIVER_CONTRACT = {
  id: VARIN_AGENT_DRIVER_SERVICE_ID, version: VARIN_AGENT_DRIVER_VERSION,
  methods: ['describe', 'run'], participation: 'execution',
  capability: VARIN_AGENT_DRIVER_CAPABILITY,
  capabilityMethods: ['model', 'tool', 'context', 'wait', 'cancel', 'checkpoint', 'deliver', 'receipt'],
  invocation: 'original_run_epoch_and_instance',
  completion: 'algorithm_return_is_not_executor_stop',
} as const;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function json(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(json); return; }
  if (object(value)) { Object.values(value).forEach(json); return; }
  throw new Error('Agent driver configuration must be JSON data');
}

export function parseVarinAgentDriverDescription(value: unknown): VarinAgentDriverDescription {
  if (!object(value) || !exact(value, ['identity', 'configuration', 'modelRoles', 'recovery', 'checkpointSchema'])
    || !object(value.identity) || !exact(value.identity, ['name', 'version'])
    || !text(value.identity.name) || !text(value.identity.version)
    || !Array.isArray(value.modelRoles) || value.modelRoles.some(role => role !== 'agentPlanning')
    || new Set(value.modelRoles).size !== value.modelRoles.length
    || !(value.recovery === 'none' && value.checkpointSchema === null
      || value.recovery === 'checkpoint' && text(value.checkpointSchema))) {
    throw new Error('Invalid agent driver description: recovery and checkpoint schema must agree');
  }
  json(value.configuration);
  return structuredClone(value) as unknown as VarinAgentDriverDescription;
}

/** Shared service envelope check. Native schema decoding remains authoritative for nested model,
 * tool and receipt wire DTOs; this is not a second independently maintained execution schema. */
export function parseVarinAgentDriverRunInput(value: unknown): DriverRunInput {
  if (!object(value) || !exact(value, ['runId', 'epoch', 'mode', 'history', 'tools', 'models', 'checkpoint', 'receipts'])
    || !text(value.runId) || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0
    || !['start', 'resume'].includes(String(value.mode))
    || (value.mode === 'start' ? value.checkpoint !== null : value.checkpoint === null)
    || !Array.isArray(value.history) || !Array.isArray(value.tools) || !Array.isArray(value.models) || !Array.isArray(value.receipts)
    || !(value.checkpoint === null || object(value.checkpoint) && text(value.checkpoint.schema)
      && Number.isSafeInteger(value.checkpoint.revision) && Number(value.checkpoint.revision) >= 0
      && 'state' in value.checkpoint && Array.isArray(value.checkpoint.operations) && value.checkpoint.operations.every(text))) {
    throw new Error('Invalid agent driver Run input envelope');
  }
  json(value);
  return structuredClone(value) as unknown as DriverRunInput;
}

export function parseVarinAgentDriverRunOutcome(value: unknown): DriverRunOutcome {
  if (!object(value) || !(value.kind === 'complete' && exact(value, ['kind'])
    || value.kind === 'pause' && exact(value, ['kind', 'reason']) && text(value.reason)
    || value.kind === 'fail' && exact(value, ['kind', 'error']) && object(value.error)
      && text(value.error.code) && text(value.error.message)
      && (value.error.tool_name === undefined || text(value.error.tool_name)))) {
    throw new Error('Invalid agent driver Run outcome');
  }
  json(value);
  return structuredClone(value) as unknown as DriverRunOutcome;
}

export type VarinAgentDriverRoutingResolution = {
  routing: VarinExtensionServiceRoutingResolution;
} & ({ kind: 'builtin' } | { kind: 'extension'; providerKey: string; providerId: string } | { kind: 'unavailable' });

/** The existing routing document owns selection and precedence. Installing a driver never selects
 * it; an unavailable explicit choice never switches algorithms, even on a legacy fallback rule. */
export function resolveVarinAgentDriverRouting(options: {
  candidates: readonly VarinExtensionServiceRoutingCandidate[];
  context?: VarinExtensionServiceRoutingContext;
  document: unknown;
}): VarinAgentDriverRoutingResolution {
  const document = parseVarinExtensionServiceRoutingDocument(options.document);
  const applicable = document.rules.filter(rule => rule.serviceId === VARIN_AGENT_DRIVER_SERVICE_ID
    && Object.entries(rule.scope).every(([key, value]) => options.context?.[key as keyof VarinExtensionServiceRoutingContext] === value));
  if (!applicable.some(rule => rule.version === VARIN_AGENT_DRIVER_VERSION) && applicable.length) {
    return { kind: 'unavailable', routing: { status: 'unavailable', diagnostics: [{
      code: 'agent_driver_version_unsupported', severity: 'error', timestamp: new Date().toISOString(),
      message: `Explicit driver routing requires unsupported service version(s): ${[...new Set(applicable.map(rule => rule.version))].join(', ')}`,
    }] } };
  }
  const routing = resolveVarinExtensionServiceRouting({
    ...(options.context ? { context: options.context } : {}),
    document: { ...document, rules: document.rules.map(rule => rule.serviceId === VARIN_AGENT_DRIVER_SERVICE_ID
      && rule.version === VARIN_AGENT_DRIVER_VERSION ? { ...rule, allowFallback: false } : rule) },
    candidates: [...options.candidates.filter(candidate => candidate.providerKey !== VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY),
      { providerId: VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY, providerKey: VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY }],
    defaultProviderKey: VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY,
    serviceId: VARIN_AGENT_DRIVER_SERVICE_ID, version: VARIN_AGENT_DRIVER_VERSION,
  });
  if (routing.status !== 'resolved') return { kind: 'unavailable', routing };
  if (routing.providerKeys.length !== 1 || routing.providerIds.length !== 1) {
    return { kind: 'unavailable', routing: { status: 'unavailable', diagnostics: [{
      code: 'agent_driver_single_required', severity: 'error', timestamp: new Date().toISOString(),
      message: 'A Run requires exactly one selected driver',
    }] } };
  }
  const providerKey = routing.providerKeys[0]!;
  return providerKey === VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY ? { kind: 'builtin', routing }
    : { kind: 'extension', routing, providerKey, providerId: routing.providerIds[0]! };
}
