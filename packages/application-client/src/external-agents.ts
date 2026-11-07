import type { Attachment, AttachmentSelection } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from './transport/runtime-switch.js';

export type ExternalHarness = 'codex' | 'claude' | 'pi' | 'acp';
/** Explicit Host defaults for new drafts, never a remembered last-used choice. */
export interface ExternalAgentDefaults {
  model?: string;
  thinking?: string;
  mode?: string;
}
export interface ExternalAgentConfiguration {
  id: string;
  name: string;
  harness: ExternalHarness;
  enabled: boolean;
  command: string;
  args: string[];
  defaults?: ExternalAgentDefaults;
}
export interface ExternalAgentProfile {
  id: string;
  name: string;
  harness: ExternalHarness;
  description: string;
  installUrl?: string;
  platforms: string[];
  platformArchitectures?: Record<string, string[]>;
  launch: { command: string; args: string[] };
  versionArgs?: string[];
  authentication?: string;
  compatibility?: string;
}
export interface ExternalAuthentication {
  methods: Array<{ id: string; name: string; description?: string; type: 'agent' | 'terminal'; command?: string; args?: string[] }>;
  guidance?: string;
}
export interface ExternalAgentConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: 'select' | 'boolean';
  currentValue: string | boolean;
  options: Array<{ value: string; name: string; description?: string }>;
}
export interface ExternalAgentSettings {
  revision: number;
  profiles?: ExternalAgentProfile[];
  defaultAgent: string | null;
  agents: ExternalAgentConfiguration[];
  /** Last negotiated catalogue for the same launch configuration and program version. */
  capabilityCache?: Record<string, ExternalAgentCapabilityCache>;
}
export interface ExternalAgentCapabilityCache {
  capabilities: ExternalAgentCapabilities;
  agentVersion?: string;
  cachedAt: number;
}
export interface ExternalAgentDetection {
  id: string;
  status: 'available' | 'missing' | 'failed';
  executable?: string;
  version?: string;
  message?: string;
}
export interface ExternalAgentModel {
  id: string;
  name: string;
  thinkingLevels?: string[] | undefined;
}
export interface ExternalAgentCapabilities {
  resume: boolean;
  images: boolean;
  /** Input routes implemented by the actual local harness adapter. */
  files?: 'paths' | 'resource_links';
  steering: boolean;
  models: ExternalAgentModel[];
  modelsError?: string | undefined;
  /** A real native metadata query can retry model discovery without restarting. */
  modelsRefresh?: boolean;
  current?: { model?: string | undefined; thinking?: string | undefined; mode?: string | undefined };
  configOptions?: ExternalAgentConfigOption[];
  commands?: Array<{ name: string; description: string; inputHint?: string }>;
  protocol?: { name: string; version?: string; agentVersion?: string };
  authentication?: ExternalAuthentication;
  resumeMethods?: Array<'load' | 'resume'>;
  modes?: Array<{ id: string; name: string }>;
}
export interface ExternalConversation {
  principalId?: string | null;
  id: string;
  configurationId: string;
  harness: ExternalHarness;
  title: string;
  cwd: string;
  workspaceId?: string;
  nativeWorkspace?: {resource_owner:{kind:'local'};mode:'native_workspace';workspace_id:string;execution_workspace_id:string;
    branch_id:string;revision:null;live_root:null;native_scope?:string};
  sessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  deleted: boolean;
  parent?: { threadId: string; branchId: string; operationId: string };
  activeTurn?: string;
  needsReview?: boolean;
  privateWorkspace?: boolean;
}
export type ExternalTurnStatus =
  | 'awaiting_input'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_user'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface ExternalInput {
  attachmentImageReferences?: Record<string, number>;
  attachments?: AttachmentSelection[];
  config?: Record<string, string>;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  model?: string;
  thinking?: string;
  mode?: string;
}
export interface ExternalTurn {
  arrangementOccurrenceId?: string;
  arrangementLaunch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>;
  arrangementHoldReason?: string;
  blockedReason?: string;
  consumedByTurnId?: string;
  id: string;
  conversationId: string;
  key: string;
  status: ExternalTurnStatus;
  nativeId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  usage?: {
    input?: number | undefined;
    output?: number | undefined;
    cachedInput?: number | undefined;
    cacheCreated?: number | undefined;
    inputIncludesCache?: boolean | undefined;
    scope?: 'turn' | 'last_request' | 'conversation' | undefined;
  };
}
export type ExternalItem = {
  attachments?: Attachment[];
  senderThreadId?: string;
  id: string;
  turnId: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice' | 'plan';
  text: string;
  complete?: boolean;
  images?: Array<{ data: string; mimeType: string }>;
  tool?: {
    name: string;
    input?: unknown;
    output?: unknown;
    status: 'running' | 'completed' | 'failed';
    path?: string | undefined;
    command?: string | undefined;
  };
};
export interface ExternalInteractionResponse {
  optionId?: string;
  answers?: Record<string, string[]>;
  text?: string;
  cancelled?: boolean;
  values?: Record<string, string | number | boolean | string[]>;
}
export interface ExternalInteractionField {
  id: string;
  label: string;
  description?: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect';
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean | string[];
  integer?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}
