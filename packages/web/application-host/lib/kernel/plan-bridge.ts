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
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivatePlanResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: PlanOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Plan owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Plan channel closed', 'AbortError'));
    this.active.clear();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['plan-request','plan-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'plan-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Plan query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry = { epoch, controller };
    this.active.set(id, entry);
    const query = value.query;
    const owner = this.owner;
    void (async () => {
      let result: PlanResult;
      try {
        result = validQuery(query) && owner
          ? await waitWithSignal(owner(query, controller.signal), controller.signal)
          : unavailablePlanResult(owner ? 'Invalid plan query' : 'Plan owner is unavailable');
      } catch (error) {
        result = controller.signal.aborted ? unavailablePlanResult('Plan query cancelled; any dispatched mutation requires receipt reconciliation')
          : unavailablePlanResult(error instanceof Error ? error.message : 'Plan query failed');
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'plan-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
