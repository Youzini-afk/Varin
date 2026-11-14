import { createHash } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { BROWSER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import {
  BrowserExecutionError, isBrowserExecutionError, type BrowserAction, type BrowserActionResult,
  type BrowserEvent, type BrowserObservation, type BrowserOwner, type BrowserPage,
  type BrowserPageUsage, type BrowserReadRequest, type BrowserResource, type BrowserResourceBinding,
  type BrowserResourceCapability, type BrowserUseScope,
} from '@varin/protocol';
import { ManagedTargetClient, managedEndpointIdentity, type ManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import type { ManagedHostSourceOwner } from '../harness/managed-remote-types.js';
import { compileToolJsonSchema } from '../models/schema.js';
import type { BrowserResources } from './browser-resources.js';
import type { BrowserManagementSnapshot, BrowserSettingsSnapshot } from '@varin/protocol';
import type { BrowserSettingsOwner } from './browser-settings.js';
import { probeBrowserConnection } from './browser-settings.js';

const base = '/api/harness/managed-execution/v1/browser';
const relative = '/browser';
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const oneOf = (value: unknown, choices: readonly string[]): value is string => typeof value === 'string' && choices.includes(value);
const invalid = (message: string) => new BrowserExecutionError(message, 'none');
const capabilities: BrowserResourceCapability[] = ['tabs', 'open', 'read', 'screenshot', 'act', 'upload', 'download', 'activate'];
const methods = ['list', 'open', 'read', 'act', 'activate', 'controlPage', 'usage', 'downloads', 'readDownload', 'releaseDownload', 'upload', 'releaseThread'] as const;
type Method = typeof methods[number];
interface Call {
  coordinatorHostId: string;
  browserId: string;
  instanceId: string;
  method: Method;
  args: unknown[];
  threadId?: string;
}
const inputValidators = new Map(BROWSER_TOOL_DECLARATIONS.map(item => [item.id.slice('varin.browser.'.length), compileToolJsonSchema(item.tool!.inputSchema)]));
const exact = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const bytes = (value: unknown): value is string => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

function parseCall(value: unknown): Call {
  if (!object(value) || !exact(value, ['coordinatorHostId', 'browserId', 'instanceId', 'method', 'args', 'threadId'])
    || !text(value.coordinatorHostId) || !text(value.browserId) || !text(value.instanceId)
    || !methods.includes(value.method as Method) || !Array.isArray(value.args)
    || value.threadId !== undefined && !text(value.threadId)) throw invalid('Invalid managed browser request');
  const { method, args } = value;
  const [first, second, third] = args;
  let valid = false;
  switch (method) {
    case 'list': valid = args.length === 0; break;
    case 'open': case 'read': valid = args.length === 1 && object(first)
      && !('browserId' in first) && !('instanceId' in first) && !!inputValidators.get(method)?.(first); break;
    case 'act': valid = args.length === 2 && text(first) && object(second) && !('pageId' in second)
      && !('browserId' in second) && !('instanceId' in second) && !!inputValidators.get('act')?.({ ...second, pageId: first }); break;
    case 'activate': case 'usage': case 'downloads': valid = args.length === 1 && text(first); break;
    case 'controlPage': valid = args.length === 2 && text(first) && oneOf(second, ['takeover', 'resume', 'activate']); break;
    case 'readDownload': case 'releaseDownload': valid = args.length === 2 && text(first) && text(second); break;
    case 'upload': valid = args.length === 3 && text(first) && text(second) && Array.isArray(third) && third.length > 0
      && third.every(file => object(file) && exact(file, ['name', 'bytesBase64']) && text(file.name) && bytes(file.bytesBase64)); break;
    case 'releaseThread': valid = args.length === 0 && text(value.threadId); break;
  }
  if (!valid) throw invalid('Invalid managed browser method arguments');
  return value as unknown as Call;
}
function pageIdOf(call: Call): string | undefined {
  if (call.method === 'open' || call.method === 'read') return (call.args[0] as { pageId?: string }).pageId;
  if (call.method === 'list' || call.method === 'releaseThread') return undefined;
  return call.args[0] as string;
}
function writes(call: Pick<Call, 'method' | 'args'>) {
  return ['open', 'activate', 'controlPage', 'upload', 'releaseDownload', 'releaseThread'].includes(call.method)
    || call.method === 'act' && (call.args[1] as BrowserAction).action !== 'wait';
}
function supported(resource: BrowserResource, method: Method, args: unknown[]) {
  const capability = method === 'list' ? 'tabs' : ['downloads', 'readDownload', 'releaseDownload'].includes(method) ? 'download'
    : method === 'read' && (args[0] as BrowserReadRequest).view === 'screenshot' ? 'screenshot' : method;
  if (method === 'usage' || method === 'controlPage' || method === 'releaseThread') return true;
  if (!resource.capabilities.includes(capability as BrowserResourceCapability)) return false;
  if (!resource.operations || ['downloads', 'readDownload', 'releaseDownload', 'upload'].includes(method)) return true;
  if (method === 'act') {
    const action = args[1] as BrowserAction;
    if (action.action === 'click' && 'point' in action && text(action.observationId)
      && resource.operations.includes('act:click:point')) return true;
    if (action.action === 'type' && !action.ref && !action.replace
      && resource.operations.includes('act:type:focused')) return true;
  }
  return resource.operations.includes(method)
    || method === 'act' && resource.operations.includes(`act:${(args[1] as BrowserAction).action}`)
    || method === 'read' && resource.operations.includes(`read:${(args[0] as BrowserReadRequest).view ?? 'overview'}`);
}
function validateReceipt(value: unknown, call: Call) {
  const page = (item: unknown) => object(item) && item.browserId === call.browserId && text(item.pageId)
    && (item.instanceId === undefined || item.instanceId === call.instanceId)
    && typeof item.title === 'string' && typeof item.url === 'string'
    && ['loading', 'canGoBack', 'canGoForward', 'retained'].every(key => typeof item[key] === 'boolean')
    && (!pageIdOf(call) || item.pageId === pageIdOf(call));
  const download = (item: unknown) => object(item) && text(item.downloadId) && item.pageId === pageIdOf(call)
    && typeof item.name === 'string' && typeof item.url === 'string' && typeof item.receivedBytes === 'number'
    && oneOf(item.state, ['progressing', 'completed', 'cancelled', 'interrupted']);
  switch (call.method) {
    case 'list': return Array.isArray(value) && value.every(page);
    case 'open': return page(value);
    case 'act': case 'upload': return object(value) && page(value.page)
      && value.action === (call.method === 'upload' ? 'upload' : (call.args[1] as BrowserAction).action)
      && (value.downloads === undefined || Array.isArray(value.downloads) && value.downloads.every(download));
    case 'read': return object(value) && page(value.page) && text(value.observationId) && object(value.viewport)
      && ['width', 'height', 'scale'].every(key => typeof (value.viewport as Record<string, unknown>)[key] === 'number') && Array.isArray(value.frames);
    case 'usage': case 'controlPage': return object(value) && oneOf(value.controller, ['human', 'agent'])
      && Array.isArray(value.waitingThreadIds) && value.waitingThreadIds.every(text)
      && (value.activeThreadId === undefined || text(value.activeThreadId));
    case 'downloads': return Array.isArray(value) && value.every(download);
    case 'readDownload': return object(value) && text(value.name) && bytes(value.bytesBase64);
    default: return value === null;
  }
}

/** The authenticated client and coordinator together form a foreign namespace.
 * A peer-supplied Thread/Run is never treated as a local runtime authorization. */
export function managedBrowserThread(clientId: string, coordinatorHostId: string, threadId: string) {
  return `managed-browser:${hash([clientId, coordinatorHostId, threadId])}`;
}

export function registerManagedBrowserRoutes(app: Express, options: {
  hostId: string; resources: BrowserResources; requireAuth: RequestHandler;
  settings?: BrowserSettingsOwner;
  clientId(request: Request): Promise<string | undefined>;
}) {
  const principals = new WeakMap<Request, string>();
  const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res) => {
    void handler(req, res).catch(error => {
      if (!res.headersSent && !res.destroyed) res.status(409).json({
        error: error instanceof Error ? error.message : 'Browser resource is unavailable',
        effect: isBrowserExecutionError(error) ? error.effect : 'none',
        executorStopped: isBrowserExecutionError(error) ? error.executorStopped : true,
      });
    });
  };
  app.use(base, options.requireAuth, (req, res, next) => {
    res.setHeader('X-Varin-Managed-Host', options.hostId);
    res.setHeader('Cache-Control', 'no-store');
    void options.clientId(req).then(clientId => {
      if (!clientId) { res.status(403).json({ error: 'A paired Host credential is required', effect: 'none', executorStopped: true }); return; }
      principals.set(req, clientId); next();
    }).catch(next);
  });
  app.get(`${base}/resources`, route(async (_req, res) => {
    // Never publish imported peers: discovery and dispatch are strictly one hop.
    res.json({ resources: await options.resources.list({ localOnly: true }) });
  }));
  app.get(`${base}/configuration`, route(async (_req, res) => {
    if (!options.settings) throw invalid('Browser connection management is unavailable');
    res.json({ settings: await options.settings.read(), resources: await options.resources.list({ localOnly: true }) });
  }));
  app.put(`${base}/configuration`, route(async (req, res) => {
    if (!options.settings || typeof req.body?.revision !== 'string') throw invalid('Browser settings revision is required');
    const settings = await options.settings.save(req.body.revision, req.body);
    res.json({ settings, resources: await options.resources.list({ localOnly: true }) });
  }));
  app.post(`${base}/probe`, route(async (req, res) => { res.json(await probeBrowserConnection(req.body)); }));
  app.post(`${base}/call`, route(async (req, res) => {
    const call = parseCall(req.body);
    const resource = (await options.resources.list({ localOnly: true })).find(item => item.browserId === call.browserId);
    if (!resource) throw invalid('The original local browser resource is unavailable');
    if (!supported(resource, call.method, call.args)) throw invalid('The browser provider does not support this operation');
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    const pageId = pageIdOf(call), binding = { browserId: call.browserId, instanceId: call.instanceId, ...(pageId ? { pageId } : {}) };
    const threadId = call.threadId ? managedBrowserThread(principals.get(req)!, call.coordinatorHostId, call.threadId) : undefined;
    const mutates = writes(call);
    let dispatched = false;
    try {
      let value: unknown;
      if (call.method === 'releaseThread') { dispatched = true; await options.resources.releaseLocalResourceThread(binding, threadId!); value = null; }
      else if (call.method === 'controlPage') { dispatched = true; value = await options.resources.control(binding, call.args[1] as 'takeover' | 'resume' | 'activate'); }
      else if (call.method === 'usage') value = await options.resources.currentUsage(binding);
      else value = await options.resources.use(binding, { ...(threadId ? { threadId } : {}), signal: controller.signal }, async owner => {
        // A disconnected observer must not release an already-dispatched writer.
        const signal = mutates ? undefined : controller.signal;
        if (pageId && threadId) owner.retainForThread(pageId, threadId);
        dispatched = true;
        switch (call.method) {
          case 'list': return owner.list();
          case 'open': return owner.open(call.args[0] as Parameters<BrowserOwner['open']>[0], { ...(threadId ? { threadId } : {}) });
          case 'read': return owner.read(call.args[0] as BrowserReadRequest, signal);
          case 'act': return owner.act(pageId!, call.args[1] as BrowserAction, signal);
          case 'activate': if (!owner.activate) throw invalid('This browser cannot activate pages'); await owner.activate(pageId!); return null;
          case 'downloads': return owner.downloads(pageId!);
          case 'readDownload': {
            const download = await owner.readDownload(pageId!, call.args[1] as string, signal);
            return { name: download.name, bytesBase64: Buffer.from(download.bytes).toString('base64') };
          }
          case 'releaseDownload': await owner.releaseDownload(pageId!, call.args[1] as string); return null;
          case 'upload': return owner.upload(pageId!, call.args[1] as string,
            (call.args[2] as { name: string; bytesBase64: string }[]).map(file => ({ name: file.name, bytes: Buffer.from(file.bytesBase64, 'base64') })));
        }
      }, { writes: mutates, observes: call.method === 'read' });
      if (!res.destroyed) res.json({ value });
    } catch (error) {
      if (isBrowserExecutionError(error)) {
        if (error.completion) await error.completion.catch(() => undefined);
        throw new BrowserExecutionError(error, error.effect, error.executorStopped || !!error.completion);
      }
      throw new BrowserExecutionError(error, dispatched && mutates ? 'unknown' : 'none');
    } finally { res.off('close', close); }
  }));
}

/** A browser identity retains the full authenticated route, not only Host ID. */
export function managedBrowserResourceId(peer: ManagedHostSourceOwner, remoteBrowserId: string) {
  return `managed-browser:${hash([peer.hostId, peer.connectionId, peer.endpointIdentity, remoteBrowserId])}`;
}
function catalog(value: unknown): BrowserResource[] {
  if (!object(value) || !Array.isArray(value.resources)) throw invalid('Invalid managed browser catalog');
  const seen = new Set<string>();
  for (const item of value.resources) {
    if (!object(item) || !text(item.browserId) || seen.has(item.browserId) || !text(item.label) || !text(item.deviceName)
      || !oneOf(item.state, ['disconnected', 'connecting', 'online', 'interrupted', 'ended'])
      || item.instanceId !== undefined && !text(item.instanceId)
      || item.state === 'online' && !text(item.instanceId)
      || !Array.isArray(item.capabilities) || item.capabilities.some(capability => !capabilities.includes(capability))
      || item.operations !== undefined && (!Array.isArray(item.operations) || !item.operations.every(text))) throw invalid('Invalid managed browser catalog');
    seen.add(item.browserId);
  }
  return value.resources as BrowserResource[];
}

type Peers = Pick<ManagedRemoteTargetRegistry, 'browserTargets' | 'forwardTarget'>;
export class ManagedBrowserOwner implements BrowserOwner {
  readonly browserId: string;
  private status: BrowserResource;
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private disposed = false;
  constructor(private readonly coordinatorHostId: string, readonly peer: ManagedHostSourceOwner, resource: BrowserResource,
    private readonly targets: Peers, private readonly fetchImpl: typeof fetch = fetch) {
    this.browserId = managedBrowserResourceId(peer, resource.browserId);
    this.status = resource;
  }
  update(resource: BrowserResource) {
    if (resource.browserId !== this.status.browserId) throw invalid('Managed browser identity changed');
    const changed = resource.state !== this.status.state || resource.instanceId !== this.status.instanceId;
    this.status = resource;
    if (changed) this.emitConnection();
  }
  interrupt() { if (this.status.state !== 'interrupted') { this.status = { ...this.status, state: 'interrupted' }; this.emitConnection(); } }
  private emitConnection() {
    for (const listener of this.listeners) listener({ kind: 'connection', browserId: this.browserId, state: this.status.state,
      ...(this.status.instanceId ? { instanceId: this.status.instanceId } : {}) });
  }
  async resource() { const { state, instanceId, capabilities, operations } = this.status; return { state,
    ...(instanceId ? { instanceId } : {}), capabilities: [...capabilities], ...(operations ? { operations: [...operations] } : {}) }; }
  private async request<T>(instanceId: string, method: Method, args: unknown[], scope: BrowserUseScope = {}): Promise<T> {
    if (this.disposed || this.status.state !== 'online') throw invalid('The original managed browser is offline');
    if (instanceId !== this.status.instanceId) throw invalid('The original managed browser instance ended');
    if (!supported(this.status, method, args)) throw invalid('The browser provider does not support this operation');
    const mutates = writes({ method, args });
    let dispatched = false;
    try {
      scope.signal?.throwIfAborted();
      const target = await this.targets.forwardTarget(this.peer, scope.signal);
      scope.signal?.throwIfAborted();
      const client = new ManagedTargetClient(target, this.fetchImpl);
      const call: Call = { coordinatorHostId: this.coordinatorHostId, browserId: this.status.browserId,
        instanceId, method, args, ...(scope.threadId ? { threadId: scope.threadId } : {}) };
      // Mutation response lifetime is independent of the caller's cancellation.
      dispatched = true;
      const response = await client.response(`${relative}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call), ...(!mutates && scope.signal ? { signal: scope.signal } : {}) }, true);
      const reply: unknown = await response.json();
      if (!response.ok) {
        if (!object(reply) || typeof reply.error !== 'string') throw new Error('Managed browser operation returned no receipt');
        throw new BrowserExecutionError(reply.error, reply.effect === 'none' ? 'none' : mutates ? 'unknown' : 'none', reply.executorStopped === true);
      }
      if (!object(reply) || !('value' in reply) || !validateReceipt(reply.value, call)) throw new Error('Managed browser operation returned no valid receipt');
      return reply.value as T;
    } catch (error) {
      if (isBrowserExecutionError(error)) throw error;
      if (dispatched) this.interrupt();
      throw new BrowserExecutionError(error, dispatched && mutates ? 'unknown' : 'none', !dispatched || !mutates);
    }
  }
  private port(instanceId = this.status.instanceId ?? '', scope: BrowserUseScope = {}): BrowserOwner {
    const request = <T>(method: Method, args: unknown[], signal?: AbortSignal, threadId = scope.threadId) =>
      this.request<T>(instanceId, method, args, { ...scope, ...(signal ? { signal } : {}), ...(threadId ? { threadId } : {}) });
    const page = (value: BrowserPage) => ({ ...value, browserId: this.browserId });
    return {
      browserId: this.browserId,
      resource: () => this.resource(),
      list: async () => (await request<BrowserPage[]>('list', [])).map(page),
      open: async (input, openScope) => page(await request<BrowserPage>('open', [input], openScope.signal, openScope.threadId)),
      read: async (input, signal) => { const result = await request<BrowserObservation>('read', [input], signal); return { ...result, page: page(result.page) }; },
      act: async (pageId, action, signal) => { const result = await request<BrowserActionResult>('act', [pageId, action], signal); return { ...result, page: page(result.page) }; },
      activate: async pageId => { await request('activate', [pageId]); },
      controlPage: (pageId, action) => request<BrowserPageUsage>('controlPage', [pageId, action]),
      pageUsage: pageId => request<BrowserPageUsage>('usage', [pageId]),
      downloads: pageId => request('downloads', [pageId]),
      readDownload: async (pageId, downloadId, signal) => {
        const result = await request<{ name: string; bytesBase64: string }>('readDownload', [pageId, downloadId], signal);
        if (!text(result.name) || !bytes(result.bytesBase64)) throw invalid('Invalid managed browser download receipt');
        return { name: result.name, bytes: Buffer.from(result.bytesBase64, 'base64') };
      },
      releaseDownload: async (pageId, downloadId) => { await request('releaseDownload', [pageId, downloadId]); },
      upload: async (pageId, ref, files, signal) => {
        const result = await request<BrowserActionResult>('upload', [pageId, ref,
          files.map(file => ({ name: file.name, bytesBase64: Buffer.from(file.bytes).toString('base64') }))], signal);
        return { ...result, page: page(result.page) };
      },
      retainForThread() { /* Each scoped call retains its page at the original owner. */ },
      releaseThread: async threadId => { await request('releaseThread', [], undefined, threadId); },
      subscribe: listener => this.subscribe(listener),
    };
  }
  forScope(scope: BrowserUseScope, binding: BrowserResourceBinding) { return this.port(binding.instanceId, scope); }
  list: BrowserOwner['list'] = () => this.port().list();
  open: BrowserOwner['open'] = (input, scope) => this.port().open(input, scope);
  read: BrowserOwner['read'] = (input, signal) => this.port().read(input, signal);
  act: BrowserOwner['act'] = (pageId, action, signal) => this.port().act(pageId, action, signal);
  activate = (pageId: string) => this.port().activate!(pageId);
  controlPage = (pageId: string, action: 'takeover' | 'resume' | 'activate') => this.port().controlPage!(pageId, action);
  pageUsage = (pageId: string) => this.port().pageUsage!(pageId);
  downloads: BrowserOwner['downloads'] = pageId => this.port().downloads(pageId);
  readDownload: BrowserOwner['readDownload'] = (pageId, downloadId, signal) => this.port().readDownload(pageId, downloadId, signal);
  releaseDownload: BrowserOwner['releaseDownload'] = (pageId, downloadId) => this.port().releaseDownload(pageId, downloadId);
  upload: BrowserOwner['upload'] = (pageId, ref, files, signal) => this.port().upload(pageId, ref, files, signal);
  retainForThread() {}
  releaseThread: BrowserOwner['releaseThread'] = threadId => this.port().releaseThread(threadId);
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async dispose() { this.disposed = true; this.interrupt(); this.listeners.clear(); }
}

/** Keeps offline records and their original provenance; only discovery retries. */
export class ManagedBrowserPeers {
  private readonly owners = new Map<string, ManagedBrowserOwner>();
  private flight?: Promise<void>;
  constructor(private readonly coordinatorHostId: string, private readonly resources: BrowserResources,
    private readonly targets: Peers & Pick<ManagedRemoteTargetRegistry, 'selectForwardTarget'>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async client(connectionId: string) {
    return new ManagedTargetClient(await this.targets.selectForwardTarget(connectionId), this.fetchImpl);
  }
  async configuration(connectionId: string, value?: BrowserSettingsSnapshot): Promise<BrowserManagementSnapshot> {
    const client = await this.client(connectionId);
    const result = await (value ? client.json<BrowserManagementSnapshot>(`${relative}/configuration`, value, 'PUT') : client.request<BrowserManagementSnapshot>(`${relative}/configuration`));
    const peer = { kind: 'managed_host' as const, hostId: client.target.hostId, connectionId,
      endpointIdentity: managedEndpointIdentity(client.target.connection) };
    return { ...result, viewBrowserIds: Object.fromEntries(result.resources.map(resource => [resource.browserId, managedBrowserResourceId(peer, resource.browserId)])) };
  }
  async probe(connectionId: string, value: unknown) {
    return (await this.client(connectionId)).json(`${relative}/probe`, value);
  }
  refresh(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.discover().finally(() => { delete this.flight; });
    return this.flight;
  }
  private async discover() {
    const seen = new Set<string>();
    const { targets } = await this.targets.browserTargets();
    await Promise.all(targets.map(async target => {
      try {
        const client = new ManagedTargetClient(await this.targets.forwardTarget(target.resourceOwner), this.fetchImpl);
        const resources = catalog(await client.request(`${relative}/resources`));
        for (const resource of resources) {
          const id = managedBrowserResourceId(target.resourceOwner, resource.browserId);
          seen.add(id);
          let owner = this.owners.get(id);
          if (!owner) {
            owner = new ManagedBrowserOwner(this.coordinatorHostId, target.resourceOwner, resource, this.targets, this.fetchImpl);
            this.owners.set(id, owner);
            this.resources.register(owner, resource.label, `${target.label} · ${resource.deviceName}`, { remote: true, source: resource.source });
          } else { owner.update(resource); this.resources.updateMetadata(id, resource.label, `${target.label} · ${resource.deviceName}`); }
        }
      } catch { /* An unavailable peer never erases the original resource binding. */ }
    }));
    for (const [id, owner] of this.owners) if (!seen.has(id)) owner.interrupt();
  }
}
