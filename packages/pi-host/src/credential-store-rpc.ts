import { credentialValueResolver } from './credential-value-resolver.js';
/** Private parent/worker credential-store protocol. It is deliberately outside @varin/protocol. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { CredentialMutationIntent, HostCredentialAuthority } from './credential-authority.js';
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = (code: string): Error => Object.assign(new Error(code), { code });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export const isCredentialStoreResponse = (value: unknown): boolean => object(value) && value.kind === 'credential-store-response';
interface Response { kind: 'credential-store-response'; id: string; ok: boolean; result?: unknown; error?: { code: string } }
interface Lease { peer: string; beginId: string; decided: boolean; decision: ReturnType<typeof deferred<Credential | undefined>>; done: ReturnType<typeof deferred<Credential | undefined>> }
/** Lives in the Application Host. Only a verified child-process callback may invoke accept(). */
export class CredentialStoreServer {
  readonly #leases = new Map<string, Lease>();
  readonly #waiting = new Map<string, { peer: string; abort: AbortController }>();
  constructor(readonly authority: HostCredentialAuthority) {}
  detach(peer: string): void {
    for (const [id, entry] of this.#waiting) if (entry.peer === peer) { entry.abort.abort(); this.#waiting.delete(id); }
    for (const [id, lease] of this.#leases) if (lease.peer === peer && !lease.decided) {
      lease.decided = true; lease.decision.reject(failure('credential-worker-disconnected')); this.#leases.delete(id);
    }
  }
  accept(value: unknown, peer: string, send: (response: Response) => Promise<void>): boolean {
    if (!object(value) || value.kind !== 'credential-store-request') return false;
    if (typeof value.id !== 'string' || !value.id || typeof value.operation !== 'string') return true;
    void this.#handle(value, peer, send).catch(() => undefined);
    return true;
  }
  async #handle(value: RecordValue, peer: string, send: (response: Response) => Promise<void>): Promise<void> {
    const id = value.id as string;
    const respond = (result: unknown) => send({ kind: 'credential-store-response', id, ok: true, result });
    try {
      const operation = value.operation;
      if (operation === 'cancel') {
        if (typeof value.target !== 'string') throw failure('credential-request-invalid');
        const waiting = this.#waiting.get(`${peer}\0${value.target}`);
        if (waiting?.peer === peer) waiting.abort.abort();
        for (const lease of this.#leases.values()) if (lease.peer === peer && lease.beginId === value.target && !lease.decided) {
          lease.decided = true; lease.decision.reject(failure('credential-cancelled'));
        }
        return;
      }
      if (operation === 'commit' || operation === 'rollback') {
        const lease = typeof value.leaseId === 'string' ? this.#leases.get(value.leaseId) : undefined;
        if (!lease || lease.peer !== peer || lease.decided) throw failure('credential-lease-invalid');
        if (operation === 'commit' && value.credential !== null && (!object(value.credential) || !['api_key', 'oauth'].includes(String(value.credential.type)))) throw failure('credential-update-invalid');
        lease.decided = true;
        if (operation === 'rollback') { lease.decision.reject(failure('credential-update-rejected')); await lease.done.promise.catch(() => undefined); await respond(null); }
        else {
          lease.decision.resolve(value.credential === null ? undefined : value.credential as unknown as Credential);
          await respond((await lease.done.promise) ?? null);
        }
        return;
      }
      if (operation === 'list') { await respond(await this.authority.list()); return; }
      if (typeof value.providerId !== 'string' || !value.providerId) throw failure('credential-reference-invalid');
      const providerId = value.providerId;
      if (operation === 'read') { await respond((await this.authority.readRaw(providerId)) ?? null); return; }
      if (operation === 'delete') { await this.authority.delete(providerId); await respond(null); return; }
      if (operation !== 'begin' || !['refresh', 'replace'].includes(String(value.intent))) throw failure('credential-operation-invalid');
      const abort = new AbortController();
      this.#waiting.set(`${peer}\0${id}`, { peer, abort });
      const decision = deferred<Credential | undefined>();
      const done = deferred<Credential | undefined>();
      // Attach rejection handlers before a cancellation/disconnect can settle either promise.
      void decision.promise.catch(() => undefined); void done.promise.catch(() => undefined);
      const leaseId = randomUUID();
      const lease: Lease = { peer, beginId: id, decided: false, decision, done };
      const work = this.authority.modifyWithIntent(providerId, value.intent as CredentialMutationIntent, async current => {
        this.#leases.set(leaseId, lease);
        await respond({ leaseId, credential: current ?? null });
        // Caller cancellation only affects lock acquisition. A started rotating refresh commits
        // through this lease even after its original model-request waiter stops waiting.
        return decision.promise;
      }, { signal: abort.signal });
      work.then(done.resolve, done.reject).finally(() => { this.#waiting.delete(`${peer}\0${id}`); this.#leases.delete(leaseId); });
      await work;
    } catch {
      await send({ kind: 'credential-store-response', id, ok: false, error: { code: 'credential-owner-operation-failed' } });
    }
  }
}

interface Pending { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }
/** Proxy used only when the trusted Application Host explicitly enables the private authority. */
export class RemoteCredentialStore implements CredentialStore {
  readonly #pending = new Map<string, Pending>();
  readonly #intent = new AsyncLocalStorage<CredentialMutationIntent>();
  constructor() {
    if (!process.send || !process.connected) throw failure('credential-parent-channel-required');
    process.on('message', value => {
      if (!isCredentialStoreResponse(value)) return;
      const response = value as Response;
      if (typeof response.id !== 'string') return;
      const pending = this.#pending.get(response.id); if (!pending) return;
      this.#pending.delete(response.id); pending.cleanup();
      if (response.ok === true) pending.resolve(response.result);
      else pending.reject(failure('credential-owner-operation-failed'));
    });
    process.once('disconnect', () => { for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(failure('credential-parent-disconnected')); } this.#pending.clear(); });
  }
  refresh<T>(work: () => Promise<T>): Promise<T> { return this.#intent.run('refresh', work); }
  #request(operation: string, params: RecordValue, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(failure('credential-cancelled'));
    if (!process.send || !process.connected) return Promise.reject(failure('credential-parent-disconnected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { this.#pending.delete(id); signal?.removeEventListener('abort', abort);
        if (process.connected) process.send?.({ kind: 'credential-store-request', id: randomUUID(), operation: 'cancel', target: id }, () => undefined);
        reject(failure('credential-cancelled')); };
      this.#pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      process.send!({ kind: 'credential-store-request', id, operation, ...params }, error => {
        if (error) { const pending = this.#pending.get(id); this.#pending.delete(id); pending?.cleanup(); pending?.reject(failure('credential-parent-disconnected')); }
      });
      if (signal?.aborted) abort();
    });
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const value = (await this.#request('read', { providerId }, options?.signal) ?? undefined) as Credential | undefined;
    if (value?.type !== 'api_key' || value.key === undefined) return value;
    const resolver = await credentialValueResolver();
    const resolved = resolver.resolveConfigValue(value.key, value.env);
    const { key: _key, ...rest } = value;
    return resolved === undefined ? rest : { ...rest, key: resolved };
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> { return await this.#request('list', {}, options?.signal) as CredentialInfo[]; }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const lease = await this.#request('begin', { providerId, intent: this.#intent.getStore() ?? 'replace' }, options?.signal) as { leaseId: string; credential: Credential | null };
    try {
      const next = await fn(lease.credential ?? undefined);
      return (await this.#request('commit', { leaseId: lease.leaseId, credential: next ?? null }) ?? undefined) as Credential | undefined;
    } catch (error) {
      await this.#request('rollback', { leaseId: lease.leaseId }).catch(() => undefined);
      throw error;
    }
  }
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> { await this.#request('delete', { providerId }, options?.signal); }
}
