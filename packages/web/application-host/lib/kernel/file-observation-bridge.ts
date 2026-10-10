import type { FileObservationOwner } from './file-observation-owner.js';
import type { FileObservationOwnerQuery, FileObservationOwnerResult, FileObservationOwnerHint } from './protocol.generated.js';

export interface PrivateFileObservationResponse {
  v: 1; kind: 'file-observation-response'; id: string; kernelEpoch: string; result: FileObservationOwnerResult;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const position = (value: unknown): boolean => value === null || record(value) && text(value.sourceId)
  && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0;
function validQuery(value: unknown): value is FileObservationOwnerQuery {
  if (!record(value)) return false;
  if (value.action === 'close' || value.action === 'discard') return text(value.receiptId) && text(value.watchId)
    && (value.action === 'close' || text(value.token));
  const target = value.target;
  if (!['open', 'begin', 'finish'].includes(String(value.action)) || !record(target)
    || !text(target.receiptId) || !text(target.followupId) || !text(target.sourceRunId) || !text(target.threadId)
    || !Number.isSafeInteger(target.sourceIndex) || Number(target.sourceIndex) < 0
    || !text(target.path) || typeof target.immutable !== 'boolean' || !record(target.source)
    || !text(target.source.workspace_id) || !text(target.source.execution_workspace_id)) return false;
  if (value.action === 'open') return true;
  return text(value.watchId) && position(value.after) && (value.action === 'begin' || text(value.token));
}

/** Epoch-fenced owner rendezvous. Cancellation drains the same owner query; it does
 * not turn transport completion into a file fact or grant revocation. */
export class FileObservationBridge {
  private owner?: FileObservationOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateFileObservationResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: FileObservationOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('File observation owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear(); this.owner?.reset();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['file-observation-request', 'file-observation-cancel', 'file-observation-invalidated'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    if (value.kind === 'file-observation-invalidated') {
      if (value.scope === 'root' && text(value.rootId) && text(value.canonicalRoot)
        || value.scope === 'receipt' && text(value.receiptId)) this.owner?.invalidate(value as unknown as FileObservationOwnerHint);
      return true;
    }
    if (!text(value.id)) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'file-observation-cancel') { this.active.get(id)?.controller.abort(); return true; }
    if (this.active.has(id)) return true;
    const entry = { epoch, controller: new AbortController() }; this.active.set(id, entry);
    void (async () => {
      let result: FileObservationOwnerResult;
      try { result = !validQuery(value.query) ? { ok: false, code: 'invalid' }
        : !this.owner ? { ok: false, code: 'source_unavailable' } : await this.owner.query(value.query, entry.controller.signal); }
      catch { result = { ok: false, code: entry.controller.signal.aborted ? 'cancelled' : 'source_unavailable' }; }
      if (entry.controller.signal.aborted && result.ok && this.owner && validQuery(value.query)) {
        // A cancellation can win after open/begin allocated its own handle but
        // before Rust received that handle. Release only this query's resource.
        const query = value.query;
        const cleanup = new AbortController().signal;
        if (query.action === 'open' && 'watchId' in result) await this.owner.query({ action: 'close',
          receiptId: query.target.receiptId, watchId: result.watchId }, cleanup);
        if (query.action === 'begin' && 'token' in result) await this.owner.query({ action: 'discard',
          receiptId: query.target.receiptId, watchId: query.watchId, token: result.token }, cleanup);
        result = { ok: false, code: 'cancelled' };
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'file-observation-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
