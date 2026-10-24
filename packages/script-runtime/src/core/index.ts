import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import type { Domain } from "node:domain";
import { start, type REPLServer } from "node:repl";
import { PassThrough, Writable } from "node:stream";
import { formatWithOptions, inspect } from "node:util";
import type { Context } from "node:vm";
import type { NestedToolInput, NestedToolReceipt, IncomingMedia, OutputPart } from "@varin/protocol";

export interface ScriptError {
  message: string;
  code?: string;
  hint?: string;
  details?: unknown;
}

export interface CellEvaluation {
  cellId: string;
  script: string;
}

export interface CellResult<ErrorInfo extends ScriptError = ScriptError> {
  valueText?: string;
  error?: ErrorInfo;
}

export interface ReplInstallation<Input, Receipt> {
  context: Context;
  /** Always resolves the calling async scope, never the most recent cell. */
  invoke(input: Input): Promise<Receipt>;
  output(...values: unknown[]): void;
}

export interface NodeReplOptions<Input = NestedToolInput, Receipt = NestedToolReceipt, ErrorInfo extends ScriptError = ScriptError> {
  environmentId: string;
  invoke(cellId: string, input: Input): Promise<Receipt>;
  output(cellId: string, text: string): void;
  outputPart?(cellId: string, part: OutputPart<IncomingMedia>): void;
  /** Replaces the default tools namespace. print and console remain available. */
  install?(installation: ReplInstallation<Input, Receipt>): void;
  /** Adapter-owned error projection; Native defaults to message/code only. */
  serializeError?(error: unknown): ErrorInfo;
}

export interface NodeReplSession<ErrorInfo extends ScriptError = ScriptError> {
  readonly environmentId: string;
  evaluate(cell: CellEvaluation): Promise<CellResult<ErrorInfo>>;
  /** Permanently fences admission; does not stop JavaScript or external effects. */
  closeAdmission(): void;
}