/** Shared normalized-form validation; invalid answers keep the interaction open. */
export function isExternalInteractionValueValid(field: ExternalInteractionField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    (!field.integer || Number.isSafeInteger(value)) &&
    (field.minimum === undefined || value >= field.minimum) &&
    (field.maximum === undefined || value <= field.maximum);
  if (field.type === 'multiselect') return Array.isArray(value) && new Set(value).size === value.length &&
    value.every((entry) => typeof entry === 'string' && field.options?.some((option) => option.value === entry)) &&
    (field.minItems === undefined || value.length >= field.minItems) &&
    (field.maxItems === undefined || value.length <= field.maxItems);
  return typeof value === 'string' &&
    (field.minLength === undefined || [...value].length >= field.minLength) &&
    (field.maxLength === undefined || [...value].length <= field.maxLength) &&
    (field.type !== 'select' || Boolean(field.options?.some((option) => option.value === value)));
}
export interface ExternalInteraction {
  id: string;
  turnId: string;
  kind: 'permission' | 'question';
  fields?: ExternalInteractionField[];
  title: string;
  detail?: string;
  options: Array<{ id: string; label: string }>;
  questions?: Array<{
    id: string;
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
}
/** Protocol-reported context occupancy, independent from billable token usage. */
export interface ExternalContextUsage {
  used: number;
  size: number;
}
export interface ExternalConnectionState {
  status: 'preparing' | 'connected' | 'disconnected' | 'reclaimed' | 'authentication_required' | 'failed';
  error?: string;
}
export interface ExternalConversationSnapshot {
  observationEpoch: string;
  observationRevision: number;
  conversation: ExternalConversation;
  turns: ExternalTurn[];
  items: ExternalItem[];
  previous?: number;
  connected: boolean;
  capabilities?: ExternalAgentCapabilities | undefined;
  capabilitiesSource?: 'live' | 'cached';
  connection?: ExternalConnectionState;
  contextUsage?: ExternalContextUsage;
  interactions: ExternalInteraction[];
}
export type ExternalObservationChange =
  | { kind: 'refresh' }
  | { kind: 'item'; item: ExternalItem }
  | { kind: 'text_delta'; id: string; turnId: string; text: string; complete?: boolean | undefined }
  | { kind: 'tool_delta'; id: string; turnId: string; field: 'input' | 'output'; text: string }
  | { kind: 'unavailable'; message: string };
export type ExternalObservation = { epoch: string; revision: number } & ExternalObservationChange;
export interface ExternalDelegation {
  messageKind?: 'inform' | 'request';
  operationId: string;
  conversationId: string;
  parentThreadId: string;
  parentBranchId: string;
  name: string;
  avatar?: string;
  harness: ExternalHarness;
  state: string;
  turnId?: string;
  reportReady: boolean;
  acceptedAtMs: number;
  finishedAtMs?: number;
}
export interface ExternalAgentsAPI {
  settings(signal?: AbortSignal): Promise<ExternalAgentSettings>;
  configure(
    value: Pick<ExternalAgentSettings, 'agents' | 'defaultAgent'>,
    expectedRevision: number,
    key: string,
  ): Promise<ExternalAgentSettings>;
  detect(id: string, signal?: AbortSignal): Promise<ExternalAgentDetection>;
  list(signal?: AbortSignal): Promise<ExternalConversation[]>;
  children(signal?: AbortSignal): Promise<ExternalDelegation[]>;
  childPresentation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ task: string; answer?: string; detail?: string }>;
  create(input: {
    key: string;
    configurationId: string;
    cwd?: string;
    title?: string;
  }): Promise<ExternalConversation>;
  read(id: string, before?: number, signal?: AbortSignal): Promise<ExternalConversationSnapshot>;
  send(id: string, key: string, input: ExternalInput): Promise<ExternalTurn>;
  uploadAttachment(id: string, request: { key: string; filename: string; mimeType: string; data: Blob }, signal?: AbortSignal): Promise<Attachment>;
  readAttachment(id: string, ref: string, signal?: AbortSignal): Promise<Blob>;
  connect(id: string, signal?: AbortSignal): Promise<ExternalAgentCapabilities>;
  authenticate(id: string, methodId: string): Promise<ExternalAgentCapabilities>;
  continueConversation(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  stop(id: string, turnId: string, force?: boolean): Promise<void>;
  respond(
    id: string,
    requestId: string,
    response: ExternalInteractionResponse,
  ): Promise<void>;
  update(
    id: string,
    expectedRevision: number,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ): Promise<ExternalConversation>;
  observe(id: string, listener: (event: ExternalObservation) => void, signal: AbortSignal): Promise<void>;
}

export class ExternalAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: { authentication?: ExternalAuthentication; [key: string]: unknown },
  ) {
    super(message);
  }
}

