import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DocumentsFileObservationOwner } from './file-observation-owner.js';
import type { FileObservationBinding, FileObservationKey } from './protocol.generated.js';

interface Seen { action: FileObservationBinding['action']; generation: number; revision: number }
interface Flight { action: FileObservationBinding['action']; generation: number; controller: AbortController; work: Promise<void> }
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
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryPoll: ReturnType<typeof setTimeout> | undefined;
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private suspended = false;
  private stopped = false;
  private pumping = false;
  private dirty = false;
  private readonly nativeReferences=new Set<string>();
  constructor(private readonly runtime: AgentRuntimeClient, private readonly owner: DocumentsFileObservationOwner,
    private readonly onError: (error: unknown) => void, private readonly native?:import('./native-workspaces.js').NativeWorkspaceOwner) {
    this.removers = [runtime.onEvent(event => { if (event.stream === 'durable') void this.recover(); }),
      runtime.onExit(() => {
        this.suspended = true; this.epoch.abort();
        this.clearPolls();
        for (const flight of this.flights.values()) flight.controller.abort();
        this.seen.clear(); this.pending.clear();
      }), runtime.onReady(() => {
        if (this.stopped) return;
        if (this.suspended) { this.epoch = new AbortController(); this.suspended = false; }
        void this.recover();
      })];
  }
  changed(receiptId: string): void { this.pending.add(receiptId); void this.recover(); }
  private clearPoll(receiptId: string): void {
    const timer = this.polls.get(receiptId);
    if (timer !== undefined) clearTimeout(timer);
    this.polls.delete(receiptId);
  }
  private clearPolls(): void {
    for (const id of this.polls.keys()) this.clearPoll(id);
    if (this.recoveryPoll !== undefined) clearTimeout(this.recoveryPoll);
    this.recoveryPoll = undefined;
  }
  private retryRecovery(): void {
    if (this.stopped || this.suspended || this.recoveryPoll !== undefined) return;
    this.recoveryPoll = setTimeout(() => {
      this.recoveryPoll = undefined;
      void this.recover();
    }, 1_000);
    this.recoveryPoll.unref();
  }
  private poll(receiptId: string): void {
    if (this.stopped || this.suspended || this.polls.has(receiptId)) return;
    // This is only a transport wake. The original Catalog key/cursor is read
    // again before every attempt; no condition or event is evaluated here.
    const timer = setTimeout(() => {
      this.polls.delete(receiptId);
      this.changed(receiptId);
    }, 1_000);
    timer.unref();
    this.polls.set(receiptId, timer);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.epoch.abort();
    this.clearPolls();
    for (const remove of this.removers) remove();
    for (const flight of this.flights.values()) flight.controller.abort();
    await Promise.allSettled([...this.flights.values()].map(flight => flight.work));
    this.owner.stop();
    for(const id of this.nativeReferences)await this.native?.releaseReference(`file-observation:${id}`);
    this.nativeReferences.clear();
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
              if (binding.action !== flight.action || binding.generation !== flight.generation || !binding.target) {
                this.clearPoll(id); flight.controller.abort();
              }
              continue;
            }
            const seen = this.seen.get(id);
            if (!binding.target && binding.action !== 'release') {
              this.clearPoll(id);
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
            const managed = target?.source.resource_owner.kind === 'managed_host';
            if (binding.action === 'paused') {
              this.clearPoll(id);
              this.seen.set(id, { action: binding.action, generation: binding.generation, revision: binding.definitionRevision });
              continue;
            }
            const changed = !seen || seen.action !== binding.action || seen.generation !== binding.generation
              || seen.revision !== binding.definitionRevision;
            if (!changed && !this.pending.has(id)) {
              // A fixed snapshot cannot gain file changes. Only an unresolved
              // original-owner diagnosis needs another transport observation.
              if (managed && target?.immutable && binding.failureCode !== null) this.poll(id);
              continue;
            }
            this.clearPoll(id);
            this.pending.delete(id);
            this.seen.set(id, { action: binding.action, generation: binding.generation, revision: binding.definitionRevision });
            const controller = new AbortController();
            const signal = AbortSignal.any([epoch.signal, controller.signal]);
            const task: Flight = { action: binding.action, generation: binding.generation, controller, work: Promise.resolve() };
            task.work = (async () => {
              let released = false;
              let retry = binding.action === 'release' || (managed && !target?.immutable);
              try {
                if (binding.action === 'release') {
                  released = (await this.runtime.releaseFileFollowup(keyFor(binding), signal)).released;
                }
                else {
                  if (!target) throw new Error('The original file observation target is unavailable');
                  if(!managed&&target.source.mode==='native_workspace'){
                    if(!this.native)throw new Error('Native file observation owner is unavailable');
                    await this.native.retainReference(target.source,`file-observation:${id}`,signal);this.nativeReferences.add(id);
                  }
                  const result = await this.runtime.observeFileFollowup({ ...keyFor(binding),
                    reopen: !managed && !target.immutable && !this.owner.has(id, binding.watchId) }, signal);
                  if (!result.accepted && !signal.aborted) this.pending.add(id);
                  if (!signal.aborted) this.seen.set(id, { action: binding.action, generation: binding.generation,
                    revision: result.followup.revision });
                }
                if(released&&this.nativeReferences.has(id)){await this.native?.releaseReference(`file-observation:${id}`);this.nativeReferences.delete(id);}
              } catch (error) {
                if (!signal.aborted) { retry = binding.action === 'release' || managed || target?.source.mode === 'native_workspace'; this.onError(error); }
              }
              finally {
                if (this.flights.get(id) === task) this.flights.delete(id);
                // A transport failure is not a release acknowledgement. Each
                // remote receipt retries independently, so one unreachable B
                // cannot delay another receipt's read or cancellation.
                if (retry && !released && !signal.aborted) this.poll(id);
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
          if(this.nativeReferences.has(id)){await this.native?.releaseReference(`file-observation:${id}`);this.nativeReferences.delete(id);}
          this.clearPoll(id); this.seen.delete(id); this.pending.delete(id);
        }
        for (const [id, flight] of this.flights) if (!found.has(id)) {
          this.clearPoll(id); flight.controller.abort();
        }
        if (this.recoveryPoll !== undefined) clearTimeout(this.recoveryPoll);
        this.recoveryPoll = undefined;
      }
    } catch (error) {
      if (!epoch.signal.aborted) { this.onError(error); this.retryRecovery(); }
    }
    finally {
      this.pumping = false;
      if (this.dirty && !this.stopped && !this.suspended && epoch !== this.epoch) void this.recover();
    }
  }
}
