/** Model contributions use the ordinary Host service/composition lifecycle. No installer or
 * executable configuration language is involved: codecs are reviewed extension code. */
import type { JsonValue } from './types.js';
import { parseVarinToolJson } from './tools.js';
export type { ModelProtocolCall, ModelProtocolResult } from './model-protocol.generated.js';

export const VARIN_MODELS_SERVICE_ID = 'varin.models';
export const VARIN_MODELS_VERSION = 1 as const;
/** Reviewed permission to receive this provider's OAuth tokens and perform its account flow. */
export const VARIN_MODEL_AUTHENTICATION_CAPABILITY = 'varin.models.authentication';
export type VarinModelOperation = 'chat' | 'embedding' | 'rerank' | 'decision' | 'image-generation' | 'image-editing';
export type VarinModelThinkingLevel = 'off' | 'on' | 'budget' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type VarinModelThinkingConfiguration =
  | { mode: 'levels'; levels: Exclude<VarinModelThinkingLevel, 'off' | 'on' | 'budget'>[]; allowOff: boolean }
  | { mode: 'switch' | 'fixed' }
  | { mode: 'budget'; tokens: number; allowOff: boolean };
export interface VarinModelCatalogEntry {
  id: string; requestModelId?: string; name: string; enabled: boolean; operations: VarinModelOperation[];
  input?: ('text' | 'image')[]; contextWindow?: number; maxOutputTokens?: number; reasoning?: boolean;
  thinking?: VarinModelThinkingConfiguration;
  thinkingLevelMap?: Partial<Record<VarinModelThinkingLevel, string | null>>;
  parameters?: Record<string, JsonValue>; compat?: Record<string, JsonValue>;
}
export interface VarinModelAdapterDescription {
  id: string; version: string; protocolFamily: string;
  /** Nonsecret protocol headers only. Credentials always come from the dispatch owner. */
  headers: Record<string, string>;
}
export interface VarinModelChannelDescription {
  id: string; name: string; protocol: string; defaultBaseUrl?: string;
  authentication: ('credential' | 'environment' | 'none' | 'google-adc' | 'aws-chain')[];
  operations: VarinModelOperation[]; parametersSchema: Record<string, JsonValue>;
  oauthProviders?: { id: string; name: string }[];
  /** Appended to the selected base URL, including its existing path; never changes the origin. */
  adapter?: { id: string; version: string; endpointPath: string };
  credentialHeader?: { name: string; prefix: string };
  /** Read-only candidates. Only explicit user selection/save makes one a configured model. */
  catalog?: VarinModelCatalogEntry[];
}
export interface VarinModelAuthenticationDescription {
  id: string; name: string;
  /** Host applies the token; the protocol encoder never sees credentials. */
  header: string; prefix: string;
  /** Exact HTTPS token endpoints permitted by the reviewed authentication capability. */
  endpoints?: string[];
}
export interface VarinModelsDescription {
  channels: VarinModelChannelDescription[];
  adapters: VarinModelAdapterDescription[];
  authentication: VarinModelAuthenticationDescription[];
}
export interface VarinModelOAuthToken {
  kind: 'oauth'; provider: string; accessToken: string; refreshToken?: string; expiresAt?: number; accountId?: string;
}
export type VarinModelAuthenticationCall =
  | { kind: 'begin'; provider: string }
  | { kind: 'complete'; provider: string; state: JsonValue; redirect: string }
  | { kind: 'refresh'; provider: string; token: VarinModelOAuthToken };
export type VarinModelAuthenticationResult =
  | { kind: 'pending'; authorizationUrl: string; state: JsonValue }
  | { kind: 'token'; token: VarinModelOAuthToken };
