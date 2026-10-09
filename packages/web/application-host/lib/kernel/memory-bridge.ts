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
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateMemoryResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: MemoryToolOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Memory owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Memory channel closed', 'AbortError'));
    this.active.clear();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['memory-request','memory-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'memory-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Memory query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry = { epoch, controller };
    this.active.set(id, entry);
    const query = value.query;
    const owner = this.owner;
    void (async () => {
      let result: MemoryResult;
      try {
        result = validQuery(query) && owner
          ? await waitWithSignal(owner(query, controller.signal), controller.signal)
          : unavailableMemoryResult(owner ? 'Invalid memory query' : 'Memory owner is unavailable');
      } catch (error) {
        result = controller.signal.aborted ? unavailableMemoryResult('Memory query cancelled; any dispatched mutation requires receipt reconciliation')
          : unavailableMemoryResult(error instanceof Error ? error.message : 'Memory query failed');
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'memory-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
