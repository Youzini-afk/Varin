import { waitWithSignal } from '../cancellation.js';
import type { PlanQuery } from './plan-owner.js';
import type { PlanOwner, PlanResult } from './plan-owner.js';

export interface PrivatePlanResponse { v: 1; kind: 'plan-response'; id: string; kernelEpoch: string; result: PlanResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailablePlanResult = (message: string): PlanResult => ({ status: 'unknown', message });
const validQuery = (value: unknown): value is PlanQuery => record(value) && record(value.view) && record(value.origin)
  && ['read', 'mutate', 'receipt'].includes(String(value.action)) && record(value.arguments);
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class PlanBridge {
  private owner?: PlanOwner;
  // Only unresolved original executions need transient stopping evidence. Epoch loss clears it.
  private readonly completed = new Map<string, boolean>();
  private readonly active = new Map<string, { epoch: string; runId: string | null; controller: AbortController; settled: Promise<void>; responseOpen: boolean }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivatePlanResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: PlanOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Plan owner is already connected');
    this.owner = owner;
  }
  close(): void {
    this.completed.clear();
    for (const entry of this.active.values()) { entry.responseOpen = false; entry.controller.abort(new DOMException('Plan channel closed', 'AbortError')); }
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
    if (!record(value) || !['plan-request','plan-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch; const key = JSON.stringify([epoch, id]);
    if (value.kind === 'plan-cancel') {
      const entry = this.active.get(key);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Plan query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(key)) return true;
    const controller = new AbortController();
    const query = value.query;
    const owner = this.owner;
    const valid = validQuery(query);
    // The original owner promise, not the abortable observer, owns this registration.
    const originalKey = valid ? JSON.stringify([epoch, query.origin, query.view, query.arguments]) : null;
    const work = Promise.resolve().then(async (): Promise<PlanResult> => {
      if (!valid || !owner) return unavailablePlanResult(owner ? 'Invalid plan query' : 'Plan owner is unavailable');
      const result = await owner(query, controller.signal);
      // A durable original mutation wins over short-lived executor evidence.
      if (query.action === 'receipt' && originalKey && result.status === 'ready' && !result.mutation
        && this.completed.has(originalKey)) {
        const notStarted = this.completed.get(originalKey)!;
        return { ...result, executionReceipt: { origin: query.origin, view: query.view, executorStopped: true,
          outcome: notStarted ? 'failed' : 'indeterminate', effect: notStarted ? 'none' : 'unknown' } };
      }
      return result;
    });
    const entry = { epoch, runId: valid ? query.origin.runId : null, controller, responseOpen: true,
      settled: work.then(() => undefined, () => undefined) };
    this.active.set(key, entry);
    if (valid && owner && query.action === 'mutate' && originalKey) void work.then(result => {
      if (entry.responseOpen && epoch === this.currentEpoch() && result.status !== 'ready') {
        this.completed.set(originalKey, result.mutationNotStarted === true);
      }
    }, () => {
      if (entry.responseOpen && epoch === this.currentEpoch()) this.completed.set(originalKey, false);
    });
    void entry.settled.then(() => { if (this.active.get(key) === entry) this.active.delete(key); });
    void (async () => {
      let result: PlanResult;
      try {
        result = await waitWithSignal(work, controller.signal);
      } catch (error) {
        result = controller.signal.aborted ? unavailablePlanResult('Plan query cancelled; any dispatched mutation requires receipt reconciliation')
          : unavailablePlanResult(error instanceof Error ? error.message : 'Plan query failed');
      }
      if (!entry.responseOpen || epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'plan-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
