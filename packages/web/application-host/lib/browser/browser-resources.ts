import { randomUUID } from 'node:crypto';
import {
  BrowserExecutionError, isBrowserExecutionError, type BrowserOwner, type BrowserPageUsage,
  type BrowserResource, type BrowserResourceBinding, type BrowserResourceCapability, type BrowserUseScope,
} from '@varin/protocol';

interface Provider {
  owner: BrowserOwner;
  label: string;
  deviceName: string;
  fallbackInstance: string;
  unsubscribe: () => void;
  remote: boolean;
  dispose: boolean;
  source?: BrowserResource['source'];
}
interface PageLane {
  human: boolean;
  ownerPaused?: boolean;
  stopUnconfirmed?: boolean;
  observationNeeded: boolean;
  observedBy: Set<string>;
  epoch: number;
  active?: { threadId?: string; settled: Promise<void> };
  waiting: { threadId?: string }[];
}
const missing = (message: string) => new BrowserExecutionError(message, 'none');
const builtInCapabilities: BrowserResourceCapability[] = ['tabs', 'open', 'read', 'screenshot', 'act', 'upload', 'download'];

export class BrowserResources {
  private readonly providers = new Map<string, Provider>();
  private readonly lanes = new Map<string, PageLane>();
  private readonly bindings = new Map<string, BrowserResourceBinding>();
  private readonly retainedByThread = new Map<string, Set<string>>();
  private preferences?: (threadId?: string) => Promise<{ task: string | null; default: string | null }>;

  setPreferences(read: NonNullable<BrowserResources['preferences']>) { this.preferences = read; }
  clearBinding(threadId: string) { this.bindings.delete(threadId); }
  binding(threadId: string) { return this.bindings.get(threadId); }
  async unregister(browserId: string) {
    const provider = this.providers.get(browserId);
    if (!provider) return;
    this.providers.delete(browserId);
    provider.unsubscribe();
    if (provider.dispose) await provider.owner.dispose?.();
  }

  private refresh?: () => Promise<void>;
  private refreshLocal?: () => Promise<void>;
  setRefresh(refresh: () => Promise<void>, refreshLocal?: () => Promise<void>) {
    this.refresh = refresh;
    if (refreshLocal) this.refreshLocal = refreshLocal;
  }
  has(browserId: string) { return this.providers.has(browserId); }
  updateMetadata(browserId: string, label: string, deviceName?: string) {
    const provider = this.providers.get(browserId);
    if (provider) { provider.label = label; if (deviceName !== undefined) provider.deviceName = deviceName; }
  }

