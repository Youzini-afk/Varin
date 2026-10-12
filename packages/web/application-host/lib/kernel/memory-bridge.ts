import { waitWithSignal } from '../cancellation.js';
import type { MemoryQuery } from './memory-owner.js';
import type { MemoryToolOwner, MemoryResult } from './memory-owner.js';

export interface PrivateMemoryResponse { v: 1; kind: 'memory-response'; id: string; kernelEpoch: string; result: MemoryResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailableMemoryResult = (message: string): MemoryResult => ({ status: 'unknown', message });
const validQuery = (value: unknown): value is MemoryQuery => record(value) && text(value.runId)
  && ['synchronize', 'tool', 'receipt'].includes(String(value.action)) && record(value.scope);
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class MemoryBridge {
  private owner?: MemoryToolOwner;
  // Cancelled original owner results remain only for this kernel epoch; close clears them.
  private readonly completed = new Map<string, MemoryResult>();
  private readonly active = new Map<string, { epoch: string; runId: string | null; controller: AbortController; settled: Promise<void>; responseOpen: boolean }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateMemoryResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: MemoryToolOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Memory owner is already connected');
    this.owner = owner;
  }
  close(): void {
    this.completed.clear();
    for (const entry of this.active.values()) { entry.responseOpen = false; entry.controller.abort(new DOMException('Memory channel closed', 'AbortError')); }
  }
  /** Caller cancellation can return Unknown before a Knowledge transaction exits. */
  async drainRuns(runIds: ReadonlySet<string>): Promise<void> {
    for (;;) {
      const active = [...this.active.values()].filter(entry => entry.runId !== null && runIds.has(entry.runId));
      if (!active.length) return;
      for (const entry of active) entry.controller.abort(new DOMException('Bot domain execution suspended', 'AbortError'));
      await Promise.all(active.map(entry => entry.settled));
    }
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['memory-request','memory-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch; const key = JSON.stringify([epoch, id]);
    if (value.kind === 'memory-cancel') {
      const entry = this.active.get(key);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Memory query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(key)) return true;
    const controller = new AbortController();
    const query = value.query;
    const owner = this.owner;
    const valid = validQuery(query);
    // The original owner promise, not the abortable observer, owns this registration.
    const originKey = valid && query.origin ? JSON.stringify([epoch, query.runId, query.origin]) : null;
    const work = Promise.resolve().then(async (): Promise<MemoryResult> => {
      if (!valid || !owner) return unavailableMemoryResult(owner ? 'Invalid memory query' : 'Memory owner is unavailable');
      const result = await owner(query, controller.signal);
      if (query.action === 'receipt' && originKey && result.status === 'ready' && !result.memoryReceipt) {
        const original = this.completed.get(originKey);
        if (original) return { ...result, executionReceipt: { executorStopped: true,
          outcome: original.status !== 'ready' && original.mutationNotStarted === true ? 'failed' : 'indeterminate', effect: original.status !== 'ready' && original.mutationNotStarted === true ? 'none' : 'unknown', result: original } };
      }
      return result;
    });
    if (valid && query.action === 'tool' && originKey) void work.then(result => {
      if (entry.responseOpen && controller.signal.aborted && epoch === this.currentEpoch() && result.status !== 'ready') this.completed.set(originKey, result);
    }, () => {
      if (entry.responseOpen && epoch === this.currentEpoch()) this.completed.set(originKey, unavailableMemoryResult('Original memory owner settled without a confirmed result'));
    });
    const entry = { epoch, runId: valid ? query.runId : null, controller, responseOpen: true,
      settled: work.then(() => undefined, () => undefined) };
    this.active.set(key, entry);
    void entry.settled.then(() => { if (this.active.get(key) === entry) this.active.delete(key); });
    void (async () => {
      let result: MemoryResult;
      try {
        result = await waitWithSignal(work, controller.signal);
      } catch (error) {
        result = controller.signal.aborted ? unavailableMemoryResult('Memory query cancelled; any dispatched mutation requires receipt reconciliation')
          : unavailableMemoryResult(error instanceof Error ? error.message : 'Memory query failed');
      }
      if (!entry.responseOpen || epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'memory-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
