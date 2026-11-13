import { randomUUID } from 'node:crypto';
import {
  BrowserExecutionError, type BrowserAction, type BrowserActionResult, type BrowserEvent, type BrowserObservation,
  type BrowserOwner, type BrowserPage, type BrowserProviderStatus, type BrowserReadRequest, type BrowserResourceBinding, type BrowserUseScope,
  type ComputerBrowserParams, type ComputerBrowserResult,
} from '@varin/protocol';
import { ComputerBeforeDispatchError, ComputerEffectError, type ComputerService } from '../computer/computer-service.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';

type Scope = BrowserUseScope & { binding: BrowserResourceBinding };
type Options = { computers: ComputerService; runtime: Pick<AgentRuntimeClient, 'run'> };
type Shared = {
  instanceId?: string;
  pages: Map<string, BrowserPage>;
  observations: Map<string, { pageId: string; instanceId: string; documentId: string }>;
  listeners: Set<(event: BrowserEvent) => void>;
};
const unavailable = (message: string) => new BrowserExecutionError(message, 'none');
const operations = ['list', 'open', 'read:overview', 'read:text', 'read:structure', 'read:find', 'read:screenshot',
  'act:navigate', 'act:evaluate', 'act:click:point', 'act:type:focused'];

/** Adapts the original Linux browser, not a second CDP connection or process.
 * ComputerService remains the only writer: its native execution admission,
 * desktop queue, physical-control gate, driver lifetime and journal all apply.
 * Missing Linux driver features remain explicit, never emulated with scripts.
 */
export class LinuxBrowserOwner implements BrowserOwner {
  readonly browserId: string;
  constructor(private readonly options: Options, readonly desktopId: string, private readonly shared: Shared = {
    pages: new Map(), observations: new Map(), listeners: new Set(),
  }, private readonly scope?: Scope) { this.browserId = `linux-desktop:${desktopId}`; }

  forScope(scope: BrowserUseScope, binding: BrowserResourceBinding): BrowserOwner {
    return new LinuxBrowserOwner(this.options, this.desktopId, this.shared, { ...scope, binding });
  }
  subscribe(listener: (event: BrowserEvent) => void) { this.shared.listeners.add(listener); return () => { this.shared.listeners.delete(listener); }; }
  private emit(event: BrowserEvent) { for (const listener of this.shared.listeners) listener(event); }
  private rememberInstance(instanceId: string) {
    if (this.shared.instanceId && this.shared.instanceId !== instanceId) {
      for (const pageId of this.shared.pages.keys()) this.emit({ kind: 'closed', pageId });
      this.shared.pages.clear(); this.shared.observations.clear();
    }
    this.shared.instanceId = instanceId;
  }

  private async call(params: ComputerBrowserParams, writes = false, signal?: AbortSignal): Promise<ComputerBrowserResult> {
    const expectedInstanceId = this.scope?.binding.instanceId ?? this.shared.instanceId;
    const scope = this.scope;
    const supplied = [scope?.signal, signal].filter((item): item is AbortSignal => Boolean(item));
    const callerSignal = supplied.length ? AbortSignal.any(supplied) : undefined;
    callerSignal?.throwIfAborted();
    let entered = false;
    const execute = async () => {
      const admission = this.options.computers.automation.context.getStore();
      const signal = admission ? AbortSignal.any([admission.signal, ...(callerSignal ? [callerSignal] : [])]) : callerSignal;
      signal?.throwIfAborted();
      entered = true;
      const result = await this.options.computers.browser({ ...params, desktopId: this.desktopId, ...(signal ? { signal } : {}),
        ...(params.op !== 'status' && expectedInstanceId ? { expectedInstanceId } : {}) });
      if (!result.ok) throw new BrowserExecutionError(result.error ?? 'Linux browser operation was not completed',
        writes && result.receipt.effect !== 'none' ? 'unknown' : 'none', result.inputWriterStopped);
      if (params.op !== 'status') {
        if (!result.instanceId || expectedInstanceId && result.instanceId !== expectedInstanceId) {
          throw new BrowserExecutionError('The Linux driver did not confirm the original browser instance', writes ? 'unknown' : 'none', result.inputWriterStopped);
        }
        this.rememberInstance(result.instanceId);
      }
      return result;
    };
    try {
      // No model scope means an authenticated workbench read, never an implicit
      // root actor or a made-up Run. Peer Thread aliases cannot acquire a lease.
      if (!scope?.runId) {
        if (writes) throw unavailable('Linux browser input requires its original native execution authority; remote aliases cannot control the desktop');
        return await execute();
      }
      if (!scope.threadId) throw unavailable('This Linux browser requires its original native Thread assignment');
      const run = await this.options.runtime.run(scope.runId, callerSignal);
      if (run.thread_id !== scope.threadId) throw unavailable('The browser invocation no longer belongs to its original Thread');
      const work = { runtime: 'agent' as const, threadId: scope.threadId, branchId: run.branch_id };
      return await this.options.computers.automation.authorize(work, writes ? 'control' : 'observe', this.desktopId, execute, { work, runId: scope.runId });
    } catch (error) {
      if (error instanceof BrowserExecutionError) throw error;
      if (error instanceof ComputerBeforeDispatchError) throw unavailable(error.message);
      if (error instanceof ComputerEffectError) throw new BrowserExecutionError(error, writes ? 'unknown' : 'none', error.inputWriterStopped);
      throw new BrowserExecutionError(error, entered && writes ? 'unknown' : 'none');
    }
  }

