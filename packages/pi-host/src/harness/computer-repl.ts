import { Worker } from "node:worker_threads";
import { installComputerAppSdk } from './computer-app-sdk.js';

// Pi retains its Worker transport and SDK. Parsing, lexical state, async scopes
// and admitted-call drain belong to the shared evaluator, not this adapter.
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
// tsx/esbuild may retain function names in the serialized SDK function.
const __name = (fn, name) => Object.defineProperty(fn, 'name', { value: name, configurable: true });
const pending = new Map();
const logs = new Map();
let nextId = 0;
(async () => {
  const { createNodeReplSession, scriptError } = await import(workerData.evaluatorUrl);
  const session = createNodeReplSession({
    environmentId: workerData.environmentId,
    invoke: (cellId, input) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { cellId, resolve, reject });
      parentPort.postMessage({ type: 'call', runId: cellId, id, ...input });
    }),
    output: (cellId, text) => logs.get(cellId)?.push(text),
    serializeError: error => ({
      ...scriptError(error),
      ...(typeof error?.actionSent === 'boolean' ? { actionSent: error.actionSent } : {}),
      ...(typeof error?.retry === 'string' ? { retry: error.retry } : {}),
    }),
    install: ({ context, invoke, output }) => {
      const call = (method, args) => invoke({ method, args });
      context.computer = Object.fromEntries(['list','apps','observe','act','open','browser','office','evidence','cancel','release','access','request','grant','deny','releaseAssignment','emitImage'].map(method => [method, (...args) => call(method, args)]));
      context.sleep = context.computer.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      (${installComputerAppSdk.toString()})(context.computer, call, output);
    },
  });
  parentPort.on('message', async message => {
    if (message.type === 'close') { session.closeAdmission(); return; }
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request || request.cellId !== message.runId) return;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(Object.assign(new Error(message.error), message.errorDetails));
      else request.resolve(message.value);
      return;
    }
    if (message.type !== 'eval') return;
    const cellId = message.id;
    const entries = [];
    logs.set(cellId, entries);
    const result = await session.evaluate({ cellId, script: message.script });
    logs.delete(cellId);
    parentPort.postMessage({ type: 'result', id: cellId, logs: entries,
      ...(result.error ? { error: result.error.message, errorDetails: result.error }
        : result.valueText !== undefined && entries.at(-1) !== result.valueText ? { value: result.valueText } : {}) });
  });
})();
`;

interface WorkerGeneration {
  worker: Worker;
  closed: boolean;
  callbacks: Set<Promise<void>>;
  stopped?: Promise<void>;
  onStop?: (error: Error, stopped: Promise<void>) => void;
}

interface WorkerMessage {
  type: string;
  id: string | number;
  runId?: string;
  method?: string;
  args?: unknown[];
  logs?: string[];
  value?: string;
  error?: string;
  errorDetails?: { code?: string; actionSent?: boolean; retry?: string };
}

export class ComputerRepl {
  #generation: WorkerGeneration | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #stopping: Promise<void> = Promise.resolve();
  #nextId = 0;

  #stop(generation: WorkerGeneration, error: Error): Promise<void> {
    if (generation.stopped) return generation.stopped;
    // Fence dispatch before either asynchronous cleanup. Termination starts now,
    // even when an accepted Host callback is still waiting for its own result.
    generation.closed = true;
    if (this.#generation === generation) this.#generation = null;
    try { generation.worker.postMessage({ type: 'close' }); } catch { /* A lost worker must still be terminated and drained. */ }
    const termination = generation.worker.terminate();
    const callbacks = Promise.allSettled([...generation.callbacks]);
    const stopped = Promise.all([termination, callbacks]).then(() => undefined);
    generation.stopped = stopped;
    this.#stopping = Promise.all([this.#stopping, stopped]).then(() => undefined);
    // Lifecycle errors may arrive between runs, when there is no caller yet.
    void this.#stopping.catch(() => undefined);
    generation.onStop?.(error, stopped);
    return stopped;
  }

  run(script: string, call: (method: string, args: unknown[]) => Promise<unknown>, signal: AbortSignal,
    onStop?: (error: Error) => void): Promise<{ logs: string[]; value?: string }> {
    const task = this.#tail.catch(() => undefined).then(async () => {
      // A reset can replace the barrier while this queued cell is awaiting an
      // earlier one. Observe a stable barrier before creating the next worker.
      let stopping: Promise<void>;
      do { stopping = this.#stopping; await stopping; } while (stopping !== this.#stopping);
      signal.throwIfAborted();
      if (!this.#generation) {
        const worker = new Worker(SOURCE, {
          eval: true,
          execArgv: ['--experimental-repl-await'],
          workerData: { evaluatorUrl: import.meta.resolve('@varin/script-runtime'), environmentId: `pi-computer-${this.#nextId + 1}` },
        });
        const generation: WorkerGeneration = { worker, closed: false, callbacks: new Set() };
        this.#generation = generation;
        // Detached work can fail after a cell. Keep lifecycle listeners between
        // cells and never assign an old worker's event to a new generation.
        worker.on('error', error => { void this.#stop(generation, error); });
        worker.on('exit', () => { void this.#stop(generation, new Error('Computer REPL stopped; bindings were cleared')); });
      }
      const generation = this.#generation;
      const worker = generation.worker;
      const id = String(++this.#nextId);
      return new Promise<{ logs: string[]; value?: string }>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener('abort', abort);
          worker.off('message', message);
          delete generation.onStop;
        };
        generation.onStop = (error, stopped) => {
          cleanup();
          // Worker loss must cancel the original bridge waits before drain;
          // waiting for run's caller finally would deadlock an unbounded wait.
          onStop?.(error);
          void stopped.then(() => reject(error), reject);
        };
        const failed = (error: Error) => { void this.#stop(generation, error); };
        const abort = () => failed(signal.reason instanceof Error ? signal.reason : new Error('Computer evaluation cancelled; bindings were cleared'));
        const message = (event: WorkerMessage) => {
          if (generation.closed) return;
          if (event.type === 'call' && event.runId === id) {
            // Add before invoking the callback, including callbacks that can
            // synchronously initiate cancellation through their Host bridge.
            const callback = Promise.resolve().then(async () => {
              try {
                signal.throwIfAborted();
                if (generation.closed) return;
                const value = await call(event.method!, event.args!);
                if (!generation.closed && !signal.aborted) worker.postMessage({ type: 'response', runId: id, id: event.id, value });
              } catch (error) {
                const extra = error as { code?: string; actionSent?: boolean; retry?: string } | null | undefined;
                if (!generation.closed && !signal.aborted) worker.postMessage({ type: 'response', runId: id, id: event.id,
                  error: error instanceof Error ? error.message : String(error),
                  errorDetails: { code: extra?.code, actionSent: extra?.actionSent, retry: extra?.retry } });
              }
            }).catch(error => { failed(error instanceof Error ? error : new Error(String(error))); });
            generation.callbacks.add(callback);
            void callback.then(() => { generation.callbacks.delete(callback); });
          } else if (event.type === 'result' && event.id === id) {
            cleanup();
            worker.unref();
            if (event.error !== undefined) reject(Object.assign(new Error(event.error), event.errorDetails));
            else resolve({ logs: event.logs ?? [], ...(event.value !== undefined ? { value: event.value } : {}) });
          }
        };
        worker.ref();
        worker.on('message', message);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try { worker.postMessage({ type: 'eval', id, script }); }
        catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    this.#tail = task;
    return task;
  }

  reset(): Promise<void> {
    if (this.#generation) this.#stop(this.#generation, new Error('Computer REPL reset; bindings were cleared'));
    return this.#stopping;
  }
}
