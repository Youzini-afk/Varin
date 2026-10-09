import { randomUUID } from 'node:crypto';
import type { ApplicationExtensionRuntime, HostServiceBinding } from '@varin/extension-host';
import {
  parseVarinRunActivityAcknowledgement, parseVarinRunActivityDelivery,
  resolveVarinExtensionServiceRouting, VARIN_RUN_ACTIVITY_KINDS,
  VARIN_RUN_ACTIVITY_SERVICE_ID, VARIN_RUN_ACTIVITY_VERSION,
  type JsonValue, type VarinExtensionCatalogSnapshot, type VarinExtensionServiceRoutingDocument,
} from '@varin/extension-contract';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ThreadSummary } from './protocol.generated.js';

interface Subscription {
  id: string;
  key: string;
  threadId: string;
  scope: { sessionId: string; projectId?: string };
  binding: HostServiceBinding;
  controller: AbortController;
  dirty: boolean;
  pumping: boolean;
}
interface Selection {
  revision: number;
  catalog: VarinExtensionCatalogSnapshot;
  routing: VarinExtensionServiceRoutingDocument;
  legacy?: string;
}

/** Host-owned, non-blocking consumer of committed facts. No callback runs in the control process:
 * implementations execute in the selected extension's existing broker worker. Each subscription
 * advances independently, and failures affect only that subscription's durable delivery cursor.
 */
export class RunObservers {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly preparing = new Map<string, number>();
  private readonly pendingSelections = new Map<string, { threadId: string; projectId: string | null }>();
  private readonly runThreads = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private readonly removers: Array<() => void>;
  private selection: Selection | undefined;
  private fingerprint = '';
  private revision = 0;
  private refreshing = false;
  private refreshAgain = false;
  private discoveryPending = false;
  private sourceReader: AbortController | undefined;
  private epoch = new AbortController();
  private suspended = false;
  private sourceCursor: number | undefined;
  private notifiedCursor = 0;
  private sourceEnabled = false;

  constructor(private readonly runtime: AgentRuntimeClient,
    private readonly extensions: ApplicationExtensionRuntime,
    private readonly onError: (threadId: string | undefined, error: unknown) => void) {
    // Register before reading the committed head. Backlog reads cover <= head; the source reader
    // covers subsequent notifications, including a terminal commit during startup discovery.
    this.removers = [runtime.onEvent(event => {
      this.resumeEpoch();
      if (event.stream === 'durable' && this.discoveryPending) void this.refresh();
      if (event.stream !== 'durable' || !this.sourceEnabled) return;
      this.notifiedCursor = Math.max(this.notifiedCursor, event.cursor);
      void this.readSource();
    }), runtime.onExit(() => this.loseEpoch()), runtime.onReady(() => this.resumeEpoch()), extensions.subscribe(() => { void this.refresh(); })];
    void this.refresh();
  }

  stop(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.epoch.abort();
    this.sourceEnabled = false;
    for (const remove of this.removers) remove();
    for (const subscription of this.subscriptions.values()) subscription.controller.abort();
    this.subscriptions.clear();
    this.preparing.clear();
    this.pendingSelections.clear();
  }

  private resumeEpoch(): void {
    if (!this.suspended || this.lifetime.signal.aborted) return;
    // Only an actual successful handshake/runtime frame resumes intent. Registering this owner
    // or losing the kernel does not start it. Pending facts need no new business event to replay.
    this.suspended = false;
    this.epoch = new AbortController();
    void this.refresh();
  }

  private loseEpoch(): void {
    if (this.lifetime.signal.aborted) return;
    this.epoch.abort();
    this.suspended = true;
    this.sourceEnabled = false;
    this.sourceReader = undefined;
    this.sourceCursor = undefined;
    this.notifiedCursor = 0;
    this.selection = undefined;
    this.fingerprint = '';
    for (const subscription of this.subscriptions.values()) subscription.controller.abort();
    this.subscriptions.clear();
    this.preparing.clear();
    this.pendingSelections.clear();
    this.runThreads.clear();
  }

  private remove(key: string): void {
    this.subscriptions.get(key)?.controller.abort();
    this.subscriptions.delete(key);
  }

