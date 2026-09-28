import {
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  type HostHandshakeParams,
  type HostHandshakeResult,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeResponseEnvelope,
} from "@varin/protocol";
import type { RuntimeTransport } from "./transport.js";

interface PendingRequest {
  method: RuntimeMethod;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RuntimeSequenceGap {
  /** Sequence numbers of the filtered stream delivered to this surface. */
  expected: number;
  received: number;
  source: RuntimeEventEnvelope["source"];
}

export interface PiRuntimeClientOptions {
  createId?: () => string;
  /**
   * Fired when the transport closes without an explicit close() call. The
   * client is single-shot; supervision layers use this to schedule a new
   * connection and resynchronize authoritative state.
   */
  onConnectionLost?(error: Error | undefined): void;
  onProtocolError?(error: Error): void;
  onSequenceGap?(gap: RuntimeSequenceGap): void;
  requestTimeoutMs?: number | null;
  transport: RuntimeTransport;
}

export class PiRuntimeRequestError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(response: Extract<RuntimeResponseEnvelope, { ok: false }>) {
    super(response.error.message);
    this.name = "PiRuntimeRequestError";
    this.code = response.error.code;
    this.details = response.error.details;
    this.retryable = response.error.retryable === true;
  }
}

/** A sent request lost its transport before a response established the outcome. */
export class PiRuntimeAmbiguousRequestError extends Error {
  override readonly cause: Error;
  readonly method: RuntimeMethod;

  constructor(method: RuntimeMethod, cause: Error) {
    super(`Pi runtime connection was lost after ${method} was sent; the result is unknown`);
    this.name = "PiRuntimeAmbiguousRequestError";
    this.cause = cause;
    this.method = method;
  }
}

/** The request deadline elapsed without a response; the remote outcome is unknown. */
export class PiRuntimeRequestTimeoutError extends Error {
  readonly method: RuntimeMethod;