  register(owner: BrowserOwner, label: string, deviceName: string, options: { remote?: boolean; dispose?: boolean; source?: BrowserResource['source'] } = {}) {
    if (this.providers.has(owner.browserId)) throw new Error('Duplicate browser resource');
    const unsubscribe = owner.subscribe(event => {
      if (event.kind === 'closed') {
        for (const [key, lane] of this.lanes) {
          const [id, , page] = JSON.parse(key) as string[];
          if (id === owner.browserId && page === event.pageId && !lane.active && !lane.waiting.length) this.lanes.delete(key);
        }
      } else if (event.kind === 'page' && event.page.agentPaused !== undefined) {
        const page = event.page;
        for (const [key, lane] of this.lanes) {
          const [id, instanceId, pageId] = JSON.parse(key) as string[];
          if (id !== owner.browserId || pageId !== page.pageId || (page.instanceId && page.instanceId !== instanceId)) continue;
          if (Boolean(lane.ownerPaused) === page.agentPaused) continue;
          lane.ownerPaused = Boolean(page.agentPaused);
          if (owner.pausePage) lane.human = Boolean(page.agentPaused);
          lane.observationNeeded = true;
          lane.observedBy.clear();
          lane.epoch++;
        }
      }
    });
    this.providers.set(owner.browserId, { owner, label, deviceName, fallbackInstance: randomUUID(), unsubscribe, remote: options.remote ?? false, dispose: options.dispose ?? true, source: options.source });
  }
  hasProviders() { return this.providers.size > 0; }
  private async describe(provider: Provider): Promise<BrowserResource> {
    const { owner, label, deviceName, fallbackInstance } = provider;
    const status = await owner.resource?.() ?? { state: 'online' as const, instanceId: fallbackInstance,
      capabilities: [...builtInCapabilities, ...(owner.activate ? ['activate' as const] : [])] };
    return { browserId: owner.browserId, label, deviceName, ...(provider.source ? { source: provider.source } : {}), ...status };
  }
  async list({ localOnly = false, threadId }: { localOnly?: boolean; threadId?: string } = {}) {
    await this.refreshLocal?.();
    if (!localOnly) await this.refresh?.();
    const preferences = threadId ? await this.preferences?.(threadId) : undefined;
    const selected = preferences?.task ?? (threadId ? this.bindings.get(threadId)?.browserId : undefined) ?? preferences?.default;
    return Promise.all([...this.providers.values()].filter(provider => !localOnly || !provider.remote).map(async provider => ({
      ...await this.describe(provider), ...(threadId ? { preferred: provider.owner.browserId === selected } : {}),
    })));
  }
  private key(binding: BrowserResourceBinding) { return JSON.stringify([binding.browserId, binding.instanceId, binding.pageId ?? null]); }
  private lane(binding: BrowserResourceBinding) {
    const key = this.key(binding);
    let lane = this.lanes.get(key);
    if (!lane) { lane = { human: false, observationNeeded: false, observedBy: new Set(), epoch: 0, waiting: [] }; this.lanes.set(key, lane); }
    return lane;
  }
  usage(binding: BrowserResourceBinding): BrowserPageUsage {
    const lane = this.lanes.get(this.key(binding));
    return { controller: lane?.human || lane?.ownerPaused ? 'human' : 'agent',
      ...(lane?.active?.threadId ? { activeThreadId: lane.active.threadId } : {}),
      waitingThreadIds: [...new Set(lane?.waiting.flatMap(item => item.threadId ? [item.threadId] : []) ?? [])] };
  }
  async use<T>(
    target: Partial<BrowserResourceBinding>, scope: BrowserUseScope,
    work: (owner: BrowserOwner, binding: BrowserResourceBinding) => Promise<T>,
    options: { writes?: boolean; observes?: boolean } = {},
  ): Promise<T> {
    scope.signal?.throwIfAborted();
    if (!target.browserId || !this.providers.has(target.browserId)) {
      await this.refreshLocal?.();
      await this.refresh?.();
    }
    const last = scope.threadId ? this.bindings.get(scope.threadId) : undefined;
    const preferences = !target.browserId ? await this.preferences?.(scope.threadId) : undefined;
    const browserId = target.browserId ?? preferences?.task ?? last?.browserId ?? preferences?.default
      ?? (this.providers.size === 1 ? this.providers.keys().next().value : undefined);
    const provider = browserId ? this.providers.get(browserId) : undefined;
    if (!provider) throw missing(browserId ? 'Browser resource not found' : 'Choose a browser from browser_resources');
    let status = await this.describe(provider);
    if (provider.remote && status.state !== 'online') {
      await this.refresh?.();
      status = await this.describe(provider);
    }
    if (status.state !== 'online' || !status.instanceId) throw missing(`Browser is ${status.state}; wait for its owner to reconnect`);
    const expected = target.instanceId ?? (!target.browserId && last && last.browserId === browserId ? last.instanceId : undefined);
    if (expected && expected !== status.instanceId) throw missing('The original browser instance ended. List its current pages before choosing another.');
    if (target.pageId && !expected) throw missing('A page requires its original browser instance');
    const binding = { browserId: provider.owner.browserId, instanceId: status.instanceId,
      ...(target.pageId ? { pageId: target.pageId } : {}) };
    const lane = this.lane(binding);
    const admittedEpoch = lane.epoch;
    const execute = async () => {
      scope.signal?.throwIfAborted();
      const live = await this.describe(provider);
      if (live.state !== 'online' || live.instanceId !== binding.instanceId) throw missing('Browser instance changed before dispatch');
      scope.signal?.throwIfAborted();
      if (options.writes && (lane.human || lane.ownerPaused || lane.epoch !== admittedEpoch)) {
        throw missing(lane.human || lane.ownerPaused ? 'The user is controlling this page' : 'Page control changed while the operation was waiting');
      }
      if (options.writes && lane.stopUnconfirmed) throw missing('The original browser action has not confirmed that input stopped');
      if (options.writes && lane.observationNeeded && !lane.observedBy.has(scope.threadId ?? '')) {
        throw missing('Read the current page before resuming browser input');
      }
      const epoch = lane.epoch;
      if (scope.threadId && provider.remote && (binding.pageId || options.writes)) {
        const retained = this.retainedByThread.get(scope.threadId) ?? new Set<string>();
        retained.add(binding.browserId);
        this.retainedByThread.set(scope.threadId, retained);
      }
      const result = await work(provider.owner.forScope?.(scope, binding) ?? provider.owner, binding);
      if (scope.threadId) this.bindings.set(scope.threadId, binding);
      if (options.observes && scope.threadId && !lane.human && !lane.ownerPaused && lane.epoch === epoch) lane.observedBy.add(scope.threadId);
      return result;
    };
    if (!options.writes) return execute();
    const waiter = { ...(scope.threadId ? { threadId: scope.threadId } : {}) };
    if (lane.human || lane.ownerPaused) throw missing('The user is controlling this page');
    lane.waiting.push(waiter);
    const predecessor = lane.active?.settled;
    // Enqueue synchronously before awaiting; the active tail includes settlement
    // of prior writes. Different page lanes do not share a tail.
    const tailKey = this.key(binding);
    const tail = this.tails.get(tailKey) ?? predecessor ?? Promise.resolve();
    let resolveTail!: () => void;
    const settled = new Promise<void>(resolve => { resolveTail = resolve; });
    const queued = tail.then(() => settled);
    this.tails.set(tailKey, queued);
    try {
      await tail;
      lane.waiting.splice(lane.waiting.indexOf(waiter), 1);
      lane.active = { ...waiter, settled };
      try { return await execute(); }
      catch (error) {
        if (isBrowserExecutionError(error)) {
          if (error.completion) await error.completion.catch(() => undefined);
          if (error.effect === 'unknown') {
            lane.observationNeeded = true; lane.observedBy.clear(); lane.epoch++;
            if (!error.executorStopped && !error.completion) lane.stopUnconfirmed = true;
          }
        }
        throw error;
      } finally { delete lane.active; }
    } finally {
      resolveTail();
      if (this.tails.get(tailKey) === queued) this.tails.delete(tailKey);
    }
  }
  private readonly tails = new Map<string, Promise<void>>();

