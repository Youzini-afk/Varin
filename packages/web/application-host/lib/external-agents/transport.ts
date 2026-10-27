import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { KernelManagedProcess } from '../kernel/process-service.js';

export type RecordValue = Record<string, unknown>;
export const clientInfo = { name: 'varin', title: 'Varin', version: String(createRequire(import.meta.url)('../../../package.json').version) };
export const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** LF-framed bytes preserve both split UTF-8 and Unicode separators inside JSON strings. */
export class HarnessTransport {
  private parts: Buffer[] = [];
  private bytes = 0;
  private pending = new Map<string, { resolve(value: RecordValue): void; reject(error: Error): void }>();
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
    void child.completion.then(() => child.release()).catch((error) => this.fail(error));
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
  request(method: string, params: RecordValue = {}): Promise<RecordValue> {
    if (this.failed) return Promise.reject(this.failed);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.send(
        this.protocol === 'pi' ? { ...params, type: method, id } : { jsonrpc: '2.0', id, method, params },
      ).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const work = Promise.resolve().then(async () => {
      this.fail(new Error('External Agent connection closed'));
      this.child.discardOutput();
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
    for (const waiter of this.pending.values()) waiter.reject(this.failed);
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
      id &&
      (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error') || message.type === 'response')
    ) {
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        if (message.error || message.success === false)
          waiter.reject(
            new Error(
              text(record(message.error).message) || text(message.error) || 'External Agent request failed',
            ),
          );
        else waiter.resolve(record(this.protocol === 'pi' ? message.data : message.result));
      }
      return;
    }
    if (id && typeof message.method === 'string') {
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
