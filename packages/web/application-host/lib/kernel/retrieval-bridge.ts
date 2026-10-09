import { waitWithSignal } from '../cancellation.js';
import type { RetrievalQuery } from './protocol.generated.js';
import type { RetrievalOwner, RetrievalResult } from './retrieval-owner.js';

export interface PrivateRetrievalResponse { v: 1; kind: 'retrieval-response'; id: string; kernelEpoch: string; result: RetrievalResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailableRetrievalResult = (message: string): RetrievalResult => ({ status: 'unavailable', snippets: [], omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, stages: [], message });
const validQuery = (value: unknown): value is RetrievalQuery => {
  if (!record(value) || !['runId','threadId','workspaceId','executionWorkspaceId','grantId','question'].every(key => text(value[key]))
    || !record(value.liveRoot) || !['hostId','canonicalRoot','rootId'].every(key => text(value.liveRoot && record(value.liveRoot) ? value.liveRoot[key] : undefined))) return false;
  const invocation = value.invocation;
  if (!record(invocation) || !text(invocation.toolCallId)
    || !(invocation.kind === 'model_step' ? text(invocation.requestId)
      : invocation.kind === 'policy_action' && text(invocation.actionId) && text(invocation.nodeId))) return false;
  return (value.projectId === null || text(value.projectId))
    && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.every(text)))
    && (value.limit === undefined || (Number.isSafeInteger(value.limit) && Number(value.limit) > 0));
};
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class RetrievalBridge {
  private owner?: RetrievalOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateRetrievalResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: RetrievalOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Retrieval owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Retrieval channel closed', 'AbortError'));
    this.active.clear();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['retrieval-request','retrieval-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'retrieval-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Retrieval query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry = { epoch, controller };
    this.active.set(id, entry);
    const query = value.query;
    const owner = this.owner;
    void (async () => {
      let result: RetrievalResult;
      try {
        result = validQuery(query) && owner
          // Cancellation detaches even a non-cooperative owner. Its durable inference ledger
          // can still settle actual dispatch facts without reviving this result delivery.
          ? await waitWithSignal(owner(query, controller.signal), controller.signal)
          : unavailableRetrievalResult(owner ? 'Invalid retrieval query' : 'Retrieval owner is unavailable');
      } catch {
        result = controller.signal.aborted ? { ...unavailableRetrievalResult('Retrieval query cancelled'), status: 'cancelled' }
          : unavailableRetrievalResult('Retrieval query failed');
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'retrieval-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
