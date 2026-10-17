/** Public model configuration. Credentials are references, never resolved secrets. */
import type { JsonValue, ThinkingLevel } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
import type { AuthorizationState } from './mcp-connections.js';

export type ModelOperation = 'chat' | 'embedding' | 'rerank' | 'decision' | 'image-generation' | 'image-editing';
export type ModelDecisionPaths = Partial<Record<'classify' | 'tokenize' | 'applyTemplate' | 'completion', string>>;
/** Non-secret connection settings. Omitted proxy inherits the executing Host's policy. */
export interface ModelConnectionOptions {
  headers?: Record<string, string>;
  /** Paths append to baseUrl's existing path; they cannot change origin or query. */
  paths?: Partial<Record<ModelOperation, string>>;
  proxy?: { mode: 'direct' } | { mode: 'proxy'; url: string };
}
export type ConnectionAuthentication =
  | { kind: 'none' }
  | { kind: 'credential'; reference: string }
  | { kind: 'environment'; variable: string }
  | { kind: 'google-adc'; file?: string }
  | { kind: 'aws-chain'; profile?: string }
  | { kind: 'anthropic-federation'; identityTokenFile: string; organizationId: string; federationRuleId: string; serviceAccountId?: string; workspaceId?: string };
import type { ModelThinkingConfiguration } from '@varin/protocol';
export type { ModelThinkingEffort, ModelThinkingConfiguration } from '@varin/protocol';
export interface ChannelModel {
  id: string;
  /** Wire protocol for providers serving more than one API. */
  protocol?: string;
  requestModelId?: string;
  name: string;
  enabled: boolean;
  operations: ModelOperation[];
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  thinking?: ModelThinkingConfiguration;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  parameters?: Record<string, JsonValue>;
  compat?: Record<string, JsonValue>;
  image?: { api?: 'openai-images' | 'openrouter-images'; paths?: Partial<Record<'generation' | 'editing', string>>; mask?: boolean; parameters?: Record<string, JsonValue> };
  decision?: { api?: 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify'; paths?: ModelDecisionPaths };
  /** Directory defaults follow updates; listed fields remain explicit user choices. */
  catalog?: { source?: 'service'; overrides: ModelCatalogField[] };
}
export type ModelCatalogField = Exclude<keyof ChannelModel, 'id' | 'enabled' | 'catalog'>;
export const MODEL_CATALOG_FIELDS: readonly ModelCatalogField[] = ['name', 'protocol', 'requestModelId', 'operations', 'input', 'contextWindow', 'maxOutputTokens', 'reasoning', 'thinking', 'thinkingLevelMap', 'parameters', 'compat', 'image', 'decision'];
export interface ModelDirectoryStatus { revision: string; updatedAt?: number; refreshing: boolean; issue?: 'cache-unavailable' | 'refresh-failed' | 'partial-refresh' | 'cache-write-failed' }
export interface ModelDirectorySnapshot { models: ChannelModel[]; status: ModelDirectoryStatus }
export interface ModelChannel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  baseUrl: string;
  connection?: ModelConnectionOptions;
  authentication: ConnectionAuthentication;
  parameters: Record<string, JsonValue>;
  models: ChannelModel[];
}
export interface ChannelTypeInfo {
  id: string;
  name: string;
  protocol: string;
  protocols?: string[];
  defaultBaseUrl?: string;
  defaultModelIds?: string[];
  defaultParameters?: Record<string, JsonValue>;
  defaultEnvironmentVariable?: string;
  authentication: ConnectionAuthentication['kind'][];
  operations: ModelOperation[];
  discovery: boolean;
  parametersSchema: Record<string, JsonValue>;
  oauthProviders?: { id: string; name: string }[];
  /** Read-only contributed candidates; saved channel models remain user-owned. */
  catalog?: ChannelModel[];
}
export interface ModelConnectionsSnapshot { revision: string; channels: ModelChannel[]; types: ChannelTypeInfo[]; directory?: ModelDirectoryStatus; issues?: { channelId?: string; code: string; message: string }[] }
export type DiscoveredModel = Pick<ChannelModel, 'id' | 'name'> & Partial<Omit<ChannelModel, 'id' | 'name' | 'enabled'>>;
/** A transient connection draft. The supplied key is never written by discovery or testing. */
export interface ModelConnectionDraft { channel: ModelChannel; secret?: string }
export interface ModelConnectionTest extends ModelConnectionDraft { key: string; modelId: string; thinkingLevel?: ThinkingLevel }
export interface ModelConnectionTestResult { requestId: string; modelId: string; elapsedMs: number; text: string }
export interface AgentSettingsSnapshot {
  global: Record<string, JsonValue>; globalRevision: string;
  project: Record<string, JsonValue>; projectRevision: string; projectTrusted: boolean;
}
export class ModelConnectionsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Captures the selected Host when constructed, including delayed saves. */
export function createModelConnectionsHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const check = () => {
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new ModelConnectionsError(409, 'host-changed', 'Application Host changed. Reload settings.');
    };
    check();
    const response = await runtimeFetch(`/api/models/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    check();
    const result = await response.json();
    check();
    if (!response.ok) throw new ModelConnectionsError(response.status, result.code ?? 'model-request-failed', result.message ?? 'Model settings request failed.');
    return result as T;
  };
  return {
    read: (signal?: AbortSignal) => post<ModelConnectionsSnapshot>('read', {}, signal),
    directory: (type: string, signal?: AbortSignal, channelId?: string) => post<ModelDirectorySnapshot>('directory', { type, channelId }, signal),
    refreshDirectory: (signal?: AbortSignal) => post<ModelDirectoryStatus>('directory/refresh', {}, signal),
    save: (channel: ModelChannel, expectedRevision: string, signal?: AbortSignal) => post<ModelConnectionsSnapshot>('save', { channel, expectedRevision }, signal),
    remove: (id: string, expectedRevision: string, signal?: AbortSignal) => post<ModelConnectionsSnapshot>('remove', { id, expectedRevision }, signal),
    discover: (id: string, signal?: AbortSignal) => post<{ models: DiscoveredModel[] }>('discover', { id }, signal),
    discoverDraft: (draft: ModelConnectionDraft, signal?: AbortSignal) => post<{ models: DiscoveredModel[] }>('discover-draft', draft, signal),
    test: (input: ModelConnectionTest, signal?: AbortSignal) => post<ModelConnectionTestResult>('test', input, signal),
    storeCredential: (secret: string, reference?: string, signal?: AbortSignal) => post<{ reference: string }>('credentials/store', { secret, reference }, signal),
    removeCredential: (reference: string, signal?: AbortSignal) => post<void>('credentials/remove', { reference }, signal),
    signIn: (provider: string, reference: string, signal?: AbortSignal) => post<AuthorizationState>('authorization/start', { provider, reference }, signal),
    authorization: (id: string, signal?: AbortSignal) => post<AuthorizationState>('authorization/read', { id }, signal),
    replyAuthorization: (id: string, redirect: string) => post<void>('authorization/reply', { id, redirect }),
    cancelAuthorization: (id: string) => post<void>('authorization/cancel', { id }),
    readSettings: (cwd?: string, signal?: AbortSignal) => post<AgentSettingsSnapshot>('settings/read', { cwd }, signal),
    updateSettings: (input: { cwd?: string; scope: 'global' | 'project'; expectedRevision: string; set: Record<string, JsonValue>; remove: string[] }, signal?: AbortSignal) => post<AgentSettingsSnapshot>('settings/update', input, signal),
  };
}