const operations = ['chat', 'embedding', 'rerank', 'decision', 'image-generation', 'image-editing'];
const authentication = ['credential', 'environment', 'none', 'google-adc', 'aws-chain'];
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const allowed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const thinkingLevels = ['off', 'on', 'budget', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const thinkingConfiguration = (v: unknown): boolean => record(v) && (v.mode === 'switch' || v.mode === 'fixed'
  || typeof v.allowOff === 'boolean' && (v.mode === 'budget' && positive(v.tokens)
    || v.mode === 'levels' && Array.isArray(v.levels) && v.levels.length > 0 && new Set(v.levels).size === v.levels.length
      && v.levels.every(level => thinkingLevels.slice(3).includes(level))));
const list = (v: unknown, values: string[]): v is string[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && values.includes(x)) && new Set(v).size === v.length;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function validModelEndpointPath(value: unknown): value is string {
  try { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !/[?#\\\s]/.test(value) && !value.split('/').some(part => { const decoded = decodeURIComponent(part); return ['.', '..'].includes(decoded) || /[\\/]/.test(decoded); }); } catch { return false; }
}
export function parseVarinModelsDescription(value: unknown): VarinModelsDescription {
  assert(record(value) && allowed(value, ['channels', 'adapters', 'authentication']) && Array.isArray(value.channels)
    && Array.isArray(value.adapters) && Array.isArray(value.authentication), 'Invalid model contributions');
  const unique = (entries: unknown[]) => { const ids = new Set<string>(); for (const entry of entries) { assert(record(entry) && text(entry.id) && !ids.has(entry.id), 'Duplicate or invalid model contribution identity'); ids.add(entry.id); } };
  unique(value.channels); unique(value.adapters); unique(value.authentication);
  for (const adapter of value.adapters) {
    assert(record(adapter) && allowed(adapter, ['id', 'version', 'protocolFamily', 'headers']) && text(adapter.id) && text(adapter.version)
      && text(adapter.protocolFamily) && record(adapter.headers), 'Invalid model adapter');
    for (const [name, header] of Object.entries(adapter.headers)) {
      assert(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && typeof header === 'string' && !/[\r\n]/.test(header)
        && !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key|host|content-length|transfer-encoding)$/i.test(name), 'Invalid model adapter protocol header');
    }
  }
  for (const entry of value.authentication) {
    assert(record(entry) && allowed(entry, ['id', 'name', 'header', 'prefix', 'endpoints']) && text(entry.name) && typeof entry.header === 'string'
      && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.header) && !/^(host|cookie|set-cookie|content-length|transfer-encoding)$/i.test(entry.header)
      && typeof entry.prefix === 'string' && !/[\r\n]/.test(entry.prefix), 'Invalid model authentication provider');
    if (entry.endpoints !== undefined) { assert(Array.isArray(entry.endpoints), 'Invalid authentication endpoints'); for (const endpoint of entry.endpoints) { assert(text(endpoint), 'Invalid authentication endpoint'); const url = new URL(endpoint); assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'Invalid authentication endpoint'); } }
  }
  for (const channel of value.channels) {
    assert(record(channel) && allowed(channel, ['id', 'name', 'protocol', 'defaultBaseUrl', 'authentication', 'operations', 'parametersSchema', 'oauthProviders', 'adapter', 'credentialHeader', 'catalog'])
      && text(channel.name) && text(channel.protocol) && list(channel.authentication, authentication) && list(channel.operations, operations)
      && record(channel.parametersSchema), 'Invalid model channel contribution');
    if (channel.defaultBaseUrl !== undefined) { assert(text(channel.defaultBaseUrl), 'Invalid channel default URL'); const url = new URL(channel.defaultBaseUrl); assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Invalid channel default URL'); }
    if (channel.adapter !== undefined) {
      assert(record(channel.adapter) && allowed(channel.adapter, ['id', 'version', 'endpointPath']) && text(channel.adapter.id) && text(channel.adapter.version)
        && validModelEndpointPath(channel.adapter.endpointPath), 'Invalid channel adapter binding');
      const adapter = value.adapters.find(entry => record(entry) && entry.id === (channel.adapter as Record<string, unknown>).id);
      assert(record(adapter) && adapter.version === channel.adapter.version && adapter.protocolFamily === channel.protocol, 'Channel adapter is not contributed by this provider');
      assert(channel.operations.every(operation => operation === 'chat'), 'Brokered SSE adapters currently implement chat only');
      assert(channel.authentication.every(kind => ['credential', 'environment', 'none'].includes(kind)), 'Brokered SSE adapters require an explicit credential source');
      if (channel.authentication.some(kind => kind === 'credential' || kind === 'environment')) assert(channel.credentialHeader !== undefined, 'Custom protocols require an explicit credential header');
    }
    if (channel.credentialHeader !== undefined) {
      const header = channel.credentialHeader;
      assert(record(header) && allowed(header, ['name', 'prefix']) && typeof header.name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)
        && !/^(host|cookie|set-cookie|content-length|transfer-encoding)$/i.test(header.name) && typeof header.prefix === 'string' && !/[\r\n]/.test(header.prefix), 'Invalid model credential header');
    }
    if (channel.oauthProviders !== undefined) {
      assert(Array.isArray(channel.oauthProviders), 'Invalid channel authentication providers');
      for (const provider of channel.oauthProviders) assert(record(provider) && allowed(provider, ['id', 'name']) && text(provider.id) && text(provider.name)
        && value.authentication.some(entry => record(entry) && entry.id === provider.id), 'Unknown channel authentication provider');
    }
    if (channel.catalog !== undefined) {
      assert(Array.isArray(channel.catalog), 'Invalid channel model catalog'); unique(channel.catalog);
      for (const model of channel.catalog) {
        assert(record(model) && allowed(model, ['id', 'requestModelId', 'name', 'enabled', 'operations', 'input', 'contextWindow', 'maxOutputTokens', 'reasoning', 'thinking', 'thinkingLevelMap', 'parameters', 'compat'])
          && text(model.name) && typeof model.enabled === 'boolean' && list(model.operations, operations)
          && model.operations.every(operation => (channel.operations as string[]).includes(operation))
          && (model.requestModelId === undefined || text(model.requestModelId))
          && (model.input === undefined || list(model.input, ['text', 'image']))
          && (model.contextWindow === undefined || positive(model.contextWindow)) && (model.maxOutputTokens === undefined || positive(model.maxOutputTokens))
          && (model.reasoning === undefined || typeof model.reasoning === 'boolean')
          && (model.thinking === undefined || thinkingConfiguration(model.thinking))
          && (model.thinkingLevelMap === undefined || record(model.thinkingLevelMap) && Object.entries(model.thinkingLevelMap).every(([key, value]) => thinkingLevels.includes(key) && (value === null || text(value))))
          && (model.parameters === undefined || record(model.parameters)) && (model.compat === undefined || record(model.compat)), 'Invalid channel model metadata');
      }
    }
  }
  return parseVarinToolJson(value) as unknown as VarinModelsDescription;
}
export function parseVarinModelOAuthToken(value: unknown): VarinModelOAuthToken {
  assert(record(value) && allowed(value, ['kind', 'provider', 'accessToken', 'refreshToken', 'expiresAt', 'accountId']) && value.kind === 'oauth'
    && text(value.provider) && text(value.accessToken) && (value.refreshToken === undefined || text(value.refreshToken))
    && (value.accountId === undefined || text(value.accountId)) && (value.expiresAt === undefined || typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)), 'Invalid model authentication token');
  return parseVarinToolJson(value) as unknown as VarinModelOAuthToken;
}
export function parseVarinModelAuthenticationCall(value: unknown): VarinModelAuthenticationCall {
  assert(record(value) && text(value.provider), 'Invalid model authentication request');
  if (value.kind === 'begin' && allowed(value, ['kind', 'provider'])) return { kind: 'begin', provider: value.provider };
  if (value.kind === 'complete' && allowed(value, ['kind', 'provider', 'state', 'redirect']) && typeof value.redirect === 'string') return { kind: 'complete', provider: value.provider, state: parseVarinToolJson(value.state), redirect: value.redirect };
  if (value.kind === 'refresh' && allowed(value, ['kind', 'provider', 'token'])) { const token = parseVarinModelOAuthToken(value.token); assert(token.provider === value.provider, 'Authentication token belongs to another provider'); return { kind: 'refresh', provider: value.provider, token }; }
  throw new Error('Invalid model authentication request');
}
export function parseVarinModelAuthenticationResult(value: unknown): VarinModelAuthenticationResult {
  assert(record(value), 'Invalid model authentication result');
  if (value.kind === 'token' && allowed(value, ['kind', 'token'])) return { kind: 'token', token: parseVarinModelOAuthToken(value.token) };
  if (value.kind === 'pending' && allowed(value, ['kind', 'authorizationUrl', 'state']) && text(value.authorizationUrl)) {
    const url = new URL(value.authorizationUrl); assert(url.protocol === 'https:' && !url.username && !url.password, 'Invalid model authorization URL');
    return { kind: 'pending', authorizationUrl: url.href, state: parseVarinToolJson(value.state) };
  }
  throw new Error('Invalid model authentication result');
}
const oneObject = { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object' } };
export const VARIN_MODELS_SERVICE = {
  id: VARIN_MODELS_SERVICE_ID, version: VARIN_MODELS_VERSION, multiple: true,
  contract: { composition: 'ordered', methods: {
    describe: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: { type: 'object', required: ['channels', 'adapters', 'authentication'] as string[], additionalProperties: false,
      properties: { channels: { type: 'array', items: { type: 'object' } }, adapters: { type: 'array', items: { type: 'object' } }, authentication: { type: 'array', items: { type: 'object' } } } } },
    protocol: { inputSchema: oneObject, outputSchema: { type: 'object' } },
    authenticate: { inputSchema: oneObject, outputSchema: { type: 'object' } },
  } },
} as const;
