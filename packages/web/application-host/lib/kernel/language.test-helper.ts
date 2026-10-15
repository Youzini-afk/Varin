import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ManagedPipedProcessHandle } from '../process/types.js';
import { attachContentLengthReader, writeContentLengthMessage } from '../run/content-length.js';

export interface LanguageTestFrame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/** Explicit in-memory process seam. Uses the real supervisor and framed JSON-RPC client. */
export function createControlledLanguagePeer(capabilities: Record<string, unknown> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames: LanguageTestFrame[] = [];
  const handlers = new Map<string, (frame: LanguageTestFrame) => unknown | Promise<unknown>>();
  const heldMethods = new Set<string>();
  const closed = deferred<void>();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, pid: 777_001, exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, killed: false, completion: closed.promise,
    kill() {
      if (child.killed) return true;
      child.killed = true;
      child.exitCode = 0;
      detach();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      stdin.end(); stdout.end(); stderr.end();
      closed.resolve();
      return true;
    },
  }) satisfies ManagedPipedProcessHandle;
  const reply = (frame: LanguageTestFrame, result: unknown) => {
    if (!child.killed) writeContentLengthMessage(stdout, { jsonrpc: '2.0', id: frame.id, result });
  };
  const detach = attachContentLengthReader(stdin, (value) => {
    const frame = value as LanguageTestFrame;
    frames.push(frame);
    if (frame.id === undefined || typeof frame.method !== 'string' || heldMethods.has(frame.method)) return;
    queueMicrotask(() => {
      if (frame.method === 'initialize') {
        reply(frame, { capabilities: { textDocumentSync: 1, definitionProvider: true,
          referencesProvider: true, diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
          ...capabilities } });
        return;
      }
      const handler = handlers.get(frame.method!);
      void Promise.resolve(handler ? handler(frame) : frame.method === 'textDocument/diagnostic'
        ? { kind: 'full', items: [] } : frame.method === 'shutdown' ? null : []).then(
        value => reply(frame, value),
        error => {
          if (!child.killed) writeContentLengthMessage(stdout, { jsonrpc: '2.0', id: frame.id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        },
      );
    });
  });
  return {
    child, frames, handlers, heldMethods, reply,
    notify(method: string, params: Record<string, unknown>) {
      writeContentLengthMessage(stdout, { jsonrpc: '2.0', method, params });
    },
    requests(method: string) { return frames.filter(frame => frame.method === method && frame.id !== undefined); },
    notifications(method: string) { return frames.filter(frame => frame.method === method && frame.id === undefined); },
  };
}

export const testRange = (line: number, start: number, end: number) => ({
  start: { line, character: start }, end: { line, character: end },
});
