import { Worker } from "node:worker_threads";

// Node's own REPL parser supports persistent lexical bindings and top-level
// await. Running it in a worker lets cancellation also stop synchronous loops
// after an await; a Promise.race in the Pi process cannot do that.
const SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const { REPLServer } = require('node:repl');
const { PassThrough } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { inspect } = require('node:util');
const context = new AsyncLocalStorage();
const pending = new Map();
let nextId = 0;
const server = new REPLServer({ input: new PassThrough(), output: new PassThrough(), terminal: false });
const finish = (run, error, value) => {
  if (!run || run.closed) return;
  let result;
  try {
    result = error ? { error: error.message || String(error) }
      : { value: value === undefined ? undefined : typeof value === 'string' ? value : inspect(value, { depth: 6 }) };
  } catch (failure) { result = { error: failure.message || String(failure) }; }
  run.closed = true;
  parentPort.postMessage({ type: 'result', id: run.id, logs: run.logs, ...result });
};
// Node's default REPL evaluator routes thrown/rejected evaluations through
// its domain instead of invoking eval's callback. Consume that path as well;
// AsyncLocalStorage keeps a late error attached to its original evaluation.
server._domain.on('error', error => finish(context.getStore(), error));
const call = (method, args) => {
  const run = context.getStore();
  if (!run || run.closed) return Promise.reject(new Error('Computer evaluation has ended'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', runId: run.id, id, method, args });
  });
};
server.context.computer = Object.fromEntries(['list','apps','observe','act','cancel','release','emitImage'].map(method => [method, (...args) => call(method, args)]));
server.context.sleep = server.context.computer.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
server.context.console = Object.fromEntries(['log','warn','error'].map(method => [method, (...args) => {
  const run = context.getStore();
  if (run && !run.closed) run.logs.push(args.map(value => typeof value === 'string' ? value : inspect(value)).join(' '));
}]));
parentPort.on('message', message => {
  if (message.type === 'response') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
    return;
  }
  const run = { id: message.id, closed: false, logs: [] };
  context.run(run, () => server.eval(message.script + '\n', server.context, 'computer-repl', (error, value) => {
    finish(run, error, value);
  }));
});
`;

export class ComputerRepl {
  #worker: Worker | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #nextId = 0;

  run(script: string, call: (method: string, args: unknown[]) => Promise<unknown>, signal: AbortSignal): Promise<{ logs: string[]; value?: string }> {
    const task = this.#tail.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      if (!this.#worker) {
        const created = new Worker(SOURCE, { eval: true });
        this.#worker = created;
        // Detached script work can fail after the evaluation returned. Keep
        // a lifecycle listener even between calls so it cannot crash Pi.
        created.on("error", () => {
          if (this.#worker === created) this.#worker = null;
          void created.terminate();
        });
        created.on("exit", () => { if (this.#worker === created) this.#worker = null; });
      }
      const worker = this.#worker;
      const id = ++this.#nextId;
      return new Promise<{ logs: string[]; value?: string }>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", abort);
          worker.off("message", message);
          worker.off("error", failed);
          worker.off("exit", exited);
        };
        const failed = (error: Error) => { cleanup(); this.reset(); reject(error); };
        const exited = () => failed(new Error("Computer REPL stopped; bindings were cleared"));
        const abort = () => failed(signal.reason instanceof Error ? signal.reason : new Error("Computer evaluation cancelled; bindings were cleared"));
        const message = (event: { type: string; id: number; runId?: number; method?: string; args?: unknown[]; logs?: string[]; value?: string; error?: string }) => {
          if (event.type === "call" && event.runId === id) {
            void (async () => {
              try {
                signal.throwIfAborted();
                const value = await call(event.method!, event.args!);
                if (!signal.aborted) worker.postMessage({ type: "response", id: event.id, value });
              } catch (error) {
                if (!signal.aborted) worker.postMessage({ type: "response", id: event.id, error: error instanceof Error ? error.message : String(error) });
              }
            })();
          } else if (event.type === "result" && event.id === id) {
            cleanup();
            worker.unref();
            if (event.error) reject(new Error(event.error));
            else resolve({ logs: event.logs ?? [], ...(event.value !== undefined ? { value: event.value } : {}) });
          }
        };
        worker.ref();
        worker.on("message", message);
        worker.once("error", failed);
        worker.once("exit", exited);
        signal.addEventListener("abort", abort, { once: true });
        worker.postMessage({ type: "eval", id, script });
      });
    });
    this.#tail = task;
    return task;
  }

  reset(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate();
  }
}