export function createExternalAgentsHttpAPI(generation = getRuntimeEndpointGeneration()): ExternalAgentsAPI {
  const request = async <T>(action: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    if (generation !== getRuntimeEndpointGeneration())
      throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
    const response = await runtimeFetch(`/api/external-agents/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new ExternalAgentError(
        result.code ?? 'external_agent_failed',
        result.error ?? 'External Agent request failed',
        response.status,
        result.details,
      );
    if (generation !== getRuntimeEndpointGeneration())
      throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
    return result as T;
  };
  return {
    settings: (signal) => request('settings', {}, signal),
    configure: (value, expectedRevision, key) => request('configure', { value, expectedRevision, key }),
    detect: (id, signal) => request('detect', { id }, signal),
    list: (signal) => request('list', {}, signal),
    children: (signal) => request('children', {}, signal),
    childPresentation: (operationId, signal) => request('child-presentation', { operationId }, signal),
    create: (input) => request('create', input),
    read: (id, before, signal) => request('read', { id, before }, signal),
    send: (id, key, input) =>
      request('send', {
        id,
        key,
        input: {
          text: input.text,
          ...(input.config === undefined ? {} : { config: input.config }),
          ...(input.images === undefined ? {} : { images: input.images }),
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          ...(input.attachmentImageReferences === undefined ? {} : { attachmentImageReferences: input.attachmentImageReferences }),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
        },
      }),
    async uploadAttachment(id, input, signal) {
      if (generation !== getRuntimeEndpointGeneration()) throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
      const response = await runtimeFetch('/api/external-agents/attachments/upload', {
        method: 'POST', query: { id, key: input.key, filename: input.filename, mimeType: input.mimeType, byteLength: String(input.data.size) },
        headers: { 'Content-Type': 'application/octet-stream' }, body: input.data, ...(signal ? { signal } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new ExternalAgentError(result.code ?? 'attachment_upload', result.error ?? 'File upload failed', response.status);
      if (generation !== getRuntimeEndpointGeneration()) throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
      return result as Attachment;
    },
    async readAttachment(id, ref, signal) {
      if (generation !== getRuntimeEndpointGeneration()) throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
      const response = await runtimeFetch('/api/external-agents/attachments/read', { query: { id, ref }, ...(signal ? { signal } : {}) });
      if (!response.ok) {
        const result = await response.json();
        throw new ExternalAgentError(result.code ?? 'attachment_read', result.error ?? 'File is unavailable', response.status);
      }
      const blob = await response.blob();
      if (generation !== getRuntimeEndpointGeneration()) throw new ExternalAgentError('host_changed', 'Application Host changed', 409);
      return blob;
    },
    connect: (id, signal) => request('connect', { id }, signal),
    authenticate: (id, methodId) => request('authenticate', { id, methodId }),
    continueConversation: (id) => request('continue', { id }),
    disconnect: (id) => request('disconnect', { id }),
    stop: (id, turnId, force) => request('stop', { id, turnId, ...(force ? { force } : {}) }),
    respond: (id, requestId, response) => request('respond', { id, requestId, response }),
    update: (id, expectedRevision, patch) => request('update', { id, expectedRevision, patch }),
    async observe(id, listener, signal) {
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const remove = subscribeRuntimeEndpointWillChange(abort);
      try {
        while (!controller.signal.aborted) {
          let response: Response | undefined;
          try {
            response = await runtimeFetch('/api/external-agents/observe', {
              query: { id },
              signal: controller.signal,
              headers: { Accept: 'text/event-stream' },
            });
            if (!response.ok || !response.body) throw new Error('External Agent observation is unavailable');
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            let buffer = '';
            try {
              for (;;) {
                const part = await reader.read();
                if (part.done) throw new Error('External Agent observation disconnected');
                buffer += decoder.decode(part.value, { stream: true });
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                  const frame = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary + 2);
                  const data = frame
                    .split('\n')
                    .filter((line) => line.startsWith('data: '))
                    .map((line) => line.slice(6))
                    .join('\n');
                  if (data) listener(JSON.parse(data) as ExternalObservation);
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } catch (error) {
            if (!controller.signal.aborted)
              listener({
                epoch: '',
                revision: 0,
                kind: 'unavailable',
                message: error instanceof Error ? error.message : String(error),
              });
          } finally {
            await response?.body?.cancel().catch(() => {});
          }
          if (!controller.signal.aborted)
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', finish);
                resolve();
              };
              const timer = setTimeout(finish, 1500);
              controller.signal.addEventListener('abort', finish, { once: true });
            });
        }
      } finally {
        controller.abort();
        remove();
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
