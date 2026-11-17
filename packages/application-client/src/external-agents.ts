import type { ContentReferenceInput } from './content-reference.js';
import type { Attachment, AttachmentSelection } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from './transport/runtime-switch.js';

export type ExternalHarness = 'codex' | 'claude' | 'pi' | 'acp';
const waitForExternalReconnect = (signal: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, 1500);
  signal.addEventListener('abort', finish, { once: true });
  if (signal.aborted) finish();
});
/** Explicit Host defaults for new drafts, never a remembered last-used choice. */
export interface ExternalAgentDefaults {
  model?: string;
  thinking?: string;
  mode?: string;
}
export interface ExternalAgentConfiguration {
  id: string;
  /** A built-in launch recipe used by an additional named configuration. */
  profileId?: string;
  name: string;
  harness: ExternalHarness;
  enabled: boolean;
  /** Installation discovery intent; enabled remains the compatibility projection. */
  availability?: 'auto' | 'enabled' | 'disabled';
  command: string;
  args: string[];
  defaults?: ExternalAgentDefaults;
}
export interface ExternalAgentProfile {
  id: string;
  productId?: string;
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
  installation?: { kind: 'npm' | 'archive' | 'external'; packageName?: string; community?: boolean };
  /** Some upstream servers only expose their version in the protocol handshake. */
  versionProbe?: 'handshake';
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
  host?: { platform: string; architecture: string };
  detections?: ExternalAgentDetection[];
}
export interface ExternalAgentCapabilityCache {
  capabilities: ExternalAgentCapabilities;
  agentVersion?: string;
  cachedAt: number;
}
export interface ExternalAgentDetection {
  checkedAt?: number;
  id: string;
  status: 'available' | 'missing' | 'failed';
  executable?: string;
  version?: string;
  message?: string;
  code?: string;
  managed?: { version: string; directory: string };
}

export interface ExternalAgentInstallation {
  configurationId: string;
  operation: 'install' | 'check' | 'uninstall';
  status: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'resolving' | 'downloading' | 'installing' | 'checking' | 'activating' | 'removing';
  version?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  code?: string;
}
export interface ExternalAgentInstallations {
  revision: string;
  operations: ExternalAgentInstallation[];
}
export type ExternalAgentInstallationRequest =
  | { action: 'state' }
  | { action: 'watch'; after: string }
  | { action: 'install'; id: string; version?: string }
  | { action: 'check' | 'cancel' | 'uninstall'; id: string };
