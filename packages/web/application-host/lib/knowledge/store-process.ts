import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isStoreResponse, isStoreNotification, restoreStoreError, type StoreChildMessage, type StoreNotification,
  type StoreRequest, type StoreResponse,
} from "./store-protocol.js";

interface Pending {
  request: StoreRequest;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
  cancelled: boolean;
  sent: boolean;
}
export interface StoreObserver {
  revision(value: string): void;
  notify(message: StoreNotification): void;
}

/** One lazily started storage process per Host module generation, shared by its
 * open knowledge stores. Only one IPC batch is in flight (transport backpressure).
 * Requests queued behind it can share a checkpoint; a rejected/unknown batch is
 * never automatically replayed. There is no in-main native fallback. */
export class KnowledgeStoreProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  #nextRequest = 0;
  #nextStore = 0;
  #ready = false;
  #ending = false;
  #failure: Error | null = null;
  #queue: Pending[] = [];
  #batch: Pending[] | null = null;
  #scheduled: ReturnType<typeof setImmediate> | null = null;
  #observers = new Map<number, StoreObserver>();
  #onEmpty: () => void;

  constructor(onEmpty: () => void = () => {}) {
    this.#onEmpty = onEmpty;
    const source = import.meta.url.endsWith(".ts");
    const entry = source ? new URL("./store-worker.ts", import.meta.url) : new URL("./store-worker.js", import.meta.url);
    // The packaged Host and addon are already staged outside app.asar. A Node
    // child must load that physical tree, not depend on Electron's ASAR loader.
    const physicalEntry = fileURLToPath(entry).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    const loader = source ? pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href : null;
    const forkOptions: ForkOptions & { windowsHide: boolean } = {
      execPath: process.execPath,
      execArgv: loader ? ["--import", loader] : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced", // Preserve Set, Date and undefined in the existing contract.
      // A native addon can fail before IPC is ready. Preserve the child's error
      // so release and installed-app logs identify the real cause of a disconnect.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
    };
    this.child = fork(physicalEntry, [], forkOptions);
    const bootstrapTimer = setTimeout(() => {
      this.#fail(new Error("Knowledge storage process did not initialize"));
      // Nothing is admitted before ready, so a bootstrap timeout cannot kill an
      // in-flight durable write. Active database operations have no such timer.
      this.child.kill();
    }, 30_000);
    bootstrapTimer.unref();
    this.exited = new Promise(resolve => {
      this.child.once("exit", (code, signal) => {
        clearTimeout(bootstrapTimer);
        if (!this.#ending) this.#fail(new Error(`Knowledge storage process exited (${signal ?? code}); outstanding write outcomes are unknown`));
        resolve();
      });
      this.child.once("error", (error) => {
        clearTimeout(bootstrapTimer);
        this.#fail(error);
        if (this.child.pid === undefined) resolve();
      });
    });
    this.child.once("disconnect", () => {
      if (!this.#ending) this.#fail(new Error("Knowledge storage IPC disconnected; outstanding write outcomes are unknown"));
    });
    this.child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || typeof (message as { type?: unknown }).type !== "string") {
        this.#fail(new Error("Invalid knowledge storage response"));
        return;
      }
      const response = message as StoreChildMessage;
      if (response.type === "ready") {
        if (response.version !== 1 || this.#ready) { this.#fail(new Error("Knowledge storage protocol mismatch")); return; }
        clearTimeout(bootstrapTimer);
        this.#ready = true;
        this.#pump();
      } else if (response.type === "results") {
        this.#accept(response.responses);
      } else if (isStoreNotification(response)) {
        const observer = this.#observers.get(response.storeId);
        if (response.type === "knowledge") observer?.revision(response.revision);
        try { observer?.notify(response); } catch { /* observational */ }
      } else this.#fail(new Error("Unknown knowledge storage response"));
    });
  }

  get failed(): boolean { return this.#failure !== null || this.#ending; }

  register(observer: StoreObserver): number {
    if (this.#failure) throw this.#failure;
    if (this.#ending) throw new Error("Knowledge storage process is closing");
    const id = ++this.#nextStore;
    this.#observers.set(id, observer);
    return id;
  }

  request(storeId: number, method: StoreRequest["method"], args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ending) return Promise.reject(new Error("Knowledge storage process is closing"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    // Snapshot arguments at admission so caller mutation cannot change a queued write.
    let cloned: unknown[];
    try { cloned = structuredClone(args); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        request: { id: ++this.#nextRequest, storeId, method, args: cloned },
        resolve, reject, cleanup: () => {}, cancelled: false, sent: false,
      };
      const abort = (): void => {
        if (pending.sent) return;
        pending.cancelled = true;
        pending.cleanup();
        reject(signal?.reason);
      };
      pending.cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.#queue.push(pending);
      this.child.ref();
      this.child.channel?.ref();
      this.#pump();
    });
  }

  async release(storeId: number): Promise<void> {
    this.#observers.delete(storeId);
    if (this.#observers.size > 0) return;
    this.#ending = true;
    this.#onEmpty();
    this.child.ref();
    this.child.channel?.ref();
    if (this.child.connected) this.child.disconnect();
    await this.exited; // Windows mmap lifetime ends before the final close resolves.
  }

  #pump(): void {
    if (!this.#ready || this.#batch || this.#scheduled || this.failed) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      if (this.failed) return;
      this.#queue = this.#queue.filter(item => !item.cancelled);
      if (this.#queue.length === 0) {
        this.child.unref();
        this.child.channel?.unref();
        return;
      }
      // A fairness/transport batch, not a data limit: excess requests remain queued.
      const batch = this.#queue.splice(0, 64);
      this.#batch = batch;
      for (const item of batch) { item.sent = true; item.cleanup(); }
      try {
        this.child.send({ type: "batch", requests: batch.map(item => item.request) }, (error: Error | null) => {
          if (error) this.#fail(new Error("Knowledge storage IPC send failed; write outcomes may be unknown", { cause: error }));
        });
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error("Knowledge storage IPC send failed"));
      }
    });
  }

  #accept(responses: StoreResponse[]): void {
    const batch = this.#batch;
    if (!batch || !Array.isArray(responses) || !responses.every(isStoreResponse) || responses.length !== batch.length) {
      this.#fail(new Error("Incomplete knowledge storage batch response"));
      return;
    }
    const byId = new Map(responses.map(response => [response.id, response]));
    if (byId.size !== batch.length || batch.some(item => !byId.has(item.request.id))) {
      this.#fail(new Error("Mismatched knowledge storage response IDs"));
      return;
    }
    this.#batch = null;
    for (const item of batch) {
      const response = byId.get(item.request.id)!;
      if (response.revision !== undefined) this.#observers.get(item.request.storeId)?.revision(response.revision);
      if (response.ok) item.resolve(response.value);
      else item.reject(restoreStoreError(response.error));
    }
    this.#pump();
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    if (this.#scheduled) clearImmediate(this.#scheduled);
    this.#scheduled = null;
    for (const item of [...(this.#batch ?? []), ...this.#queue]) {
      item.cleanup();
      if (!item.cancelled) item.reject(error);
    }
    this.#batch = null;
    this.#queue = [];
    this.#onEmpty();
    // Closing the private pipe lets the child drain its admitted work and exit.
    // Never kill an active writer merely because the parent rejected a request.
    if (this.child.connected) this.child.disconnect();
  }
}

let shared: KnowledgeStoreProcess | null = null;
export function knowledgeStoreProcess(): KnowledgeStoreProcess {
  if (!shared || shared.failed) {
    const owner = new KnowledgeStoreProcess(() => { if (shared === owner) shared = null; });
    shared = owner;
  }
  return shared;
}
