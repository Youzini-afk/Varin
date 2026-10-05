import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  Theme,
  WorkingIndicatorOptions,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiMethod,
  ExtensionUiRequest,
  ExtensionUiResponse,
  HostEvent,
  HostEventData,
  JsonValue,
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionRequest,
} from "@varin/protocol";
import { createDeferred, type Deferred } from "./deferred.js";
import { toJsonValue } from "./json.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

interface PendingRequest {
  abortHandler?: () => void;
  deferred: Deferred<JsonValue | undefined>;
  sessionId: string;
  timeout?: NodeJS.Timeout;
}

interface QuestionRecord {
  request: UserQuestionRequest;
  status: "pending" | "answered" | "cancelled";
  answers?: UserQuestionAnswer[];
  continueAfterAnswer?: boolean;
}

const QUESTION_RECORD = "varin.user-question";
type QuestionJournal = Pick<SessionManager, "getBranch" | "getSessionId" | "appendCustomEntry">;

function identity(text: string): string {
  return text;
}

const neutralTheme = {
  bg: (_color: unknown, text: string) => text,
  bold: identity,
  fg: (_color: unknown, text: string) => text,
  getBashModeBorderColor: () => identity,
  getBgAnsi: () => "",
  getColorMode: () => "dark",
  getFgAnsi: () => "",
  getThinkingBorderColor: () => identity,
  inverse: identity,
  italic: identity,
  name: "varin-neutral",
  strikethrough: identity,
  underline: identity,
} as unknown as Theme;

export class ExtensionUiBridge {
  readonly #emit: EventEmitter;
  readonly #getSessionId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  #editorText = "";
  #questionJournal: QuestionJournal | undefined;
  readonly #questions = new Map<string, QuestionRecord>();
  readonly #questionWaits = new Map<string, { resolve(record: QuestionRecord): void; cleanup(): void }>();

  constructor(emit: EventEmitter, getSessionId: () => string) {
    this.#emit = emit;
    this.#getSessionId = getSessionId;
  }

