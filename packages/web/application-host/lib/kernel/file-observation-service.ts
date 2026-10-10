import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { DocumentsFileObservationOwner } from './file-observation-owner.js';
import type { FileObservationBinding, FileObservationKey } from './protocol.generated.js';

interface Seen { action: FileObservationBinding['action']; generation: number; revision: number }
interface Flight { action: FileObservationBinding['action']; controller: AbortController; work: Promise<void> }
const keyFor = (binding: FileObservationBinding): FileObservationKey => ({
  followupId: binding.followupId, generation: binding.generation, sourceIndex: binding.sourceIndex,
  receiptId: binding.receiptId, observationRevision: binding.observationRevision,
});

/** Reconcile original owner work from Catalog. Maps contain only transient flights
 * and wake coalescing, never condition state or an occurrence queue. */
export class FileObservationService {
  private readonly pending = new Set<string>();
  private readonly seen = new Map<string, Seen>();
  private readonly flights = new Map<string, Flight>();
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private suspended = false;
  private stopped = false;
  private pumping = false;
  private dirty = false;
  constructor(private readonly runtime: AgentRuntimeClient, private readonly owner: DocumentsFileObservationOwner,
    private readonly onError: (error: unknown) => void) {
    this.removers = [runtime.onEvent(event => { if (event.stream === 'durable') void this.recover(); }),
      runtime.onExit(() => {
        this.suspended = true; this.epoch.abort();
        for (const flight of this.flights.values()) flight.controller.abort();
        this.seen.clear(); this.pending.clear();
      }), runtime.onReady(() => {
        if (this.stopped) return;
        if (this.suspended) { this.epoch = new AbortController(); this.suspended = false; }
        void this.recover();
      })];
  }
  changed(receiptId: string): void { this.pending.add(receiptId); void this.recover(); }
  async stop(): Promise<void> {
    this.stopped = true; this.epoch.abort();
    for (const remove of this.removers) remove();
    for (const flight of this.flights.values()) flight.controller.abort();
    await Promise.allSettled([...this.flights.values()].map(flight => flight.work));
    this.owner.stop();
  }
  async recover(): Promise<void> {
    if (this.stopped || this.suspended) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      while (this.dirty && !epoch.signal.aborted) {
        this.dirty = false;
        const found = new Set<string>();
        let after: string | undefined;
        do {
          const page = await this.runtime.fileFollowups(after, epoch.signal);
          epoch.signal.throwIfAborted();
          for (const binding of page.bindings) {
            const id = binding.receiptId; found.add(id);
            const flight = this.flights.get(id);
            if (flight) {
              if (binding.action !== flight.action || !binding.target) flight.controller.abort();
              continue;
            }
            const seen = this.seen.get(id);
            if (!binding.target) {
              // One unavailable original receipt cannot block another source's
              // cancellation or read. Catalog retains this source's diagnosis.
              if (!seen || seen.revision !== binding.definitionRevision) this.onError(new Error(binding.failureCode ?? 'receipt_unavailable'));
              if (binding.watchId && this.owner.has(id, binding.watchId)) await this.owner.query({
                action: 'close', receiptId: id, watchId: binding.watchId,
              }, epoch.signal);
              this.seen.set(id, { action: binding.action, generation: binding.generation, revision: binding.definitionRevision });
              continue;
            }
            const target = binding.target;
            if (binding.action === 'paused') {
              this.seen.set(id, { action: binding.action, generation: binding.generation, revision: binding.definitionRevision });
              continue;
            }
            const changed = !seen || seen.action !== binding.action || seen.generation !== binding.generation
              || seen.revision !== binding.definitionRevision;
            if (!changed && !this.pending.has(id)) continue;
            this.pending.delete(id);
            this.seen.set(id, { action: binding.action, generation: binding.generation, revision: binding.definitionRevision });
            const controller = new AbortController();
            const signal = AbortSignal.any([epoch.signal, controller.signal]);
            const task: Flight = { action: binding.action, controller, work: Promise.resolve() };
            task.work = (async () => {
              try {
                if (binding.action === 'release') await this.runtime.releaseFileFollowup(keyFor(binding), signal);
                else {
                  const result = await this.runtime.observeFileFollowup({ ...keyFor(binding),
                    reopen: !target.immutable && !this.owner.has(id, binding.watchId) }, signal);
                  if (!result.accepted && !signal.aborted) this.pending.add(id);
                  if (!signal.aborted) this.seen.set(id, { action: binding.action, generation: binding.generation,
                    revision: result.followup.revision });
                }
              } catch (error) { if (!signal.aborted) this.onError(error); }
              finally {
                if (this.flights.get(id) === task) this.flights.delete(id);
                // Read the new original revision and any wake that arrived during
                // this read. A same-state observation is not a new source event.
                if (!this.stopped && !this.suspended) void this.recover();
              }
            })();
            this.flights.set(id, task);
          }
          after = page.nextCursor ?? undefined;
        } while (after !== undefined);
        for (const id of this.seen.keys()) if (!found.has(id) && !this.flights.has(id)) {
          this.seen.delete(id); this.pending.delete(id);
        }
      }
    } catch (error) { if (!epoch.signal.aborted) this.onError(error); }
    finally {
      this.pumping = false;
      if (this.dirty && !this.stopped && !this.suspended && epoch !== this.epoch) void this.recover();
    }
  }
}
