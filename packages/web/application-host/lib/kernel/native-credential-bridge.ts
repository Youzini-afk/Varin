import { waitWithSignal } from '../cancellation.js';
/** Private Host/kernel rendezvous. Secret replies bypass public RPC, event buses and histories. */
import { ExistingHostCredentialOwner, NativeCredentialOwnerError, type NativeCredentialScope, type NativeCredentialDispatch } from './native-credential-owner.js';
export interface PrivateCredentialResponse {
  v: 1; kind: 'credential-response'; id: string; kernelEpoch: string; ok: boolean;
  result?: { scope: NativeCredentialScope; headers: { name: string; value: string }[] };
  error?: { code: string; message: string };
}
interface Request { v: 1; kind: 'credential-request'; id: string; kernelEpoch: string; runId: string; scope: NativeCredentialScope; dispatch?: NativeCredentialDispatch | null }
interface OwnerEntry { owner: ExistingHostCredentialOwner; scope: NativeCredentialScope; epoch: string; abort: AbortController; active: Set<string> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const scopeValid = (value: unknown): value is NativeCredentialScope => record(value)
  && ['reference', 'authority', 'account'].every(key => typeof value[key] === 'string' && Boolean(value[key]))
  && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0;
const same = (left: NativeCredentialScope, right: NativeCredentialScope) => left.reference === right.reference
  && left.authority === right.authority && left.account === right.account && left.generation === right.generation;
export class NativeCredentialBridge {
  readonly #owners = new Map<string, OwnerEntry>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateCredentialResponse) => Promise<void>,
    private readonly transportFailed: () => void) {}
  async register(runId: string, owner: ExistingHostCredentialOwner, signal?: AbortSignal): Promise<NativeCredentialScope> {
    const epoch = this.currentEpoch();
    if (!epoch || !runId || this.#owners.has(runId)) throw new NativeCredentialOwnerError('credential-owner-registration-invalid');
    const scope = await waitWithSignal(owner.scope(), signal);
    signal?.throwIfAborted();
    if (this.currentEpoch() !== epoch || this.#owners.has(runId)) throw new NativeCredentialOwnerError('credential-owner-registration-stale');
    this.#owners.set(runId, { owner, scope, epoch, abort: new AbortController(), active: new Set() });
    return { ...scope };
  }
  unregister(runId: string): void {
    const entry = this.#owners.get(runId);
    if (entry) { this.#owners.delete(runId); entry.abort.abort(); }
  }
  close(): void { for (const runId of this.#owners.keys()) this.unregister(runId); }
  /** True for this private kind, even if invalid: never pass it to public protocol consumers. */
  consume(value: unknown): boolean {
    if (!record(value) || value.kind !== 'credential-request') return false;
    if (value.v !== 1 || typeof value.id !== 'string' || !value.id
      || typeof value.kernelEpoch !== 'string' || value.kernelEpoch !== this.currentEpoch()
      || typeof value.runId !== 'string' || !value.runId || !scopeValid(value.scope)
      || Object.keys(value).some(key => !['v', 'kind', 'id', 'kernelEpoch', 'runId', 'scope', 'dispatch'].includes(key))) return true;
    if (value.dispatch !== undefined && value.dispatch !== null && (!record(value.dispatch)
      || value.dispatch.method !== 'POST' || typeof value.dispatch.endpoint !== 'string'
      || typeof value.dispatch.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.dispatch.payloadSha256)
      || Object.keys(value.dispatch).some(key => !['method', 'endpoint', 'payloadSha256'].includes(key)))) return true;
    const request = value as unknown as Request;
    const entry = this.#owners.get(request.runId);
    if (!entry || entry.epoch !== request.kernelEpoch || !same(entry.scope, request.scope)) {
      void this.#reject(request, 'credential-owner-unavailable');
      return true;
    }
    if (entry.active.has(request.id)) return true;
    entry.active.add(request.id);
    void this.#resolve(request, entry);
    return true;
  }
  async #reject(request: Request, code: string): Promise<void> {
    if (request.kernelEpoch !== this.currentEpoch()) return;
    try { await this.send({ v: 1, kind: 'credential-response', id: request.id, kernelEpoch: request.kernelEpoch,
      ok: false, error: { code, message: code } }); }
    catch { this.transportFailed(); }
  }
  async #resolve(request: Request, entry: OwnerEntry): Promise<void> {
    try {
      const result = await entry.owner.resolve(entry.scope, entry.abort.signal, request.dispatch ?? undefined);
      if (this.currentEpoch() !== request.kernelEpoch || this.#owners.get(request.runId) !== entry || entry.abort.signal.aborted) return;
      if (!same(result.scope, entry.scope)) { await this.#reject(request, 'credential-scope-changed'); return; }
      await this.send({ v: 1, kind: 'credential-response', id: request.id, kernelEpoch: request.kernelEpoch, ok: true,
        result: { scope: result.scope, headers: Object.entries(result.headers).map(([name, value]) => ({ name, value })) } });
    } catch {
      if (this.currentEpoch() === request.kernelEpoch && this.#owners.get(request.runId) === entry && !entry.abort.signal.aborted) {
        await this.#reject(request, 'credential-resolution-failed');
      }
    } finally { entry.active.delete(request.id); }
  }
}