  /** Pi owns the retained question records; this bridge owns only live waits. */
  bindQuestions(journal: QuestionJournal): void {
    this.#questionJournal = journal;
    this.#questions.clear();
    for (const entry of journal.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== QUESTION_RECORD) continue;
      const record = entry.data as QuestionRecord | undefined;
      if (!record?.request?.id || record.request.sessionId !== journal.getSessionId()) continue;
      this.#questions.set(record.request.id, structuredClone(record));
    }
    for (const [id, record] of this.#questions) if (record.status === "pending" && record.request.waitingUntil !== undefined) {
      const { waitingUntil: _waitingUntil, ...request } = record.request;
      this.#saveQuestion({ ...record, request });
      this.#questions.set(id, { ...record, request });
    }
  }

  questionRequests(): UserQuestionRequest[] {
    return [...this.#questions.values()].filter(record => record.status === "pending").map(record => structuredClone(record.request));
  }

  #saveQuestion(record: QuestionRecord): void {
    this.#questionJournal?.appendCustomEntry(QUESTION_RECORD, record);
    this.#questions.set(record.request.id, record);
  }

  #publishQuestion(record: QuestionRecord): void {
    this.#emit("extension.ui.request", { id: record.request.id, method: "question", payload: toJsonValue(record.request), sessionId: record.request.sessionId });
  }

  postQuestion(id: string, questions: UserQuestion[], waitSeconds = 0, signal?: AbortSignal): { request: UserQuestionRequest; result: Promise<QuestionRecord> } {
    if (!this.#questionJournal) throw new Error("Question session is not bound");
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) throw new Error("wait_seconds must be between 0 and 600");
    const prior = this.#questions.get(id);
    if (prior) {
      if (JSON.stringify(prior.request.questions) !== JSON.stringify(questions)) throw new Error("Question identity is already bound to another question");
      return { request: prior.request, result: Promise.resolve(prior) };
    }
    signal?.throwIfAborted();
    const createdAt = Date.now();
    const record: QuestionRecord = { status: "pending", request: { id, sessionId: this.#questionJournal.getSessionId(), questions,
      createdAt, popupUntil: createdAt + (waitSeconds || 60) * 1000,
      ...(waitSeconds ? { waitingUntil: createdAt + waitSeconds * 1000 } : {}) } };
    this.#saveQuestion(record);
    if (!waitSeconds) {
      this.#publishQuestion(record);
      return { request: record.request, result: Promise.resolve(record) };
    }
    const deferred = createDeferred<QuestionRecord>();
    const finishWaiting = () => {
      const waiting = this.#questionWaits.get(id);
      if (!waiting) return;
      waiting.cleanup(); this.#questionWaits.delete(id);
      const current = this.#questions.get(id)!;
      const { waitingUntil: _waitingUntil, ...request } = current.request;
      const pending = { ...current, request };
      this.#saveQuestion(pending);
      this.#publishQuestion(pending);
      waiting.resolve(pending);
    };
    const timer = setTimeout(finishWaiting, waitSeconds * 1000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", finishWaiting); };
    this.#questionWaits.set(id, { resolve: deferred.resolve, cleanup });
    signal?.addEventListener("abort", finishWaiting, { once: true });
    this.#publishQuestion(record);
    return { request: record.request, result: deferred.promise };
  }

  respondWithContinuation(response: ExtensionUiResponse): { accepted: boolean; continuation?: { messageId: string; text: string } } {
    const current = this.#questions.get(response.requestId);
    if (!current) return { accepted: this.respond(response) };
    const values = response.cancelled ? [] : response.value;
    if (!Array.isArray(values) || (!response.cancelled && values.length !== current.request.questions.length)) throw new Error("The question response is incomplete");
    const answers = response.cancelled ? undefined : current.request.questions.map(question => {
      const answer = values.find(value => typeof value === "object" && value !== null && "id" in value && value.id === question.id) as unknown as UserQuestionAnswer | undefined;
      if (!answer || (question.type === "confirm" ? typeof answer.value !== "boolean" : typeof answer.value !== "string")) throw new Error("Invalid answer for question " + question.id);
      if (question.type === "select" && question.allowOther === false && !question.options?.some(option => option.value === answer.value)) throw new Error("Answer is outside the offered choices");
      return { id: question.id, type: question.type, value: answer.value };
    });
    const status = response.cancelled ? "cancelled" : "answered";
    if (current.status !== "pending" && (current.status !== status || JSON.stringify(current.answers) !== JSON.stringify(answers))) throw new Error("This question already has another response");
    const waiting = this.#questionWaits.get(response.requestId);
    const record = current.status === "pending" ? { ...current, status: status as QuestionRecord["status"], ...(answers ? { answers } : {}), continueAfterAnswer: !waiting && !response.cancelled } : current;
    if (current.status === "pending") this.#saveQuestion(record);
    waiting?.cleanup(); this.#questionWaits.delete(response.requestId); waiting?.resolve(record);
    this.#emit("extension.ui.dismiss", { requestId: response.requestId, sessionId: current.request.sessionId });
    return { accepted: true, ...(record.continueAfterAnswer ? { continuation: { messageId: "question-answer:" + response.requestId,
      text: "The user answered your question " + response.requestId + ":\n" + current.request.questions.map(question => question.question + "\nAnswer: " + String(record.answers?.find(answer => answer.id === question.id)?.value)).join("\n\n") } } : {}) };
  }

  createContext(): ExtensionUIContext {
    const custom: ExtensionUIContext["custom"] = async (factory, options) => {
      const inertUi = new Proxy({}, {
        get: () => () => {},
      });
      const resolvedOverlayOptions = typeof options?.overlayOptions === "function"
        ? options.overlayOptions()
        : options?.overlayOptions;
      const requestedWidth = resolvedOverlayOptions?.width;
      const width = typeof requestedWidth === "number" && Number.isFinite(requestedWidth) && requestedWidth > 0
        ? Math.round(requestedWidth)
        : 100;
      const component = await factory(
        inertUi as never,
        neutralTheme,
        inertUi as never,
        () => {},
      );
      try {
        const lines = component.render(width).map((line) => stripVTControlCharacters(line));
        await this.request(
          "custom",
          {
            lines,
            title: "Extension panel",
          },
          undefined,
          undefined,
        );
        return undefined as never;
      } finally {
        component.dispose?.();
      }
    };

    return {
      select: async (title, options, dialogOptions) => {
        const value = await this.request("select", { options, title }, dialogOptions, undefined);
        return typeof value === "string" ? value : undefined;
      },
      confirm: async (title, message, dialogOptions) => {
        const value = await this.request("confirm", { message, title }, dialogOptions, false);
        return value === true;
      },
      input: async (title, placeholder, dialogOptions) => {
        const value = await this.request(
          "input",
          { placeholder: placeholder ?? null, title },
          dialogOptions,
          undefined,
        );
        return typeof value === "string" ? value : undefined;
      },
      notify: (message, type) => {
        this.fire("notify", { message, type: type ?? "info" });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.fire("setStatus", { key, text: text ?? null });
      },
      setWorkingMessage: (message) => {
        this.fire("setWorkingMessage", { message: message ?? null });
      },
      setWorkingVisible: (visible) => {
        this.fire("setWorkingVisible", { visible });
      },
      setWorkingIndicator: (options?: WorkingIndicatorOptions) => {
        this.fire("setWorkingIndicator", toJsonValue(options ?? null));
      },
      setHiddenThinkingLabel: (label) => {
        this.fire("setHiddenThinkingLabel", { label: label ?? null });
      },
      setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
        if (content === undefined || Array.isArray(content)) {
          this.fire("setWidget", {
            key,
            lines: content ?? null,
            placement: options?.placement ?? "aboveEditor",
          });
        }
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => this.fire("setTitle", { title }),
      custom,
      pasteToEditor: (text) => {
        this.#editorText = text;
        this.fire("setEditorText", { text });
      },
      setEditorText: (text) => {
        this.#editorText = text;
        this.fire("setEditorText", { text });
      },
      getEditorText: () => this.#editorText,
      editor: async (title, prefill) => {
        const value = await this.request(
          "editor",
          { prefill: prefill ?? null, title },
          undefined,
          undefined,
        );
        return typeof value === "string" ? value : undefined;
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: neutralTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is owned by Varin" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    } as ExtensionUIContext;
  }

  async request(
    method: Extract<ExtensionUiMethod, "select" | "confirm" | "input" | "editor" | "custom">,
    payload: JsonValue,
    options?: ExtensionUIDialogOptions,
    fallback?: JsonValue,
  ): Promise<JsonValue | undefined> {
    const id = randomUUID();
    const sessionId = this.#getSessionId();
    const deferred = createDeferred<JsonValue | undefined>();
    const pending: PendingRequest = { deferred, sessionId };
    const cleanup = () => {
      if (pending.timeout) clearTimeout(pending.timeout);
      if (pending.abortHandler && options?.signal) {
        options.signal.removeEventListener("abort", pending.abortHandler);
      }
      this.#pending.delete(id);
    };
    pending.abortHandler = () => {
      cleanup();
      this.#emit("extension.ui.dismiss", { requestId: id, sessionId });
      deferred.resolve(fallback);
    };
    if (options?.signal?.aborted) return fallback;
    if (options?.signal) {
      options.signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    if (options?.timeout !== undefined && options.timeout > 0) {
      pending.timeout = setTimeout(pending.abortHandler, options.timeout);
    }
    this.#pending.set(id, pending);
    this.#emit("extension.ui.request", {
      id,
      method,
      ...(options?.timeout === undefined ? {} : { options: { timeout: options.timeout } }),
      payload,
      sessionId,
    });
    try {
      return await deferred.promise;
    } finally {
      cleanup();
    }
  }

  respond(response: ExtensionUiResponse): boolean {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return false;
    pending.deferred.resolve(response.cancelled ? undefined : response.value);
    return true;
  }

  cancelAll(): void {
    for (const [id, waiting] of this.#questionWaits) {
      waiting.cleanup();
      const record = this.#questions.get(id)!;
      const { waitingUntil: _waitingUntil, ...request } = record.request;
      const pending = { ...record, request };
      this.#saveQuestion(pending);
      this.#publishQuestion(pending);
      waiting.resolve(pending);
    }
    this.#questionWaits.clear();
    this.#questions.clear(); this.#questionJournal = undefined;
    for (const [requestId, pending] of this.#pending) {
      this.#emit("extension.ui.dismiss", { requestId, sessionId: pending.sessionId });
      pending.deferred.resolve(undefined);
    }
    this.#pending.clear();
  }

  setEditorState(text: string): void {
    this.#editorText = text;
  }

  fire(method: ExtensionUiMethod, payload: JsonValue): void {
    const request: ExtensionUiRequest = {
      method,
      payload: toJsonValue(payload),
      sessionId: this.#getSessionId(),
    };
    this.#emit("extension.ui.request", request);
  }
}
