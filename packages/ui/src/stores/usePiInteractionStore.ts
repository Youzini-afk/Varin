import type {
  ExtensionUiMethod,
  ExtensionUiRequest,
  JsonValue,
  ProjectTrustRequest,
  RuntimeEventEnvelope,
  RuntimeMethod,
  RuntimeMethodParams,
  RuntimeMethodResult,
  RuntimeWorkerRole,
  UserQuestionRequest,
} from '@varin/protocol';
import type { PiRuntimeClient } from '@varin/runtime-client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';

export interface PiProjectTrustPrompt extends ProjectTrustRequest {
  role: RuntimeWorkerRole;
  workerId: string;
}

export interface PiExtensionDialog extends ExtensionUiRequest {
  id: string;
  method: Extract<ExtensionUiMethod, 'question' | 'select' | 'confirm' | 'input' | 'editor' | 'custom'>;
}

export interface PiExtensionNotice {
  id: string;
  message: string;
  sessionId: string;
  type: 'info' | 'warning' | 'error';
}

export interface PiExtensionWidget {
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface PiWorkingIndicator {
  frames?: string[];
  intervalMs?: number;
}

export interface PiExtensionEditorText {
  revision: number;
  text: string;
}

export interface PiExtensionSessionUiState {
  editorText?: PiExtensionEditorText;
  hiddenThinkingLabel?: string;
  statuses: Record<string, string>;
  title?: string;
  widgets: Record<string, PiExtensionWidget>;
  workingIndicator?: PiWorkingIndicator;
  workingMessage?: string;
  workingVisible?: boolean;
}

export type PiInteractionRuntimeClient = Pick<PiRuntimeClient, 'request' | 'subscribe'>;

export interface PiInteractionRuntimeConnection {
  client: PiInteractionRuntimeClient;
  runtimeKey: string;
}

export interface PiInteractionStoreRuntime {
  connect(): Promise<PiInteractionRuntimeConnection>;
  currentKey(): string;
  subscribeChanged(listener: () => void): () => void;
}

export interface PiInteractionStoreState {
  connected: boolean;
  dialogs: PiExtensionDialog[];
  hiddenQuestions: Record<string, true>;
  questionPopupUntil: Record<string, number>;
  questionDrafts: Record<string, Record<string, string | boolean>>;
  lastError: string | null;
  notices: PiExtensionNotice[];
  responding: Record<string, true>;
  runtimeKey: string;
  sessions: Record<string, PiExtensionSessionUiState>;
  trustRequests: PiProjectTrustPrompt[];

  connect(): Promise<void>;
  dismissNotice(id: string): void;
  hideQuestion(id: string): void;
  showQuestion(id: string): void;
  setQuestionDraft(id: string, questionId: string, value: string | boolean): void;
  reset(): void;
  respondDialog(requestId: string, value?: JsonValue, cancelled?: boolean): Promise<boolean>;
  respondTrust(requestId: string, trusted: boolean, remember: boolean): Promise<boolean>;
}

export type PiInteractionStore = UseBoundStore<StoreApi<PiInteractionStoreState>>;

const DEFAULT_RUNTIME: PiInteractionStoreRuntime = {
  connect: getPiRuntimeConnection,
  currentKey: getRuntimeKey,
  subscribeChanged: subscribeRuntimeEndpointChanged,
};

const INTERACTIVE_METHODS = new Set<ExtensionUiMethod>([
  'question',
  'select',
  'confirm',
  'input',
  'editor',
  'custom',
]);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const initialFields = (runtimeKey: string): Pick<
  PiInteractionStoreState,
  | 'connected'
  | 'dialogs'
  | 'hiddenQuestions'
  | 'questionPopupUntil'
  | 'questionDrafts'
  | 'lastError'
  | 'notices'
  | 'responding'
  | 'runtimeKey'
  | 'sessions'
  | 'trustRequests'
> => ({
  connected: false,
  dialogs: [],
  hiddenQuestions: {},
  questionPopupUntil: {},
  questionDrafts: {},
  lastError: null,
  notices: [],
  responding: {},
  runtimeKey,
  sessions: {},
  trustRequests: [],
});

const asRecord = (value: JsonValue): Record<string, JsonValue> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
);

export const userQuestionRequest = (dialog: PiExtensionDialog): UserQuestionRequest | null => {
  if (dialog.method !== 'question') return null;
  const payload = asRecord(dialog.payload);
  if (payload?.id !== dialog.id || payload.sessionId !== dialog.sessionId || !Array.isArray(payload.questions)) return null;
  return payload as unknown as UserQuestionRequest;
};