  private async refresh(): Promise<void> {
    if (this.lifetime.signal.aborted || this.suspended) return;
    this.refreshAgain = true;
    if (this.refreshing) return;
    this.refreshing = true;
    const epoch = this.epoch;
    try {
      while (this.refreshAgain && !this.lifetime.signal.aborted) {
        this.refreshAgain = false;
        const [catalog, routing] = await Promise.all([this.extensions.catalog.snapshot(), this.extensions.routing.read()]);
        epoch.signal.throwIfAborted();
        if (!catalog.authoritative || !routing.authoritative) throw new Error('Activity observer selection is unavailable');
        const services = this.extensions.services.getSnapshot();
        const relevant = catalog.extensions.filter(entry => entry.manifest.provides?.services?.some(service =>
          service.id === VARIN_RUN_ACTIVITY_SERVICE_ID && service.version === VARIN_RUN_ACTIVITY_VERSION));
        const rules = routing.document.rules.filter(rule => rule.serviceId === VARIN_RUN_ACTIVITY_SERVICE_ID && rule.version === VARIN_RUN_ACTIVITY_VERSION);
        const legacy = services.selections[`${VARIN_RUN_ACTIVITY_SERVICE_ID}@${VARIN_RUN_ACTIVITY_VERSION}`];
        const fingerprint = JSON.stringify({ rules, legacy,
          extensions: relevant.map(entry => [entry.manifest.id, entry.desired, entry.selectedVersion, entry.integrity]),
          providers: services.providers.filter(provider => provider.descriptor.id === VARIN_RUN_ACTIVITY_SERVICE_ID)
            .map(provider => [provider.providerId, provider.status]) });
        if (fingerprint === this.fingerprint && !this.discoveryPending) continue;
        this.fingerprint = fingerprint;
        this.selection = { revision: ++this.revision, catalog, routing: routing.document, ...(legacy ? { legacy } : {}) };
        // Publish route/enablement revocation synchronously, before any thread/context lookup.
        // A normal generation replacement keeps the same stable selected provider and its pin.
        for (const subscription of this.subscriptions.values()) {
          try {
            if (this.selectedProviderKey(this.selection, subscription.scope) !== subscription.binding.providerKey) this.remove(subscription.key);
          } catch (error) {
            this.remove(subscription.key);
            this.onError(subscription.threadId, error);
          }
        }
        if (!rules.length && !legacy) {
          this.sourceEnabled = false;
          this.sourceCursor = undefined;
          for (const threadId of this.subscriptions.keys()) this.remove(threadId);
          this.discoveryPending = false;
          continue;
        }
        if (!this.sourceEnabled || this.sourceCursor === undefined) {
          this.sourceEnabled = true;
          const head = await this.runtime.status(epoch.signal);
          epoch.signal.throwIfAborted();
          this.sourceCursor = head.eventCursor;
          this.notifiedCursor = Math.max(this.notifiedCursor, head.eventCursor);
        }
        const threads = await this.runtime.threads(epoch.signal);
        epoch.signal.throwIfAborted();
        for (const thread of threads) this.scheduleSelection(thread);
        this.discoveryPending = false;
        void this.readSource();
      }
    } catch (error) {
      if (!epoch.signal.aborted && !this.lifetime.signal.aborted) {
        // Selection publication may already have revoked old subscriptions, but head/thread
        // discovery did not finish. A later real durable notification retries the same selection.
        // No polling, exit-driven restart, or retry based only on this failure is scheduled.
        this.discoveryPending = true;
        this.onError(undefined, error);
      }
    } finally {
      this.refreshing = false;
      if (this.refreshAgain && !this.suspended && !this.lifetime.signal.aborted) void this.refresh();
    }
  }

  private scheduleSelection(thread: ThreadSummary): void {
    if (!this.selection || this.lifetime.signal.aborted) return;
    for (const branch of thread.branches) {
      if (branch.latest_run) this.runThreads.set(branch.latest_run.id, thread.thread_id);
    }
    for (const projectId of thread.observer_project_ids) this.scheduleScope(thread.thread_id, projectId);
  }

