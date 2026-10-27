import { runtimeFetch } from './transport/runtime-fetch.js';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from './transport/runtime-switch.js';

export type ExternalHarness = 'codex' | 'claude' | 'pi' | 'acp';
export interface ExternalAgentConfiguration {
  id: string;
  name: string;
  harness: ExternalHarness;
  enabled: boolean;
  command: string;
  args: string[];
}
export interface ExternalAgentSettings {
  revision: number;
  defaultAgent: string | null;
  agents: ExternalAgentConfiguration[];
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
  steering: boolean;
  models: ExternalAgentModel[];
  modelsError?: string | undefined;
  modes?: Array<{ id: string; name: string }>;
}
export interface ExternalConversation {
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
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  model?: string;
  thinking?: string;
  mode?: string;
}
export interface ExternalTurn {
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
export interface ExternalInteraction {
  id: string;
  turnId: string;
  kind: 'permission' | 'question';
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
export interface ExternalConversationSnapshot {
  observationEpoch: string;
  observationRevision: number;
  conversation: ExternalConversation;
  turns: ExternalTurn[];
  items: ExternalItem[];
  previous?: number;
  connected: boolean;
  capabilities?: ExternalAgentCapabilities | undefined;
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
    value: Omit<ExternalAgentSettings, 'revision'>,
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
  connect(id: string, signal?: AbortSignal): Promise<ExternalAgentCapabilities>;
  stop(id: string, turnId: string): Promise<void>;
  respond(
    id: string,
    requestId: string,
    response: { optionId?: string; answers?: Record<string, string[]>; text?: string },
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
          ...(input.images === undefined ? {} : { images: input.images }),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
        },
      }),
    connect: (id, signal) => request('connect', { id }, signal),
    stop: (id, turnId) => request('stop', { id, turnId }),
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
