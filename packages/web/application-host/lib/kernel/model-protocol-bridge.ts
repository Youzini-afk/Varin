/** Typed private codec channel. Original callbacks, including cancelled ones, own their drain. */
import type { ModelProtocolCall, ModelProtocolResult } from '@varin/extension-contract';
export interface ModelProtocolOwner {
  protocol(bindingId: string, call: ModelProtocolCall, signal: AbortSignal): Promise<ModelProtocolResult>;
  release(bindingId: string): void;
  disconnected?(): Promise<void>;
}
export interface PrivateModelProtocolResponse {
  v: 1; kind: 'model-protocol-response'; id: string; kernelEpoch: string;
  result: { ok: true; value: ModelProtocolResult } | { ok: false; code: string };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function validCall(value: unknown): value is ModelProtocolCall {
  if (!object(value)) return false;
  if (value.kind === 'serialize') return object(value.configuration) && object(value.request) && text(value.request.request_id)
    && text(value.request.run_id) && object(value.request.binding) && Array.isArray(value.request.history)
    && Object.keys(value).every(key => ['kind', 'configuration', 'request'].includes(key));
  return value.kind === 'parse' && text(value.request_id) && text(value.run_id) && text(value.connection_identity)
    && (value.frame === null || typeof value.frame === 'string') && Object.hasOwn(value, 'state')
    && Object.keys(value).every(key => ['kind', 'request_id', 'run_id', 'connection_identity', 'frame', 'state'].includes(key));
}
export class ModelProtocolBridge {
  #owner?: ModelProtocolOwner;
  #disconnect: Promise<void> = Promise.resolve();
  readonly #active = new Map<string, { epoch: string; controller: AbortController; settled: Promise<void>; responseOpen: boolean }>();
  constructor(private readonly epoch: () => string | null, private readonly send: (frame: PrivateModelProtocolResponse) => Promise<void>, private readonly failed: () => void) {}
  setOwner(owner: ModelProtocolOwner): void {
    if (this.#owner && this.#owner !== owner) throw new Error('Model protocol owner already connected');
    this.#owner = owner;
  }
  close(): void {
    for (const entry of this.#active.values()) { entry.responseOpen = false; entry.controller.abort(); }
    this.#disconnect = this.#disconnect.then(async () => { await this.drain(); await this.#owner?.disconnected?.(); }).catch(() => {});
  }
  disconnected(): Promise<void> { return this.#disconnect; }
  async drain(): Promise<void> { while (this.#active.size) await Promise.all([...this.#active.values()].map(entry => entry.settled)); }
  consume(value: unknown): boolean {
    if (!object(value) || !['model-protocol-request', 'model-protocol-cancel', 'model-protocol-release'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.kernelEpoch) || value.kernelEpoch !== this.epoch()) return true;
    if (value.kind === 'model-protocol-release') { if (text(value.bindingId)) this.#owner?.release(value.bindingId); return true; }
    if (!text(value.id)) return true;
    const id = value.id; const epoch = value.kernelEpoch; const key = JSON.stringify([epoch, id]);
    if (value.kind === 'model-protocol-cancel') { this.#active.get(key)?.controller.abort(); return true; }
    if (this.#active.has(key)) return true;
    const query = value.query; const owner = this.#owner; const controller = new AbortController();
    const work = Promise.resolve().then(async (): Promise<PrivateModelProtocolResponse['result']> => {
      if (!owner || !object(query) || !text(query.bindingId) || !validCall(query.call)) return { ok: false, code: 'model_protocol_unavailable' };
      try { return { ok: true, value: await owner.protocol(query.bindingId, query.call, controller.signal) }; }
      catch { return { ok: false, code: controller.signal.aborted ? 'model_protocol_cancelled' : 'model_protocol_failed' }; }
    });
    const entry = { epoch, controller, settled: Promise.resolve(), responseOpen: true };
    this.#active.set(key, entry);
    entry.settled = work.then(async result => {
      if (entry.responseOpen && epoch === this.epoch()) await this.send({ v: 1, kind: 'model-protocol-response', id, kernelEpoch: epoch, result });
    }).catch(() => this.failed()).finally(() => { if (this.#active.get(key) === entry) this.#active.delete(key); });
    return true;
  }
}