  private scheduleScope(threadId: string, projectId: string | null): void {
    if (!this.selection || this.lifetime.signal.aborted) return;
    const key = JSON.stringify([threadId, projectId]);
    const revision = this.selection.revision;
    this.pendingSelections.set(key, { threadId, projectId });
    if (this.preparing.get(key) === revision) return;
    this.pendingSelections.delete(key);
    this.preparing.set(key, revision);
    void this.selectScope(threadId, projectId, this.selection).catch(error => {
      if (!this.lifetime.signal.aborted) this.onError(threadId, error);
    }).finally(() => {
      if (this.preparing.get(key) === revision) {
        this.preparing.delete(key);
        const pending = this.pendingSelections.get(key);
        if (pending) this.scheduleScope(pending.threadId, pending.projectId);
      }
    });
  }

  private selectedProviderKey(selection: Selection, routing: { sessionId: string; projectId?: string }): string | undefined {
    const candidates = selection.catalog.extensions.filter(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
      && entry.manifest.provides?.services?.some(service => service.id === VARIN_RUN_ACTIVITY_SERVICE_ID && service.version === VARIN_RUN_ACTIVITY_VERSION))
      .map(entry => ({ providerId: entry.manifest.id, providerKey: `${entry.manifest.id}:host:${VARIN_RUN_ACTIVITY_SERVICE_ID}@${VARIN_RUN_ACTIVITY_VERSION}` }));
    const resolved = resolveVarinExtensionServiceRouting({ candidates, document: selection.routing, context: routing,
      serviceId: VARIN_RUN_ACTIVITY_SERVICE_ID, version: VARIN_RUN_ACTIVITY_VERSION });
    // This observer is opt-in. Merely installing its package is not a subscription.
    if (!selection.legacy && !selection.routing.rules.some(rule => rule.serviceId === VARIN_RUN_ACTIVITY_SERVICE_ID
      && rule.version === VARIN_RUN_ACTIVITY_VERSION && Object.entries(rule.scope).every(([key, value]) => routing[key as keyof typeof routing] === value))) {
      return undefined;
    }
    const legacyProvider = selection.legacy ? this.extensions.services.getSnapshot().providers.find(provider => provider.providerId === selection.legacy) : undefined;
    const providerKey = legacyProvider?.providerKey ?? resolved.providerKey;
    if ((!selection.legacy && resolved.status !== 'resolved') || !providerKey) {
      throw new Error('Selected activity observer is unavailable or ambiguous');
    }
    return providerKey;
  }

  private async selectScope(threadId: string, projectId: string | null, selection: Selection): Promise<void> {
    if (this.selection !== selection || this.lifetime.signal.aborted) return;
    const key = JSON.stringify([threadId, projectId]);
    const routing = { sessionId: threadId, ...(projectId !== null ? { projectId } : {}) };
    const providerKey = this.selectedProviderKey(selection, routing);
    if (!providerKey) { this.remove(key); return; }
    const id = JSON.stringify([`${VARIN_RUN_ACTIVITY_SERVICE_ID}@${VARIN_RUN_ACTIVITY_VERSION}`, providerKey, threadId, projectId]);
    const previous = this.subscriptions.get(key);
    if (previous && previous.id !== id) this.remove(key);
    const binding = await this.extensions.prepareService({ serviceId: VARIN_RUN_ACTIVITY_SERVICE_ID,
      version: VARIN_RUN_ACTIVITY_VERSION, method: 'observe', args: [], routing });
    if (this.selection !== selection || this.lifetime.signal.aborted) return;
    if (binding.providerKey !== providerKey) throw new Error('Activity observer selection changed during preparation');
    const current = this.subscriptions.get(key);
    if (current?.id === id) {
      // Ordinary replacement keeps the old invocation pin alive. New facts use the new binding.
      current.binding = binding;
      this.kick(current);
    } else {
      const subscription: Subscription = { id, key, threadId, scope: routing, binding,
        controller: new AbortController(), dirty: false, pumping: false };
      this.subscriptions.set(key, subscription);
      this.kick(subscription);
    }
  }