const readString = (record: Record<string, JsonValue> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
};

const readBoolean = (record: Record<string, JsonValue> | undefined, key: string): boolean | undefined => {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
};

const emptySessionUi = (): PiExtensionSessionUiState => ({
  statuses: {},
  widgets: {},
});

const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

const withoutResponse = (responding: Record<string, true>, id: string): Record<string, true> => (
  withoutKey(responding, id)
);

export const piDialogResponseKey = (requestId: string): string => `dialog:${requestId}`;
export const piTrustResponseKey = (requestId: string): string => `trust:${requestId}`;

export const createPiInteractionStore = (
  runtime: PiInteractionStoreRuntime = DEFAULT_RUNTIME,
): PiInteractionStore => {
  let activeClient: PiInteractionRuntimeClient | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let editorRevision = 0;
  const workspaceSessionByWorker = new Map<string, string>();

  const store = create<PiInteractionStoreState>((set, get) => {
    const contextIsCurrent = (runtimeKey: string): boolean => (
      runtime.currentKey() === runtimeKey && get().runtimeKey === runtimeKey
    );

    const updateSession = (
      sessionId: string,
      update: (current: PiExtensionSessionUiState) => PiExtensionSessionUiState,
    ): void => {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: update(state.sessions[sessionId] ?? emptySessionUi()),
        },
      }));
    };

    const malformedPayload = (method: ExtensionUiMethod): void => {
      set({ lastError: `Malformed Pi extension UI payload for ${method}` });
    };

    const applyExtensionRequest = (
      envelope: RuntimeEventEnvelope<'extension.ui.request'>,
    ): void => {
      const request = envelope.data;
      if (INTERACTIVE_METHODS.has(request.method)) {
        if (!request.id) {
          malformedPayload(request.method);
          return;
        }
        const dialog = request as PiExtensionDialog;
        set((state) => ({
          dialogs: [
            ...state.dialogs.filter((candidate) => candidate.id !== dialog.id),
            dialog,
          ],
        }));
        return;
      }

      const payload = asRecord(request.payload);
      switch (request.method) {
        case 'notify': {
          const message = readString(payload, 'message');
          const rawType = readString(payload, 'type');
          if (message === undefined) {
            malformedPayload(request.method);
            return;
          }
          const type = rawType === 'warning' || rawType === 'error' ? rawType : 'info';
          set((state) => ({
            notices: [...state.notices, {
              id: `${state.runtimeKey}:${envelope.source.workerId}:${envelope.seq}`,
              message,
              sessionId: request.sessionId,
              type,
            }],
          }));
          return;
        }
        case 'setStatus': {
          const key = readString(payload, 'key');
          const text = payload?.text;
          if (key === undefined || (text !== null && typeof text !== 'string')) {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => ({
            ...current,
            statuses: text === null
              ? withoutKey(current.statuses, key)
              : { ...current.statuses, [key]: text },
          }));
          return;
        }
        case 'setWidget': {
          const key = readString(payload, 'key');
          const lines = payload?.lines;
          const rawPlacement = readString(payload, 'placement');
          if (
            key === undefined
            || (lines !== null && (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')))
          ) {
            malformedPayload(request.method);
            return;
          }
          const placement = rawPlacement === 'belowEditor' ? rawPlacement : 'aboveEditor';
          updateSession(request.sessionId, (current) => ({
            ...current,
            widgets: lines === null
              ? withoutKey(current.widgets, key)
              : { ...current.widgets, [key]: { lines: lines as string[], placement } },
          }));
          return;
        }
        case 'setTitle': {
          const title = readString(payload, 'title');
          if (title === undefined) {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => ({ ...current, title }));
          return;
        }
        case 'setEditorText': {
          const text = readString(payload, 'text');
          if (text === undefined) {
            malformedPayload(request.method);
            return;
          }
          editorRevision += 1;
          updateSession(request.sessionId, (current) => ({
            ...current,
            editorText: { revision: editorRevision, text },
          }));
          return;
        }
        case 'setWorkingMessage': {
          const message = payload?.message;
          if (message !== null && typeof message !== 'string') {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => {
            if (message !== null) return { ...current, workingMessage: message };
            const next = { ...current };
            delete next.workingMessage;
            return next;
          });
          return;
        }
        case 'setWorkingVisible': {
          const visible = readBoolean(payload, 'visible');
          if (visible === undefined) {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => ({ ...current, workingVisible: visible }));
          return;
        }
        case 'setWorkingIndicator': {
          if (request.payload === null) {
            updateSession(request.sessionId, (current) => {
              const next = { ...current };
              delete next.workingIndicator;
              return next;
            });
            return;
          }
          const indicator = asRecord(request.payload);
          const frames = indicator?.frames;
          const intervalMs = indicator?.intervalMs;
          if (
            !indicator
            || (frames !== undefined && (!Array.isArray(frames) || !frames.every((frame) => typeof frame === 'string')))
            || (intervalMs !== undefined && typeof intervalMs !== 'number')
          ) {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => ({
            ...current,
            workingIndicator: {
              ...(frames === undefined ? {} : { frames: frames as string[] }),
              ...(intervalMs === undefined ? {} : { intervalMs }),
            },
          }));
          return;
        }
        case 'setHiddenThinkingLabel': {
          const label = payload?.label;
          if (label !== null && typeof label !== 'string') {
            malformedPayload(request.method);
            return;
          }
          updateSession(request.sessionId, (current) => {
            if (label !== null) return { ...current, hiddenThinkingLabel: label };
            const next = { ...current };
            delete next.hiddenThinkingLabel;
            return next;
          });
          return;
        }
        default:
          return;
      }
    };

    const handleRuntimeEvent = (runtimeKey: string, envelope: RuntimeEventEnvelope): void => {
      if (!contextIsCurrent(runtimeKey)) return;
      switch (envelope.event) {
        case 'project.trust.request': {
          const prompt: PiProjectTrustPrompt = {
            ...envelope.data,
            role: envelope.source.role,
            workerId: envelope.source.workerId,
          };
          set((state) => ({
            trustRequests: [
              ...state.trustRequests.filter((candidate) => candidate.id !== prompt.id),
              prompt,
            ],
          }));
          return;
        }
        case 'extension.ui.request':
          applyExtensionRequest(envelope);
          return;
        case 'extension.ui.dismiss':
          set((state) => ({
            dialogs: state.dialogs.filter((dialog) => dialog.id !== envelope.data.requestId),
            responding: withoutResponse(
              state.responding,
              piDialogResponseKey(envelope.data.requestId),
            ),
          }));
          return;
        case 'session.snapshot': {
          if (envelope.data.questions) set((state) => ({ dialogs: [
            ...state.dialogs.filter(dialog => dialog.sessionId !== envelope.data.sessionId || dialog.method !== 'question'),
            ...envelope.data.questions!.map(question => ({ id: question.id, method: 'question' as const, sessionId: question.sessionId, payload: question as unknown as JsonValue })),
          ] }));
          if (envelope.source.role !== 'workspace') return;
          const previousSessionId = workspaceSessionByWorker.get(envelope.source.workerId);
          const nextSessionId = envelope.data.sessionId;
          workspaceSessionByWorker.set(envelope.source.workerId, nextSessionId);
          if (!previousSessionId || previousSessionId === nextSessionId) return;
          set((state) => ({
            dialogs: state.dialogs.filter((dialog) => dialog.sessionId !== previousSessionId || dialog.method === 'question'),
            sessions: withoutKey(state.sessions, previousSessionId),
          }));
          return;
        }
        case 'session.closed': {
          const { sessionId } = envelope.data;
          if (envelope.source.role === 'workspace') {
            workspaceSessionByWorker.delete(envelope.source.workerId);
          }
          set((state) => ({
            dialogs: state.dialogs.filter((dialog) => dialog.sessionId !== sessionId || dialog.method === 'question'),
            sessions: withoutKey(state.sessions, sessionId),
          }));
          return;
        }
        case 'session.worker.exited': {
          const { sessionId } = envelope.data;
          set((state) => ({
            dialogs: state.dialogs.filter((dialog) => dialog.sessionId !== sessionId || dialog.method === 'question'),
            responding: Object.fromEntries(Object.entries(state.responding).filter(([key]) => (
              !state.dialogs.some((dialog) => dialog.sessionId === sessionId && piDialogResponseKey(dialog.id) === key)
            ))),
            sessions: withoutKey(state.sessions, sessionId),
          }));
          return;
        }
        default:
          return;
      }
    };

    const connect = async (): Promise<PiInteractionRuntimeConnection> => {
      const expectedRuntimeKey = runtime.currentKey();
      const connection = await runtime.connect();
      if (connection.runtimeKey !== expectedRuntimeKey || !contextIsCurrent(expectedRuntimeKey)) {
        throw new Error('Pi runtime changed while connecting');
      }
      if (activeClient !== connection.client) {
        unsubscribeEvents?.();
        activeClient = connection.client;
        unsubscribeEvents = connection.client.subscribe((envelope) => {
          handleRuntimeEvent(connection.runtimeKey, envelope);
        });
      }
      set({ connected: true, lastError: null });
      return connection;
    };

    const request = async <M extends RuntimeMethod>(
      method: M,
      params: RuntimeMethodParams<M>,
    ): Promise<RuntimeMethodResult<M>> => {
      const expectedRuntimeKey = runtime.currentKey();
      try {
        const connection = await connect();
        const result = await connection.client.request(method, params);
        if (!contextIsCurrent(connection.runtimeKey)) {
          throw new Error(`Pi runtime changed during ${method}`);
        }
        return result;
      } catch (error) {
        if (contextIsCurrent(expectedRuntimeKey)) set({ lastError: errorMessage(error) });
        throw error;
      }
    };

    return {
      ...initialFields(runtime.currentKey()),

      connect: async () => {
        await connect();
      },

      dismissNotice: (id) => {
        set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
      },

      hideQuestion: (id) => set((state) => ({ hiddenQuestions: { ...state.hiddenQuestions, [id]: true } })),
      showQuestion: (id) => set((state) => {
        const dialog = state.dialogs.find(candidate => candidate.id === id && candidate.method === 'question');
        const question = dialog ? userQuestionRequest(dialog) : null;
        const now = Date.now();
        return {
          hiddenQuestions: { ...withoutKey(state.hiddenQuestions, id), ...Object.fromEntries(state.dialogs
            .filter(candidate => candidate.method === 'question' && candidate.id !== id).map(candidate => [candidate.id, true as const])) },
          questionPopupUntil: { ...state.questionPopupUntil, [id]: question?.waitingUntil && question.waitingUntil > now ? question.waitingUntil : now + 60_000 },
        };
      }),
      setQuestionDraft: (id, questionId, value) => set((state) => ({ questionDrafts: { ...state.questionDrafts, [id]: { ...state.questionDrafts[id], [questionId]: value } } })),

      reset: () => {
        workspaceSessionByWorker.clear();
        unsubscribeEvents?.();
        unsubscribeEvents = null;
        activeClient = null;
        set(initialFields(runtime.currentKey()));
      },

      respondDialog: async (requestId, value, cancelled = false) => {
        const responseRuntimeKey = get().runtimeKey;
        const dialog = get().dialogs.find((candidate) => candidate.id === requestId);
        const responseKey = piDialogResponseKey(requestId);
        if (!dialog || get().responding[responseKey]) return false;
        set((state) => ({ responding: { ...state.responding, [responseKey]: true } }));
        try {
          const result = await request('extension.ui.respond', {
            response: {
              ...(cancelled ? { cancelled: true } : {}),
              requestId,
              ...(value === undefined ? {} : { value }),
            },
            sessionId: dialog.sessionId,
          });
          set((state) => ({
            dialogs: state.dialogs.filter((candidate) => candidate.id !== requestId),
            hiddenQuestions: withoutKey(state.hiddenQuestions, requestId),
            questionPopupUntil: withoutKey(state.questionPopupUntil, requestId),
            questionDrafts: withoutKey(state.questionDrafts, requestId),
            lastError: null,
            responding: withoutResponse(state.responding, responseKey),
          }));
          return result.accepted;
        } catch (error) {
          set((state) => ({
            responding: withoutResponse(state.responding, responseKey),
            ...(dialog.method === 'question' && contextIsCurrent(responseRuntimeKey) ? {
              dialogs: [...state.dialogs.filter(candidate => candidate.id !== requestId), dialog],
            } : {}),
          }));
          throw error;
        }
      },

      respondTrust: async (requestId, trusted, remember) => {
        const prompt = get().trustRequests.find((candidate) => candidate.id === requestId);
        const responseKey = piTrustResponseKey(requestId);
        if (!prompt || get().responding[responseKey]) return false;
        set((state) => ({ responding: { ...state.responding, [responseKey]: true } }));
        try {
          const result = await request('project.trust.respond', {
            remember,
            requestId,
            trusted,
            workerId: prompt.workerId,
          });
          set((state) => ({
            lastError: null,
            responding: withoutResponse(state.responding, responseKey),
            trustRequests: state.trustRequests.filter((candidate) => candidate.id !== requestId),
          }));
          return result.accepted;
        } catch (error) {
          set((state) => ({ responding: withoutResponse(state.responding, responseKey) }));
          throw error;
        }
      },
    };
  });

  runtime.subscribeChanged(() => {
    store.getState().reset();
  });

  return store;
};

export const usePiInteractionStore = createPiInteractionStore();