  constructor(method: RuntimeMethod) {
    super(`Pi runtime request timed out: ${method}`);
    this.name = "PiRuntimeRequestTimeoutError";
    this.method = method;
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

let fallbackId = 0;

const createFallbackId = (): string => {
  fallbackId += 1;
  return `runtime-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
};

export class PiRuntimeClient {
  readonly #createId: () => string;
  readonly #listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  #lastSurfaceSequence: number | undefined;
  readonly #options: PiRuntimeClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #timedOutRequests = new Set<string>();
  #closed = false;
  #connected = false;
  #connectPromise: Promise<void> | undefined;

  constructor(options: PiRuntimeClientOptions) {
    this.#options = options;
    this.#createId = options.createId ?? createFallbackId;
  }

  get connected(): boolean {
    return this.#connected && !this.#closed;
  }

  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Pi runtime client is closed"));
    this.#connectPromise ??= Promise.resolve(
      this.#options.transport.start({
        close: (error) => this.#handleClose(error),
        message: (frame) => this.#handleMessage(frame),
      }),
    ).then(() => {
      if (this.#closed) throw new Error("Pi runtime transport closed during startup");
      this.#connected = true;
    });
    return this.#connectPromise;
  }

  handshake(params: HostHandshakeParams): Promise<HostHandshakeResult> {
    return this.request("host.handshake", params);
  }

  async request<M extends RuntimeMethod>(
    method: M,
    params: RuntimeMethodParams<M>,
    timeoutMs: number | null = this.#options.requestTimeoutMs ?? null,
  ): Promise<RuntimeMethodResult<M>> {
    if (!this.connected) throw new Error("Pi runtime client is not connected");
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be positive");
    }
    const id = this.#createId();
    if (!id || this.#pending.has(id) || this.#timedOutRequests.has(id)) throw new Error("Runtime request IDs must be unique");
    const envelope = createRuntimeRequest(id, method, params);
    const result = new Promise<RuntimeMethodResult<M>>((resolve, reject) => {
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.#pending.delete(id);
            this.#timedOutRequests.add(id);
            reject(new PiRuntimeRequestTimeoutError(method));
          }, timeoutMs);
      this.#pending.set(id, {
        method,
        reject,
        resolve: (value) => resolve(value as RuntimeMethodResult<M>),
        timer,
      });
    });
    try {
      // Observe the response deadline even when the transport's async send is
      // stuck. Otherwise the result can time out while this method still waits
      // forever for send(), leaving the caller spinning (and a rejection unhandled).
      void Promise.resolve(this.#options.transport.send(encodeRuntimeEnvelope(envelope)))
        .catch((error: unknown) => this.#rejectPending(id, error));
    } catch (error) {
      this.#rejectPending(id, error);
    }
    return result;
  }

  subscribe(listener: (event: RuntimeEventEnvelope) => void): () => void {
    if (this.#closed) throw new Error("Pi runtime client is closed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#failPending(new Error("Pi runtime client is closed"));
    this.#listeners.clear();
    this.#lastSurfaceSequence = undefined;
    this.#timedOutRequests.clear();
    await this.#options.transport.close();
  }

  /** Retire an unresponsive transport without cancelling server execution.
   * Sent requests stay ambiguous, and the connection supervisor can replace
   * the socket. Never turn a health-check timeout into a mutation retry.
   */
  async invalidate(error: Error): Promise<void> {
    if (this.#closed) return;
    this.#handleClose(error);
    await this.#options.transport.close();
  }

  #handleMessage(frame: string): void {
    if (this.#closed) return;
    let envelope;
    try {
      envelope = decodeRuntimeEnvelope(frame);
    } catch (error) {
      this.#reportProtocolError(asError(error));
      return;
    }
    if (envelope.kind === "response") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) {
        // Deadlines end local observation, not server execution. Late replies
        // for known timed-out requests are expected, not corrupt event streams.
        if (this.#timedOutRequests.delete(envelope.id)) return;
        this.#reportProtocolError(new Error(`Unexpected runtime response: ${envelope.id}`));
        return;
      }
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.#pending.delete(envelope.id);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(new PiRuntimeRequestError(envelope));
      return;
    }
    if (envelope.kind !== "event") {
      this.#reportProtocolError(new Error("Runtime server sent a request to the client"));
      return;
    }
    // Raw worker sequences can skip legitimately when the surface filters an
    // unowned config watch or a privileged worker event. Only this delivered
    // surface stream has a contiguous sequence to check for missing frames.
    const previous = this.#lastSurfaceSequence;
    if (envelope.surfaceSeq !== undefined && previous !== undefined
      && envelope.surfaceSeq <= previous) return;
    if (envelope.surfaceSeq !== undefined && previous !== undefined
      && envelope.surfaceSeq !== previous + 1) {
      try {
        this.#options.onSequenceGap?.({
          expected: previous + 1,
          received: envelope.surfaceSeq,
          source: envelope.source,
        });
      } catch (error) {
        this.#reportProtocolError(asError(error));
      }
    }
    if (envelope.surfaceSeq !== undefined) this.#lastSurfaceSequence = envelope.surfaceSeq;
    for (const listener of this.#listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.#reportProtocolError(asError(error));
      }
    }
  }

  #handleClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#failPending(error ?? new Error("Pi runtime transport closed"), true);
    this.#listeners.clear();
    this.#timedOutRequests.clear();
    try {
      this.#options.onConnectionLost?.(error);
    } catch (callbackError) {
      this.#reportProtocolError(asError(callbackError));
    }
  }

  #rejectPending(id: string, error: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.reject(error);
  }

  #failPending(error: Error, ambiguous = false): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(ambiguous ? new PiRuntimeAmbiguousRequestError(pending.method, error) : error);
    }
    this.#pending.clear();
  }

  #reportProtocolError(error: Error): void {
    try {
      this.#options.onProtocolError?.(error);
    } catch {
      // Diagnostics must not destabilize request/event handling.
    }
  }
}