  private async readSource(): Promise<void> {
    if (!this.sourceEnabled || this.sourceCursor === undefined || this.sourceReader || this.lifetime.signal.aborted) return;
    const epoch = this.epoch;
    this.sourceReader = epoch;
    let failed = false;
    let exhausted = false;
    try {
      while (this.sourceEnabled && this.sourceCursor < this.notifiedCursor && !this.lifetime.signal.aborted) {
        const events = await this.runtime.events(this.sourceCursor, 256, epoch.signal);
        epoch.signal.throwIfAborted();
        if (!events.length) { exhausted = true; break; }
        for (const event of events) {
          let wakeThread: string | undefined;
          if (event.kind === 'thread.created') {
            const thread = await this.runtime.thread(event.subject, epoch.signal);
            epoch.signal.throwIfAborted();
            this.scheduleSelection(thread);
          } else if (VARIN_RUN_ACTIVITY_KINDS.includes(event.kind as typeof VARIN_RUN_ACTIVITY_KINDS[number])) {
            let threadId = this.runThreads.get(event.subject);
            if (!threadId) {
              threadId = (await this.runtime.run(event.subject, epoch.signal)).thread_id;
              epoch.signal.throwIfAborted();
              this.runThreads.set(event.subject, threadId);
            }
            wakeThread = threadId;
            // Admission may introduce a new project on another branch. Discovery includes every
            // admitted scope; preparation is independent and never blocks this source reader.
            const thread = await this.runtime.thread(threadId, epoch.signal);
            epoch.signal.throwIfAborted();
            this.scheduleSelection(thread);
          }
          this.sourceCursor = event.cursor;
          if (wakeThread) {
            for (const subscription of this.subscriptions.values()) {
              if (subscription.threadId === wakeThread) this.kick(subscription);
            }
          }
        }
      }
    } catch (error) {
      failed = true;
      if (!epoch.signal.aborted && !this.lifetime.signal.aborted) this.onError(undefined, error);
    } finally {
      if (this.sourceReader === epoch) {
        this.sourceReader = undefined;
        if (!failed && !exhausted && this.sourceCursor !== undefined && this.sourceCursor < this.notifiedCursor) void this.readSource();
      }
    }
  }

  private kick(subscription: Subscription): void {
    subscription.dirty = true;
    if (subscription.pumping || subscription.controller.signal.aborted) return;
    subscription.pumping = true;
    let failed = false;
    void this.pump(subscription).catch(error => {
      failed = true;
      if (!subscription.controller.signal.aborted && !this.lifetime.signal.aborted) this.onError(subscription.threadId, error);
    }).finally(() => {
      subscription.pumping = false;
      // A notification can arrive between the pump resolving and this continuation. Preserve it
      // after a successful pass; a failure needs a new fact/provider change, never a hot retry loop.
      if (!failed && subscription.dirty) this.kick(subscription);
    });
  }

  private async pump(subscription: Subscription): Promise<void> {
    const { signal } = subscription.controller;
    while (subscription.dirty && !signal.aborted) {
      subscription.dirty = false;
      const throughCursor = this.sourceCursor;
      if (throughCursor === undefined) return;
      // Never prefetch past committed facts the single source reader has not processed yet.
      const facts = await this.runtime.observerEvents(subscription.id, subscription.threadId, 64, signal, throughCursor);
      for (const fact of facts) {
        signal.throwIfAborted();
        const pin = subscription.binding.pin();
        try {
          const delivery = parseVarinRunActivityDelivery({ subscriptionId: subscription.id, threadId: subscription.threadId,
            deliveryId: randomUUID(), fact });
          await this.runtime.observerDelivery(subscription.id, subscription.threadId, fact.cursor, 'selected', signal);
          await this.runtime.observerDelivery(subscription.id, subscription.threadId, fact.cursor, 'sent', signal);
          const acknowledgement = parseVarinRunActivityAcknowledgement(await pin.invoke('observe', [delivery as unknown as JsonValue], signal));
          if (acknowledgement.subscriptionId !== delivery.subscriptionId || acknowledgement.deliveryId !== delivery.deliveryId
            || acknowledgement.cursor !== fact.cursor) throw new Error('Activity acknowledgement does not match the exact delivery');
          signal.throwIfAborted();
          if (this.subscriptions.get(subscription.key) !== subscription) throw new Error('Activity subscription was superseded');
          pin.assertAvailable();
          // ACK ADMISSION: the exact receipt and its original pin are valid in this synchronous
          // Host turn. The following request only persists this established fact. Later revocation
          // cannot rewrite it; no new binding is borrowed while awaiting the kernel commit.
          await this.runtime.observerDelivery(subscription.id, subscription.threadId, fact.cursor, 'committed');
        } finally { pin.release(); }
      }
      if (facts.length === 64) subscription.dirty = true;
    }
  }
}
