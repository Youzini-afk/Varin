import type { RuntimeEvent, AgentRuntimeStreamEvent } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ownershipResolver } from './ownership-resolver.js';

type Progress = Extract<AgentRuntimeStreamEvent, { stream: 'progress' }>;
type Subscriber = {
  observationKey?: string;
  cursor: number; principal: string | null | undefined; interests: ReadonlySet<string> | undefined;
  emit: (event: unknown) => boolean; fail: (error: unknown) => void;
  closed: boolean; reading: boolean; dirty: boolean;
};
const PAGE = 256;
// A replay cache, not a delivery limit. Older subscribers read the durable owner directly.
const RETAINED_EVENTS = 4096;
const hubs = new WeakMap<AgentRuntimeClient, ThreadEventHub>();
export function threadEventHub(runtime: AgentRuntimeClient): ThreadEventHub {
  let hub = hubs.get(runtime);
  if (!hub) { hub = new ThreadEventHub(runtime); hubs.set(runtime, hub); }
  return hub;
}

/** One durable reader per Host, with per-subscriber visibility and lossy progress interests. */
export class ThreadEventHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly observations = new Map<string, Subscriber>();
  private events: RuntimeEvent[] = [];
  private cursor = 0;
  private retainedAfter = 0;
  private reading = false;
  private dirty = false;
  private generation = 0;
  private epoch: string | undefined;
  private removeEvent: (() => void) | undefined;
  private removeExit: (() => void) | undefined;
  private initialized = false;
  private readonly owners: ReturnType<typeof ownershipResolver>;
  constructor(private readonly runtime: AgentRuntimeClient) { this.owners = ownershipResolver(runtime); }

  subscribe(cursor: number, principal: string | null | undefined,
    emit: Subscriber['emit'], fail: Subscriber['fail'], threadIds?: readonly string[], observationId?: string): () => void {
    const subscriber: Subscriber = { cursor, principal, emit, fail,
      interests: threadIds === undefined ? undefined : new Set(threadIds), closed: false, reading: false, dirty: true };
    if (observationId !== undefined) {
      const key = this.observationKey(observationId, principal);
      if (this.observations.has(key)) throw new Error('Observation identity is already active');
      subscriber.observationKey = key; this.observations.set(key, subscriber);
    }
    this.subscribers.add(subscriber);
    if (!this.removeEvent) {
      this.cursor = cursor; this.retainedAfter = cursor;
      this.removeEvent = this.runtime.onEvent(event => {
        if (this.epoch !== undefined && event.kernelEpoch !== undefined && event.kernelEpoch !== this.epoch) this.reset('cursor' in event ? event.cursor : 0, 'kernel-restarted', event.kernelEpoch);
        this.epoch = event.kernelEpoch;
        if (event.stream === 'progress') this.progress(event);
        else {
          if (event.stream === 'resync') { this.reset(event.cursor, 'kernel-restarted', event.kernelEpoch); }
          this.wake();
        }
      });
      this.removeExit = this.runtime.onExit(error => {
        for (const observer of [...this.subscribers]) this.reject(observer, error);
      });
    }
    this.wake();
    if (this.initialized) {
      if (cursor > this.cursor) void this.checkRestoredCursor(subscriber);
      else void this.drain(subscriber);
    }
    return () => this.close(subscriber);
  }

  private async checkRestoredCursor(subscriber: Subscriber) {
    const generation = this.generation;
    try {
      const { eventCursor } = await this.runtime.status();
      if (subscriber.closed || generation !== this.generation) return;
      if (subscriber.cursor > eventCursor) {
        subscriber.cursor = eventCursor;
        this.send(subscriber, { stream: 'resync', cursor: eventCursor, reason: 'cursor-reset' });
      }
      void this.drain(subscriber);
    } catch (error) { if (!subscriber.closed && generation === this.generation) this.reject(subscriber, error); }
  }

  private observationKey(id: string, principal: Subscriber['principal']): string {
    return JSON.stringify([principal === undefined ? 'trusted' : 'principal', principal ?? null, id]);
  }
  updateInterests(observationId: string, principal: Subscriber['principal'], threadIds: readonly string[] | null): void {
    const subscriber = this.observations.get(this.observationKey(observationId, principal));
    if (!subscriber || subscriber.closed) throw Object.assign(new Error('Observation is no longer active'), { code: 'observation-closed' });
    subscriber.interests = threadIds === null ? undefined : new Set(threadIds);
  }

  private close(subscriber: Subscriber) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    if (subscriber.observationKey) this.observations.delete(subscriber.observationKey);
    if (!this.subscribers.size) {
      this.generation += 1;
      this.removeEvent?.(); this.removeEvent = undefined;
      this.removeExit?.(); this.removeExit = undefined;
      this.events = []; this.initialized = false; this.reading = false; this.dirty = false;
    }
  }
  private reject(subscriber: Subscriber, error: unknown) {
    this.close(subscriber);
    subscriber.fail(error);
  }
  private send(subscriber: Subscriber, event: unknown): boolean {
    if (subscriber.closed) return false;
    try { if (subscriber.emit(event)) return true; this.close(subscriber); }
    catch (error) { this.reject(subscriber, error); }
    return false;
  }
  private reset(cursor: number, reason: string, kernelEpoch?: string) {
    this.generation += 1; this.reading = false;
    this.cursor = cursor; this.retainedAfter = cursor; this.events = [];
    for (const subscriber of [...this.subscribers]) {
      subscriber.cursor = cursor; subscriber.dirty = true;
      this.send(subscriber, { stream: 'resync', cursor, reason, ...(kernelEpoch === undefined ? {} : { kernelEpoch }) });
    }
  }
  private wake() {
    this.dirty = true;
    if (!this.reading) void this.read();
  }
  private async read() {
    const generation = this.generation;
    this.reading = true;
    try {
      if (!this.initialized) {
        const { eventCursor } = await this.runtime.status();
        if (generation !== this.generation) return;
        if (this.cursor > eventCursor) {
          this.cursor = eventCursor; this.retainedAfter = eventCursor;
          for (const subscriber of this.subscribers) {
            subscriber.cursor = eventCursor;
            this.send(subscriber, { stream: 'resync', cursor: eventCursor, reason: 'cursor-reset' });
          }
        }
        this.initialized = true;
      }
      while (this.dirty && this.subscribers.size && generation === this.generation) {
        this.dirty = false;
        let page: RuntimeEvent[];
        do {
          page = await this.runtime.events(this.cursor, PAGE);
          if (generation !== this.generation) return;
          if (page.length) {
            this.cursor = page.at(-1)!.cursor;
            this.events.push(...page);
            if (this.events.length > RETAINED_EVENTS) {
              const remove = this.events.length - RETAINED_EVENTS;
              this.retainedAfter = this.events[remove - 1]!.cursor;
              this.events.splice(0, remove);
            }
          }
          for (const subscriber of this.subscribers) void this.drain(subscriber);
        } while (page.length === PAGE && this.subscribers.size && generation === this.generation);
      }
    } catch (error) {
      if (generation === this.generation) for (const subscriber of [...this.subscribers]) this.reject(subscriber, error);
    } finally {
      if (generation === this.generation) { this.reading = false; if (this.dirty && this.subscribers.size) this.wake(); }
    }
  }

  private async visible(event: RuntimeEvent, principal: Subscriber['principal']): Promise<boolean> {
    if (principal === undefined) return true;
    if (event.thread_id) {
      const owners = await this.owners.owners({ threads: [event.thread_id] });
      return owners.every(owner => owner === null || owner === principal);
    }
    // Global does not mean public. Organization notifications belong to their original space.
    return event.kind === 'organization.changed' && event.subject === `organization:${JSON.stringify(principal)}`;
  }
  private async drain(subscriber: Subscriber) {
    subscriber.dirty = true;
    if (subscriber.closed || subscriber.reading || !this.initialized) return;
    subscriber.reading = true;
    const generation = this.generation;
    try {
      while (!subscriber.closed && subscriber.dirty && generation === this.generation) {
        subscriber.dirty = false;
        const through = this.cursor;
        const replay = subscriber.cursor < this.retainedAfter;
        // A late observer alone pays for backfill. Current observers never multiply IPC work.
        const page = replay ? await this.runtime.events(subscriber.cursor, PAGE, undefined, subscriber.principal)
          : this.events.filter(event => event.cursor > subscriber.cursor && event.cursor <= through);
        const access = replay ? undefined : await Promise.all(page.map(event => this.visible(event, subscriber.principal)));
        if (generation !== this.generation || subscriber.closed) return;
        for (const [index, event] of page.entries()) {
          if ((access === undefined || access[index]) && !this.send(subscriber, event)) return;
          subscriber.cursor = event.cursor;
        }
        if (replay && page.length === PAGE) subscriber.dirty = true;
        else subscriber.cursor = Math.max(subscriber.cursor, through);
      }
    } catch (error) { if (generation === this.generation && !subscriber.closed) this.reject(subscriber, error); }
    finally {
      subscriber.reading = false;
      if (!subscriber.closed && subscriber.dirty) void this.drain(subscriber);
    }
  }
  private progress(event: Progress) {
    const generation = this.generation;
    for (const subscriber of this.subscribers) {
      if (subscriber.interests && !subscriber.interests.has(event.threadId)) continue;
      if (subscriber.principal === undefined) { this.send(subscriber, event); continue; }
      // Resolver batches first misses across observers; cached immutable ownership never rereads Catalog.
      void this.owners.owners({ threads: [event.threadId] }).then(owners => {
        if (generation === this.generation && !subscriber.closed && owners.every(owner => owner === null || owner === subscriber.principal)) this.send(subscriber, event);
      }, error => { if (generation === this.generation && !subscriber.closed) this.reject(subscriber, error); });
    }
  }
}