/** Installation, configuration intent and negotiated session facts are independent. */
export interface ExternalExecutorInspection {
  configurationId: string;
  name: string;
  harness: ExternalHarness;
  availability: 'auto' | 'enabled' | 'disabled';
  installation: { status: 'installed' | 'missing' | 'failed' | 'unknown'; checkedAt?: number; version?: string; message?: string };
  defaults: ExternalAgentDefaults;
  connection: 'connected' | 'not_connected';
  authentication: 'unknown';
  capabilitySource: 'connection' | 'cache' | 'unknown';
  capabilities?: ExternalAgentCapabilities;
  capabilitiesCheckedAt?: number;
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
  profileId?: string;
  harness: ExternalHarness;
  title: string;
  cwd: string;
  workspaceId?: string;
  executionSource?: import("@varin/protocol").LaunchSource;
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
export interface ExternalInput extends ContentReferenceInput {
  attachmentImageReferences?: Record<string, number>;
  attachments?: AttachmentSelection[];
  config?: Record<string, string>;
  text: string;
  images?: Array<{ data: string; mimeType: string; reference?: number }>;
  model?: string;
  thinking?: string;
  mode?: string;
}
/** Delivery intent is separate from the next turn's model and session options. */
export interface ExternalSendOptions {
  mode?: 'steer' | 'next_turn';
  /** Product turn identity captured when the user chose to supplement that turn. */
  expectedTurnId?: string;
}
export interface ExternalTurn {
  arrangementOccurrenceId?: string;
  arrangementLaunch?: Pick<ExternalAgentConfiguration, 'command' | 'args'>;
  arrangementHoldReason?: string;
  blockedReason?: string;
  consumedByTurnId?: string;
  steering?: {
    state: 'accepted' | 'dispatching' | 'appended' | 'queued' | 'handled' | 'rejected' | 'unknown';
    targetTurnId: string;
    error?: string;
  };
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
export type ExternalItem = ContentReferenceInput & {
  attachmentImageReferences?: Record<string, number>;
  attachments?: Attachment[];
  senderThreadId?: string;
  id: string;
  turnId: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice' | 'plan';
  text: string;
  complete?: boolean;
  images?: Array<{ data: string; mimeType: string; reference?: number }>;
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
  /** Original execution configuration, independent of the task name or role avatar. */
  configurationId?: string;
  profileId?: string;
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
  settings(signal?: AbortSignal, resourceOwner?: import('@varin/protocol').SourceResourceOwner): Promise<ExternalAgentSettings>;
  configure(
    value: Pick<ExternalAgentSettings, 'agents' | 'defaultAgent'>,
    expectedRevision: number,
    key: string,
    resourceOwner?: import('@varin/protocol').SourceResourceOwner,
  ): Promise<ExternalAgentSettings>;
  installations(input: ExternalAgentInstallationRequest, signal?: AbortSignal, resourceOwner?: import('@varin/protocol').SourceResourceOwner): Promise<ExternalAgentInstallations>;
  installationLog(id: string, signal?: AbortSignal, resourceOwner?: import('@varin/protocol').SourceResourceOwner): Promise<string>;
  observeInstallations(listener: (state: ExternalAgentInstallations) => void | Promise<void>, signal: AbortSignal,
    resourceOwner?: import('@varin/protocol').SourceResourceOwner, unavailable?: (error: unknown) => void): Promise<void>;
  detect(id: string, signal?: AbortSignal, resourceOwner?: import('@varin/protocol').SourceResourceOwner): Promise<ExternalAgentDetection>;
  list(signal?: AbortSignal): Promise<ExternalConversation[]>;
  children(signal?: AbortSignal): Promise<ExternalDelegation[]>;
  childPresentation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ task: string; answer?: string; detail?: string }>;
  create(input: {
    key: string;
    configurationId: string;
    source?: {resourceOwner: import('@varin/protocol').SourceResourceOwner;path:string;expectedWorkspaceId?:string};
    cwd?: string;
    title?: string;
    organization?: import('./conversation-organization.js').ConversationOrganizationPlacement;
  }): Promise<ExternalConversation>;
  read(id: string, before?: number, signal?: AbortSignal): Promise<ExternalConversationSnapshot>;
  send(id: string, key: string, input: ExternalInput, options?: ExternalSendOptions): Promise<ExternalTurn>;
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
    settings: (signal, resourceOwner) => request('settings', resourceOwner ? {resourceOwner} : {}, signal),
    configure: (value, expectedRevision, key, resourceOwner) => request('configure', { value, expectedRevision, key, ...(resourceOwner ? {resourceOwner} : {}) }),
    installations: (input, signal, resourceOwner) => request('installations', { input, ...(resourceOwner ? {resourceOwner} : {}) }, signal),
    installationLog: (id, signal, resourceOwner) => request('installation-log', { id, ...(resourceOwner ? {resourceOwner} : {}) }, signal),
    async observeInstallations(listener, signal, resourceOwner, unavailable) {
      let revision: string | undefined;
      while (!signal.aborted) {
        try {
          const snapshot = await request<ExternalAgentInstallations>('installations', {
            input: revision === undefined ? { action: 'state' } : { action: 'watch', after: revision },
            ...(resourceOwner ? { resourceOwner } : {}),
          }, signal);
          if (signal.aborted) return;
          await listener(snapshot);
          revision = snapshot.revision;
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ExternalAgentError && error.status < 500) throw error;
          unavailable?.(error);
          revision = undefined;
          await waitForExternalReconnect(signal);
        }
      }
    },
    detect: (id, signal, resourceOwner) => request('detect', { id, ...(resourceOwner ? { resourceOwner } : {}) }, signal),
    list: (signal) => request('list', {}, signal),
    children: (signal) => request('children', {}, signal),
    childPresentation: (operationId, signal) => request('child-presentation', { operationId }, signal),
    create: (input) => request('create', input),
    read: (id, before, signal) => request('read', { id, before }, signal),
    send: (id, key, input, options) =>
      request('send', {
        id,
        key,
        ...(options === undefined ? {} : { options }),
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
          if (!controller.signal.aborted) await waitForExternalReconnect(controller.signal);
        }
      } finally {
        controller.abort();
        remove();
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
