import { createHash, randomUUID } from 'node:crypto';
import { BrowserExecutionError, type BrowserEvent, type BrowserOwner, type BrowserProviderStatus, type BrowserResourceCapability } from '@varin/protocol';

type Method = 'list' | 'open' | 'read' | 'act' | 'activate' | 'pause';
interface Command { id: string; sequence: number; method: Method; args: unknown[] }
interface Reply { id: string; ok: boolean; value?: unknown; error?: string; effect?: 'none' | 'unknown' }
export interface ConnectorExchange {
  browserId: string;
  instanceId: string;
  label: string;
  capabilities: string[];
  events?: BrowserEvent[];
  results?: Reply[];
  disconnected?: boolean;
}
interface Pending {
  command: Command;
  issued: boolean;
  resolve(value: unknown): void;
  reject(error: BrowserExecutionError): void;
}
const deadlineMs = 35_000;
const pollMs = 12_000;
const supports = (operations: string[], method: Method, args: unknown[]) => operations.includes(method) ||
  (method === 'act' && operations.includes(`act:${(args[1] as { action?: string } | undefined)?.action}`)) ||
  (method === 'read' && operations.includes(`read:${(args[0] as { view?: string } | undefined)?.view ?? 'overview'}`));
const fail = (message: string, issued = false, executorStopped = !issued) =>
  new BrowserExecutionError(message, issued ? 'unknown' : 'none', executorStopped);

export function connectorResourceId(clientId: string, browserId: string) {
  return `connector:${createHash('sha256').update(JSON.stringify([clientId, browserId])).digest('base64url')}`;
}

export class ConnectedBrowserOwner implements BrowserOwner {
  private current?: string;
  private sequence = 0;
  private operations: string[] = [];
  private online = false;
  private ended = new Set<string>();
  private timeout?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private wake?: () => void;
  pausePage?: (pageId: string, paused: boolean) => Promise<void>;
  constructor(readonly browserId: string) {}

