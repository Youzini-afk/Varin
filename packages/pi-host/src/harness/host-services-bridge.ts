import { randomUUID } from "node:crypto";
import type {
  HarnessCancelData,
  HarnessError,
  HarnessMethod,
  HarnessRequestData,
  HarnessServiceMap,
  AgentInputContext,
} from "@varin/protocol";

interface PendingRequest {
  method: HarnessMethod;
  cleanup?: () => void;
  resolve: (value: unknown) => void;
  reject: (error: HarnessRequestError) => void;
  sessionId: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface HostServicesBridgeOptions {
  emit: (event: "harness.request", data: HarnessRequestData) => void;
  sessionId: string;
  defaultTimeoutMs?: number;
  getInputContext?: () => AgentInputContext;
}

export class HarnessRequestError extends Error {
  readonly code: HarnessError["code"];
  readonly retryable: boolean;
  constructor(code: HarnessError["code"], message: string, retryable: boolean = false) {
    super(message);
    this.name = "HarnessRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class HostServicesBridge {
  readonly #emit: (event: "harness.request" | "harness.cancel", data: HarnessRequestData | HarnessCancelData) => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessionId: string;
  readonly #defaultTimeoutMs: number;
  readonly #getInputContext: (() => AgentInputContext) | undefined;
  #disposed = false;

  constructor(options: HostServicesBridgeOptions) {
    this.#emit = options.emit as (event: "harness.request" | "harness.cancel", data: HarnessRequestData | HarnessCancelData) => void;
    this.#sessionId = options.sessionId;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#getInputContext = options.getInputContext;
  }

  /**
   * The input source accepted for the current turn. Surface-aware mutations
   * still ask Host `document.surfaceWrite`; in Varin production, disk-sourced
   * targets are applied by Host Documents through the Rust file-resource backend.
   */
  inputContext(): AgentInputContext | undefined {
    return this.#getInputContext?.();
  }

  cancel(data: HarnessCancelData): void {
    if (this.#disposed) return;
    this.#emitCancel(data);
  }

  wakeDependencyWaits(): void {
    for (const [requestId, pending] of this.#pending) if (pending.method === "thread.wait" || pending.method === "thread.send") this.#emitCancel({ requestId, wake: true });
  }

  request<M extends HarnessMethod>(
    method: M,
    params: HarnessServiceMap[M]["params"],
    options?: { timeoutMs?: number; signal?: AbortSignal; inputContext?: AgentInputContext },
  ): Promise<HarnessServiceMap[M]["result"]> {
    if (this.#disposed) {
      return Promise.reject(new HarnessRequestError("failed", "disposed"));
    }
    const requestId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;
    let resolveResponse!: (value: unknown) => void;
    let rejectResponse!: (error: HarnessRequestError) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    // A thread wait owns its dependency deadline; a send with a correlated
    // wait owns its reply deadline; an experiment wait owns its attempt
    // deadline the same way. Reacquiring a root slot afterwards is
    // cancellation/lifecycle-bound, not a second fixed timeout.
    // compaction.run is worker-lifecycle-bound like the other 0-timeout waits:
    // the parent may legitimately block on it for minutes while capacity waits.
    // Shell execution/observation owns its requested wait budget and returns
    // an accepted handle or output when that budget expires.
    const timer = (method.startsWith("lsp.") || method === "thread.dispatch" || method === "thread.wait" || method === "thread.send" || method === "experiment.wait" || method === "compaction.run" || method === "materials.read" || method === "shell.exec" || method === "shell.read" || method === "search.content" || method === "related.query" || method === "computer.installSoftware" || method === 'computer.access') && timeoutMs === 0 ? undefined : setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#emitCancel({ requestId });
      this.#pending.delete(requestId);
      pending.cleanup?.();
      pending.reject(new HarnessRequestError("timeout", `harness request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const pending: PendingRequest = {
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
      sessionId: this.#sessionId,
      timer,
    };
    this.#pending.set(requestId, pending);
    if (options?.signal?.aborted) {
      this.#emitCancel({ requestId });
      this.#cancel(requestId, new HarnessRequestError("failed", "aborted"));
      return response as Promise<HarnessServiceMap[M]["result"]>;
    }
    if (options?.signal) {
      const onAbort = (): void => {
        this.#emitCancel({ requestId });
        this.#cancel(requestId, new HarnessRequestError("failed", "aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      pending.cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    }
    try {
      const inputContext = options?.inputContext ?? this.#getInputContext?.();
      this.#emit("harness.request", {
        method,
        params,
        requestId,
        ...(inputContext ? { inputContext: structuredClone(inputContext) } : {}),
        // Carry the bridge timeout to the router so the service handler
        // can run for the same duration (e.g. thread.wait blocks up to
        // 240s — the router must not abort at its default 30s).
        ...(timeoutMs !== this.#defaultTimeoutMs ? { timeoutMs } : {}),
      });
    } catch (error) {
      this.#cancel(requestId, new HarnessRequestError("failed", error instanceof Error ? error.message : "emit failed"));
    }
    return response as Promise<HarnessServiceMap[M]["result"]>;
  }

  respond(
    sessionId: string,
    requestId: string,
    outcome:
      | { ok: true; result: unknown }
      | { ok: false; error: HarnessError },
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.#pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cleanup?.();
    if (outcome.ok) {
      pending.resolve(outcome.result);
    } else {
      pending.reject(new HarnessRequestError(
        outcome.error.code,
        outcome.error.message,
        outcome.error.retryable === true,
      ));
    }
    return true;
  }

  #cancel(requestId: string, error: HarnessRequestError): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cleanup?.();
    pending.reject(error);
  }

  #emitCancel(data: HarnessCancelData): void {
    try {
      this.#emit("harness.cancel", data);
    } catch {
      // Local completion still has to settle even when the transport is gone.
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [requestId, pending] of this.#pending) {
      this.#emitCancel({ requestId });
      if (pending.timer) clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new HarnessRequestError("failed", "disposed"));
    }
    this.#pending.clear();
  }
}