interface CellScope {
  cellId: string;
  closed: boolean;
  finishing: boolean;
  pending: Set<Promise<unknown>>;
  finish(outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void;
}

const inspectOptions = {
  colors: false,
  depth: 6,
  maxArrayLength: null,
  maxStringLength: null,
  customInspect: false,
  getters: false,
} as const;

export function scriptError(error: unknown): ScriptError {
  // Errors from the REPL have a different realm and need not pass instanceof Error.
  if (error && typeof error === "object") {
    const details = error as { message?: unknown; code?: unknown; details?: unknown };
    if (typeof details.message === "string") {
      return { message: details.message, ...(typeof details.code === "string" ? { code: details.code } : {}),
        ...(details.details === undefined ? {} : { details: details.details }),
        ...(/^Identifier .+ has already been declared/.test(details.message) ? {
          code: typeof details.code === 'string' ? details.code : 'SCRIPT_BINDING_REDECLARED',
          hint: "Bindings persist in this environmentId. Reuse the existing variable by assignment, use a block { const temporary = ...; } for local values, or var for redeclarable bindings. The environment and prior output are retained.",
        } : {}) };
    }
  }
  return { message: String(error) };
}

function closedError(): Error {
  return Object.assign(new Error("Script cell admission is closed"), { code: "SCRIPT_CELL_CLOSED" });
}

/**
 * Node's own evaluator owns parsing, top-level await and persistent lexical state.
 * This is an execution context, not an OS sandbox or a process supervisor.
 */
export function createNodeReplSession<Input = NestedToolInput, Receipt = NestedToolReceipt, ErrorInfo extends ScriptError = ScriptError>(
  options: NodeReplOptions<Input, Receipt, ErrorInfo>,
): NodeReplSession<ErrorInfo> {
  const scopes = new AsyncLocalStorage<CellScope>();
  const serializeError = (error: unknown): ErrorInfo => {
    try {
      return options.serializeError ? options.serializeError(error) : scriptError(error) as ErrorInfo;
    } catch (failure) {
      // Projection is not execution authority. A failed adapter projection must
      // still release this cell, without inventing additional error facts.
      return scriptError(failure) as ErrorInfo;
    }
  };
  let admissionClosed = false;
  let active: CellScope | undefined;
  const input = new PassThrough();
  // Node's interactive prompts and domain diagnostics are not protocol output.
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const server = start({ input, output, terminal: false, useGlobal: false });

  const emit = (text: string): void => {
    const scope = scopes.getStore();
    if (scope && !scope.closed && !admissionClosed) options.output(scope.cellId, text);
  };
  const print = (...values: unknown[]): void => emit(formatWithOptions(inspectOptions, ...values));
  const consoleOutput = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        emit(chunk.toString("utf8").replace(/\n$/, ""));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  // Propagate output failures to the cell's normal evaluation path, not a global
  // unhandled Writable error. This listener runs in the originating async scope.
  consoleOutput.on("error", (error: Error) => scopes.getStore()?.finish({ ok: false, error }));
  server.context.console = new Console({
    stdout: consoleOutput, stderr: consoleOutput, inspectOptions, ignoreErrors: false,
  });
  server.context.print = print;

  const invoke = (value: Input): Promise<Receipt> => {
    const scope = scopes.getStore();
    if (!scope || scope.closed || admissionClosed) return Promise.reject(closedError());
    // Register before calling the transport so even synchronous reentrancy sees
    // the actual admitted call. Do not turn rejection into a fabricated receipt.
    let resolve!: (receipt: Receipt | PromiseLike<Receipt>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<Receipt>((yes, no) => { resolve = yes; reject = no; });
    scope.pending.add(pending);
    void pending.then(
      () => { scope.pending.delete(pending); },
      () => { scope.pending.delete(pending); },
    );
    try { resolve(options.invoke(scope.cellId, value)); } catch (error) { reject(error); }
    return pending;
  };
  if (options.install) options.install({ context: server.context, invoke, output: print });
  else {
    server.context.tools = { invoke };
    server.context.emitImage = (image: IncomingMedia): void => {
      const scope = scopes.getStore();
      if (!scope || scope.closed || admissionClosed) throw closedError();
      if (!options.outputPart) throw new Error("Typed output is unavailable in this evaluator");
      if (!image || typeof image !== "object" || typeof image.media_type !== "string" || !image.media_type.startsWith("image/")
        || typeof image.data_base64 !== "string" || !image.data_base64.length || Buffer.from(image.data_base64, "base64").toString("base64") !== image.data_base64) {
        throw new Error("emitImage requires inline image media_type and canonical data_base64");
      }
      // Hydrated nested media can be reused, but its producer cannot grant a CAS read or author this output's source.
      options.outputPart(scope.cellId, { kind: "media", media: { media_type: image.media_type, data_base64: image.data_base64 } });
    };
  }

  // The default evaluator reports thrown/rejected runtime errors to its domain,
  // while parser errors use the eval callback. Never attribute a late domain
  // error to mutable `active`: it belongs only to its original async scope.
  const domain = (server as REPLServer & { _domain: Domain })._domain;
  domain.on("error", (error: unknown) => scopes.getStore()?.finish({ ok: false, error }));

  return {
    environmentId: options.environmentId,
    evaluate(cell) {
      if (admissionClosed) return Promise.resolve({ error: serializeError(closedError()) });
      if (active) {
        return Promise.resolve({ error: serializeError(Object.assign(new Error("Script environment is already evaluating a cell"), { code: "SCRIPT_ENVIRONMENT_BUSY" })) });
      }
      return new Promise<CellResult<ErrorInfo>>((resolve) => {
        const scope: CellScope = {
          cellId: cell.cellId,
          closed: false,
          finishing: false,
          pending: new Set(),
          finish(outcome) {
            if (scope.finishing) return;
            scope.finishing = true;
            // Atomic admission close comes before rendering or awaiting drain.
            scope.closed = true;
            let result: CellResult<ErrorInfo>;
            try {
              result = !outcome.ok ? { error: serializeError(outcome.error) }
                : outcome.value === undefined ? {}
                  : { valueText: typeof outcome.value === "string" ? outcome.value : inspect(outcome.value, inspectOptions) };
            } catch (failure) {
              result = { error: serializeError(failure) };
            }
            void Promise.allSettled([...scope.pending]).then(() => {
              active = undefined;
              resolve(result);
            });
          },
        };
        active = scope;
        scopes.run(scope, () => {
          try {
            server.eval(`${cell.script}\n`, server.context, "script-cell", (error, value: unknown) => {
              if (error !== null) { scope.finish({ ok: false, error }); return; }
              // A plain result ends the cell synchronously. Deferring even this
              // branch would admit already-queued detached microtasks after eval.
              if (value !== null && (typeof value === "object" || typeof value === "function")
                && typeof (value as { then?: unknown }).then === "function") {
                void Promise.resolve(value).then(
                  (resolved) => scope.finish({ ok: true, value: resolved }),
                  (failure: unknown) => scope.finish({ ok: false, error: failure }),
                );
              } else scope.finish({ ok: true, value });
            });
          } catch (error) { scope.finish({ ok: false, error }); }
        });
      });
    },
    closeAdmission() {
      admissionClosed = true;
      if (active) active.closed = true;
      // The streams carry no script input. Closing them releases REPL machinery,
      // not timers, pending callbacks, subprocesses, or the evaluator process.
      server.close();
      input.destroy();
      output.destroy();
    },
  };
}