  async currentUsage(binding: BrowserResourceBinding, signal?: AbortSignal) {
    if (!binding.pageId) throw missing('Choose a page');
    return this.use(binding, signal ? { signal } : {}, owner =>
      owner.pageUsage?.(binding.pageId!) ?? Promise.resolve(this.usage(binding)));
  }

  async control(binding: BrowserResourceBinding, action: 'takeover' | 'resume' | 'activate') {
    if (!binding.pageId) throw missing('Choose a page');
    let remote: BrowserPageUsage | undefined;
    await this.use(binding, {}, async owner => {
      const pageId = binding.pageId!;
      if (owner.controlPage) { remote = await owner.controlPage(pageId, action); return; }
      if (!(await owner.list()).some(page => page.pageId === pageId)) throw missing('Browser page is no longer available');
      const lane = this.lane(binding);
      if (action === 'activate') {
        if (!owner.activate) throw missing('This browser cannot bring the original page to the foreground');
        await owner.activate(pageId);
      } else if (action === 'takeover') {
        lane.human = true;
        lane.epoch++;
        await owner.pausePage?.(pageId, true);
        await lane.active?.settled;
        if (lane.stopUnconfirmed) throw missing('The original action may still be running. Close the tab in its browser before replacing it.');
      } else {
        await lane.active?.settled;
        if (lane.stopUnconfirmed) throw missing('The original action has not confirmed that input stopped');
        await owner.pausePage?.(pageId, false);
        if (lane.human || lane.ownerPaused) {
          lane.human = false;
          if (owner.pausePage) lane.ownerPaused = false;
          lane.observationNeeded = true;
          lane.observedBy.clear();
          lane.epoch++;
        }
      }
    });
    return remote ?? this.usage(binding);
  }
  async releaseLocalResourceThread(binding: BrowserResourceBinding, threadId: string) {
    const provider = this.providers.get(binding.browserId);
    if (!provider || provider.remote) throw missing('The original local browser resource is unavailable');
    const current = await this.describe(provider);
    if (current.state !== 'online') throw missing('The original local browser resource is offline');
    // A replacement browser cannot hold pages from the previous instance.
    if (current.instanceId === binding.instanceId) await provider.owner.releaseThread(threadId);
    if (this.bindings.get(threadId)?.browserId === binding.browserId) this.bindings.delete(threadId);
  }
  async releaseThread(threadId: string) {
    this.bindings.delete(threadId);
    const remote = this.retainedByThread.get(threadId);
    await Promise.all([...this.providers.values()].filter(provider => !provider.remote || remote?.has(provider.owner.browserId)).map(async provider => {
      await provider.owner.releaseThread(threadId);
      remote?.delete(provider.owner.browserId);
    }));
    this.retainedByThread.delete(threadId);
  }
  async dispose() {
    for (const provider of this.providers.values()) provider.unsubscribe();
    await Promise.all([...this.providers.values()].map(provider => provider.dispose ? provider.owner.dispose?.() : undefined));
  }
}