  async resource(): Promise<BrowserProviderStatus> {
    const capabilities: BrowserProviderStatus['capabilities'] = ['tabs', 'open', 'read', 'screenshot', 'act'];
    try {
      const result = await this.call({ op: 'status' });
      if (!result.status?.running || !result.status.instanceId) return { state: 'disconnected', capabilities, operations };
      this.rememberInstance(result.status.instanceId);
      return { state: 'online', instanceId: result.status.instanceId, capabilities, operations };
    } catch { return { state: 'interrupted', ...(this.shared.instanceId ? { instanceId: this.shared.instanceId } : {}), capabilities, operations }; }
  }

  async list(): Promise<BrowserPage[]> {
    const result = await this.call({ op: 'tabs' });
    if (!Array.isArray(result.tabs)) throw unavailable('Linux browser returned no page inventory');
    const seen = new Set<string>();
    for (const tab of result.tabs) {
      const page: BrowserPage = { browserId: this.browserId, pageId: tab.id, title: tab.title ?? '', url: tab.url ?? '',
        loading: false, canGoBack: false, canGoForward: false, retained: true };
      seen.add(tab.id);
      const old = this.shared.pages.get(tab.id);
      if (old && old.url !== page.url) this.forgetObservations(tab.id);
      this.shared.pages.set(tab.id, page);
      this.emit({ kind: 'page', page });
    }
    for (const pageId of this.shared.pages.keys()) if (!seen.has(pageId)) {
      this.shared.pages.delete(pageId); this.forgetObservations(pageId); this.emit({ kind: 'closed', pageId });
    }
    return [...this.shared.pages.values()];
  }
  private async page(pageId: string): Promise<BrowserPage> {
    const page = (await this.list()).find(page => page.pageId === pageId);
    if (!page) throw unavailable('The original browser page is no longer available');
    return page;
  }
  private forgetObservations(pageId: string) {
    for (const [id, observation] of this.shared.observations) if (observation.pageId === pageId) this.shared.observations.delete(id);
  }
  async open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal }): Promise<BrowserPage> {
    const result = await this.call({ op: 'act', ...(input.pageId ? { tabId: input.pageId } : {}),
      act: { kind: input.pageId ? 'navigate' : 'new_tab', url: input.url } }, true, scope.signal);
    const pageId = result.tab;
    if (!pageId) throw new BrowserExecutionError('The browser opened a page but its target identity was not confirmed', 'unknown');
    this.forgetObservations(pageId);
    try { return await this.page(pageId); }
    catch (error) { throw new BrowserExecutionError(error, 'unknown'); }
  }
  async read(input: BrowserReadRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    if (input.ref || input.frameId) throw unavailable('This Linux bridge reads the complete page; element references and frame selection are unavailable');
    const page = await this.page(input.pageId);
    const result = await this.call({ op: 'snapshot', tabId: input.pageId, structured: true, screenshot: input.view === 'screenshot' }, false, signal);
    if (!result.observation || !result.instanceId) throw unavailable('The Linux driver does not support identity-pinned browser observations');
    const observationId = randomUUID();
    // Keep the latest sample per page. The Python owner rechecks the actual
    // frame/loader/URL inside the queued input request, after any human changes.
    this.forgetObservations(input.pageId);
    this.shared.observations.set(observationId, { pageId: input.pageId, instanceId: result.instanceId, documentId: result.observation.documentId });
    const { documentId: _document, ...observation } = result.observation;
    const offset = input.offset ?? 0;
    const elements = input.view === 'find' ? observation.elements.filter(element =>
      `${element.role} ${element.name ?? ''} ${element.value ?? ''}`.toLocaleLowerCase().includes((input.query ?? '').toLocaleLowerCase())) : observation.elements;
    const limit = input.limit ?? 600;
    const total = elements.length;
    return { page, observationId, ...observation, elements: elements.slice(offset, offset + limit),
      ...(input.view === 'text' || input.view === 'overview' || !input.view ? { text: (result.lines ?? []).join('\n') } : {}),
      offset, total, ...(offset + limit < total ? { nextOffset: offset + limit } : {}) };
  }
  async act(pageId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    let act: NonNullable<ComputerBrowserParams['act']>;
    let expectedDocumentId: string | undefined;
    switch (action.action) {
      case 'navigate': act = { kind: 'navigate', url: action.url }; break;
      case 'evaluate':
        if (action.frameId) throw unavailable('This Linux bridge cannot evaluate in a selected frame');
        act = { kind: 'evaluate', expression: action.script }; break;
      case 'type':
        if (action.ref || action.replace) throw unavailable('This Linux bridge supports typing into the current focus only; ref/replace is unavailable');
        act = { kind: 'type', text: action.text }; break;
      case 'click': {
        if (!('point' in action)) throw unavailable('This Linux bridge supports observation-pinned point clicks, not element references');
        const observation = this.shared.observations.get(action.observationId);
        const instanceId = this.scope?.binding.instanceId ?? this.shared.instanceId;
        if (!observation || observation.pageId !== pageId || observation.instanceId !== instanceId) throw unavailable('Read this page again before using screen coordinates');
        expectedDocumentId = observation.documentId;
        act = { kind: 'click', x: action.point.x, y: action.point.y }; break;
      }
      default: throw unavailable(`The Linux bridge does not support ${action.action}; inspect this resource's operations`);
    }
    await this.page(pageId);
    const result = await this.call({ op: 'act', tabId: pageId, act, ...(expectedDocumentId ? { expectedDocumentId } : {}) }, true, signal);
    this.forgetObservations(pageId);
    try { return { page: await this.page(pageId), action: action.action,
      method: action.action === 'evaluate' ? 'page-script' : action.action === 'navigate' ? 'dom-control' : 'native-input',
      ...(result.result !== undefined ? { value: result.result } : {}) }; }
    catch (error) { throw new BrowserExecutionError(error, 'unknown'); }
  }
  async downloads(): Promise<never> { throw unavailable('This Linux bridge does not expose browser downloads'); }
  async readDownload(): Promise<never> { throw unavailable('This Linux bridge does not transfer browser download files'); }
  async releaseDownload(): Promise<never> { throw unavailable('This Linux bridge does not own a browser download cache'); }
  async upload(): Promise<never> { throw unavailable('This Linux bridge does not support browser file uploads'); }
  retainForThread() { /* User-owned visible pages are already retained by their original browser. */ }
  async releaseThread() { /* Releasing a browser binding must not close the user's pages or a desktop lease. */ }
}

/** Refresh discovery on the original computer catalog. Offline registrations
 * remain in the BrowserResources registry; unsupported drivers never appear.
 * Remote desktops are discovered through their authenticated browser Host,
 * not also as a second local browser identity.
 */
export function createLinuxBrowserResources(options: Options) {
  const owners = new Map<string, LinuxBrowserOwner>();
  return {
    async discover() {
      const inventory = await options.computers.list({ localOnly: true });
      return inventory.desktops.flatMap(desktop => {
        const machine = inventory.machines.find(machine => machine.id === desktop.machineId);
        if (desktop.remote || machine?.platform !== 'linux' || desktop.capabilities?.applicationTools?.browser !== true) return [];
        let owner = owners.get(desktop.id);
        if (!owner) { owner = new LinuxBrowserOwner(options, desktop.id); owners.set(desktop.id, owner); }
        return [{ owner, label: `${desktop.label} · Chromium`, deviceName: machine.name }];
      });
    },
  };
}
