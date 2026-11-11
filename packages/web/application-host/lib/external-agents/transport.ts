import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { KernelManagedProcess } from '../kernel/process-service.js';

export type RecordValue = Record<string, unknown>;
export const clientInfo = { name: 'varin', title: 'Varin', version: String(createRequire(import.meta.url)('../../../package.json').version) };
export const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Protocol errors retain machine-readable codes without logging payloads or credentials. */
export class HarnessProtocolError extends Error {
  constructor(readonly method: string, readonly code: number | string | undefined, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'HarnessProtocolError';
  }
}
export interface HarnessRequestOptions { signal?: AbortSignal; timeoutMs?: number }

/** LF-framed bytes preserve both split UTF-8 and Unicode separators inside JSON strings. */
export class HarnessTransport {
  private parts: Buffer[] = [];
  private bytes = 0;
  private pending = new Map<string, { method: string; resolve(value: RecordValue): void; reject(error: Error): void; cleanup(): void }>();
  private failed?: Error;
  private listeners = new Set<(message: RecordValue) => void>();
  private exits = new Set<(error: Error) => void>();
  private requestHandler?: (message: RecordValue) => Promise<unknown>;
  private closing: Promise<void> | undefined;
  get disconnected() {
    return Boolean(this.failed);
  }
  constructor(
    readonly child: KernelManagedProcess,
    private readonly protocol: 'rpc' | 'pi' = 'rpc',
    private readonly closeOwner?: () => Promise<void>,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.resume();
    child.on('error', (error) => this.fail(error));
    child.stdout.once('end', () =>
      this.fail(
        new Error(
          this.bytes
            ? 'External Agent closed with an incomplete protocol message'
            : 'External Agent connection closed',
        ),
      ),
    );
    void child.completion.then(() => this.closeOwner ? this.closeOwner() : child.release()).catch((error) => this.fail(error));
  }
  onMessage(listener: (message: RecordValue) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onExit(listener: (error: Error) => void): () => void {
    this.exits.add(listener);
    if (this.failed) queueMicrotask(() => listener(this.failed!));
    return () => {
      this.exits.delete(listener);
    };
  }
  onRequest(handler: (message: RecordValue) => Promise<unknown>) {
    this.requestHandler = handler;
  }
  async send(value: unknown): Promise<void> {
    if (this.failed) throw this.failed;
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve())),
    );
  }
  request(method: string, params: RecordValue = {}, options: HarnessRequestOptions = {}): Promise<RecordValue> {
    if (this.failed) return Promise.reject(this.failed);
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('External request cancelled'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const cancel = (error: Error) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        // An abandoned response is not evidence that the native operation was cancelled.
        reject(error);
      };
      const abort = () => cancel(options.signal?.reason instanceof Error ? options.signal.reason : new Error('External request cancelled'));
      this.pending.set(id, { method, resolve, reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          cancel(new Error('External request timeout must be positive'));
          return;
        }
        timer = setTimeout(() => cancel(new HarnessProtocolError(method, 'request_timeout', `${method} did not acknowledge before the control deadline`)), options.timeoutMs);
      }
      void this.send(
        this.protocol === 'pi' ? { ...params, type: method, id } : { jsonrpc: '2.0', id, method, params },
      ).catch((error) => cancel(error instanceof Error ? error : new Error(String(error))));
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const work = Promise.resolve().then(async () => {
      this.fail(new Error('External Agent connection closed'));
      this.child.discardOutput();
      if(this.closeOwner){await this.closeOwner();return;}
      if (!this.child.exitConfirmed) await this.child.requestTermination(true);
      await this.child.completion;
      await this.child.release();
    });
    this.closing = work;
    void work.catch(() => {
      if (this.closing === work) this.closing = undefined;
    });
    return work;
  }
  private fail(value: unknown) {
    if (this.failed) return;
    this.failed = value instanceof Error ? value : new Error(String(value));
    for (const waiter of this.pending.values()) { waiter.cleanup(); waiter.reject(this.failed); }
    this.pending.clear();
    for (const listener of this.exits) listener(this.failed);
  }
  private consume(chunk: Buffer) {
    if (this.failed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.parts.push(part);
      this.bytes += part.length;
      if (newline < 0) break;
      const line = Buffer.concat(this.parts, this.bytes).toString('utf8');
      this.parts = [];
      this.bytes = 0;
      start = newline + 1;
      if (!line.trim()) continue;
      try {
        this.receive(record(JSON.parse(line)));
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }
  private receive(message: RecordValue) {
    const id = message.id === undefined ? undefined : String(message.id);
    if (
      id !== undefined &&
      (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error') || message.type === 'response')
    ) {
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        waiter.cleanup();
        if (message.error || message.success === false)
          waiter.reject(
            new HarnessProtocolError(
              waiter.method,
              typeof record(message.error).code === 'number' || typeof record(message.error).code === 'string'
                ? record(message.error).code as number | string : undefined,
              text(record(message.error).message) || text(message.error) || 'External Agent request failed',
              record(message.error).data,
            ),
          );
        else waiter.resolve(record(this.protocol === 'pi' ? message.data : message.result));
      }
      return;
    }
    if (this.protocol === 'rpc' && id !== undefined && typeof message.method === 'string') {
      const handler = this.requestHandler;
      void (
        handler
          ? handler(message)
          : Promise.reject(new Error(`Unsupported Agent callback: ${message.method}`))
      )
        .then(
          (result) => this.send({ jsonrpc: '2.0', id: message.id, result }),
          (error) =>
            this.send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
            }),
        )
        .catch((error) => this.fail(error));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
}
