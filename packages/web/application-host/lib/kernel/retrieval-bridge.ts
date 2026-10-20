import { sourceFailureCode } from './source-admission-error.js';
import { waitWithSignal } from '../cancellation.js';
import type { RetrievalQuery } from './protocol.generated.js';
import type { RetrievalOwner, RetrievalResult, RetrievalMaterialReader } from './retrieval-owner.js';
import { toolOperationId } from './protocol.generated.js';
import type { ExploreToolProgress } from '@varin/protocol';

export interface PrivateRetrievalResponse { v: 1; kind: 'retrieval-response'; id: string; kernelEpoch: string; result: RetrievalResult }
export interface PrivateRetrievalProgress { v: 1; kind: 'retrieval-progress'; id: string; kernelEpoch: string; progress: ExploreToolProgress }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailableRetrievalResult = (message: string): RetrievalResult => ({ status: 'unavailable', snippets: [], omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, stages: [], message });
const validQuery = (value: unknown): value is RetrievalQuery => {
  if (!record(value) || !record(value.inferenceOwner) || value.inferenceOwner.kind !== 'external' || !text(value.inferenceOwner.identity) || !text(value.inferenceOwner.epoch) || !['runId','threadId','grantId','question'].every(key => text(value[key]))
    || !record(value.source) || !['workspace_id','execution_workspace_id'].every(key => text((value.source as Record<string, unknown>)[key]))
    || !['live_root','fixed_branch','materialized'].includes(String(value.source.mode))
    || !(value.physicalRoot === null || record(value.physicalRoot) && ['hostId','canonicalRoot','rootId'].every(key => text((value.physicalRoot as Record<string, unknown>)[key])))) return false;
  const invocation = value.invocation;
  if (!record(invocation) || !text(invocation.toolCallId)
    || !(invocation.kind === 'model_step' ? text(invocation.requestId)
      : invocation.kind === 'policy_action' && text(invocation.actionId) && text(invocation.nodeId)
        || invocation.kind === 'nested_call' && text(invocation.parentOperationId))) return false;
  return (value.projectId === null || text(value.projectId))
    && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.every(text)))
    && (value.limit === undefined || (Number.isSafeInteger(value.limit) && Number(value.limit) > 0));
};
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class RetrievalBridge {
  private owner?: RetrievalOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController; delivery: AbortController;
    operationId?: string; reader?: RetrievalMaterialReader }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateRetrievalResponse | PrivateRetrievalProgress) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: RetrievalOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Retrieval owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Retrieval channel closed', 'AbortError'));
    this.active.clear();
  }
  async readMaterial(operationId: string, viewId: string) {
    const entries = [...this.active.values()].filter(entry => entry.operationId === operationId && entry.reader
      && entry.epoch === this.currentEpoch() && !entry.controller.signal.aborted);
    if (entries.length !== 1) throw new Error('Original retrieval material is unavailable; read its completed result instead');
    return entries[0]!.reader!(viewId);
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['retrieval-request','retrieval-cancel','retrieval-finish'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'retrieval-finish') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.delivery.abort();
      return true;
    }
    if (value.kind === 'retrieval-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Retrieval query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry: { epoch: string; controller: AbortController; delivery: AbortController; operationId?: string; reader?: RetrievalMaterialReader } =
      { epoch, controller, delivery: new AbortController() };
    this.active.set(id, entry);
    const query = value.query;
    if (validQuery(query)) {
      const invocation = query.invocation;
      entry.operationId = invocation.kind === 'nested_call' ? invocation.parentOperationId
        : toolOperationId(invocation.kind === 'model_step' ? { kind: 'model_step', request_id: invocation.requestId }
          : { kind: 'policy_action', action_id: invocation.actionId, node_id: invocation.nodeId }, invocation.toolCallId);
    }
    const owner = this.owner;
    void (async () => {
      let latest: ExploreToolProgress | undefined;
      let sending: Promise<void> | undefined;
      const emit = (progress: ExploreToolProgress) => {
        if (controller.signal.aborted || this.active.get(id) !== entry || epoch !== this.currentEpoch()) return;
        latest = progress;
        if (sending) return;
        sending = (async () => {
          while (latest && this.active.get(id) === entry && epoch === this.currentEpoch()) {
            const progress = latest; latest = undefined;
            await this.send({ v: 1, kind: 'retrieval-progress', id, kernelEpoch: epoch, progress });
          }
        })().catch(() => { this.transportFailed(); }).finally(() => { sending = undefined; if (latest) emit(latest); });
      };
      let result: RetrievalResult;
      try {
        result = validQuery(query) && owner
          // Cancellation detaches even a non-cooperative owner. Its durable inference ledger
          // can still settle actual dispatch facts without reviving this result delivery.
          ? await waitWithSignal(owner(query, controller.signal, emit, entry.delivery.signal, reader => { entry.reader = reader; }), controller.signal)
          : unavailableRetrievalResult(owner ? 'Invalid retrieval query' : 'Retrieval owner is unavailable');
      } catch (error) {
        const failure = sourceFailureCode(error);
        result = controller.signal.aborted ? { ...unavailableRetrievalResult('Retrieval query cancelled'), status: 'cancelled' }
          : { ...unavailableRetrievalResult('Retrieval query failed'), ...(failure ? { sourceFailure: failure } : {}) };
      }
      if (this.active.get(id) !== entry) return;
      latest = undefined;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      // Rust reconstructs admitted spans itself. Do not send a second copy of
      // every source body through the private bridge frame.
      await this.send({ v: 1, kind: 'retrieval-response', id, kernelEpoch: epoch,
        result: { ...result, snippets: result.snippets.map(({ content: _content, ...snippet }) => ({ ...snippet, content: '' })) } });
    })().catch(() => this.transportFailed());
    return true;
  }
}