  private emit(event: BrowserEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private interrupt(message: string) {
    clearTimeout(this.timeout);
    if (this.online) this.emit({ kind: 'connection', browserId: this.browserId, state: 'interrupted', ...(this.current ? { instanceId: this.current } : {}) });
    this.online = false;
    for (const pending of this.pending.values()) pending.reject(fail(message, pending.issued));
    this.pending.clear();
    this.wake?.();
  }
  async resource(): Promise<BrowserProviderStatus> {
    const capabilities: BrowserResourceCapability[] = [];
    if (this.operations.includes('list')) capabilities.push('tabs');
    for (const operation of ['open', 'read', 'act', 'activate'] as const) {
      if (this.operations.some(item => item === operation || item.startsWith(operation + ':'))) capabilities.push(operation);
    }
    if (this.operations.includes('read:screenshot')) capabilities.push('screenshot');
    return { state: this.online ? 'online' : this.current && this.ended.has(this.current) ? 'ended' : 'interrupted', ...(this.current ? { instanceId: this.current } : {}),
      capabilities, operations: [...this.operations] };
  }
  async exchange(input: ConnectorExchange, signal: AbortSignal): Promise<{ commands: Command[] }> {
    const announcing = !this.online || this.current !== input.instanceId;
    if (input.disconnected && (input.instanceId !== this.current || this.ended.has(input.instanceId))) return { commands: [] };
    if (this.ended.has(input.instanceId)) throw fail('This browser connection has already ended');
    if (this.current && this.current !== input.instanceId) {
      this.ended.add(this.current);
      this.interrupt('The original browser instance disconnected');
    }
    if (!this.online) {
      this.current = input.instanceId;
      this.online = true;
      this.emit({ kind: 'connection', browserId: this.browserId, instanceId: this.current, state: 'online' });
    }
    this.operations = [...new Set(input.capabilities)];
    if (this.operations.includes('pause')) this.pausePage = async (pageId, paused) => {
      if (await this.request<boolean>('pause', [pageId, paused]) !== true) throw fail('The browser did not confirm its page control state');
    };
    else delete this.pausePage;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.interrupt('Browser connector stopped responding; no dispatched action was retried'), deadlineMs);
    this.timeout.unref?.();
    for (const reply of input.results ?? []) {
      const pending = this.pending.get(reply.id);
      if (!pending?.issued) continue;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(fail(reply.error ?? 'The browser rejected the operation', reply.effect !== 'none', true));
    }
    for (const event of input.events ?? []) {
      if (event.kind === 'page') this.emit({ kind: 'page', page: { ...event.page, browserId: this.browserId, instanceId: input.instanceId } });
      else if (event.kind === 'closed' || event.kind === 'dialog' || event.kind === 'download') this.emit(event);
    }
    if (input.disconnected) {
      this.ended.add(input.instanceId);
      this.interrupt('The user disconnected the browser connector');
      return { commands: [] };
    }
    if (this.wake) this.wake();
    // Acknowledge announcements, events and receipts immediately. A page event
    // can precede its action receipt; holding that POST would prevent delivery
    // of the queued receipt until the idle poll expires.
    if (!announcing && !input.events?.length && !input.results?.length
      && ![...this.pending.values()].some(item => !item.issued) && !signal.aborted) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          if (this.wake === done) delete this.wake;
          resolve();
        };
        const timer = setTimeout(done, pollMs);
        this.wake = done;
        signal.addEventListener('abort', done, { once: true });
      });
    }
    if (!this.online || input.instanceId !== this.current || signal.aborted) return { commands: [] };
    const commands: Command[] = [];
    for (const pending of this.pending.values()) {
      if (!pending.issued && commands.length < 16) {
        pending.issued = true;
        commands.push(pending.command);
      }
    }
    return { commands };
  }
  private request<T>(method: Method, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(fail('Browser operation cancelled before dispatch'));
    if (!this.online) return Promise.reject(fail('The browser connector is offline'));
    if (!supports(this.operations, method, args)) return Promise.reject(fail('The connected browser does not support this operation'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      // Do not release the page lease on cancellation after dispatch. Keep
      // waiting for the owner to settle it (or the connection to interrupt).
      const abort = () => { if (!pending.issued) {
        this.pending.delete(id);
        pending.reject(fail('Browser operation cancelled before dispatch'));
      } };
      const pending: Pending = { command: { id, sequence: ++this.sequence, method, args }, issued: false,
        resolve: value => { cleanup(); resolve(value as T); },
        reject: error => { cleanup(); reject(error); } };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        pending.reject(fail('Browser operation did not return a receipt', pending.issued));
      }, deadlineMs);
      this.pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      this.wake?.();
    });
  }

  list: BrowserOwner['list'] = async () => (await this.request<Awaited<ReturnType<BrowserOwner['list']>>>('list', []))
    .map(page => ({ ...page, browserId: this.browserId }));
  open: BrowserOwner['open'] = async (input, scope) =>
    ({ ...await this.request<Awaited<ReturnType<BrowserOwner['open']>>>('open', [input], scope.signal), browserId: this.browserId });
  read: BrowserOwner['read'] = async (input, signal) => {
    const result = await this.request<Awaited<ReturnType<BrowserOwner['read']>>>('read', [input], signal);
    return { ...result, page: { ...result.page, browserId: this.browserId } };
  };
  act: BrowserOwner['act'] = async (pageId, action, signal) => {
    const result = await this.request<Awaited<ReturnType<BrowserOwner['act']>>>('act', [pageId, action], signal);
    return { ...result, page: { ...result.page, browserId: this.browserId } };
  };
  activate = (pageId: string) => this.request<void>('activate', [pageId]);
  async downloads(): Promise<never> { throw fail('Downloads are not available from this browser connection'); }
  async readDownload(): Promise<never> { throw fail('Downloads are not available from this browser connection'); }
  async releaseDownload() { throw fail('Downloads are not available from this browser connection'); }
  async upload(): Promise<never> { throw fail('Uploads are not available from this browser connection'); }
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  retainForThread() {}
  async releaseThread() {}
  async dispose() { this.interrupt('Browser connector owner stopped'); this.listeners.clear(); }
}
