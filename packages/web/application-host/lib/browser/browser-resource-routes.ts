import { json } from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { BrowserResourceBinding } from '@varin/protocol';
import { ConnectedBrowserOwner, connectorResourceId, type ConnectorExchange } from './browser-connector.js';
import type { BrowserResources } from './browser-resources.js';

export function registerBrowserResourceRoutes(app: Express, resources: BrowserResources, requireAuth: RequestHandler,
  clientId: (request: Request) => Promise<string | undefined>) {
  const prefix = '/api/browser-resources';
  const connectors = new Map<string, ConnectedBrowserOwner>();
  const noStore = (_request: Request, response: Response, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store'); next();
  };
  app.use(prefix, requireAuth, noStore);
  const route = (action: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res) => {
    void action(req, res).catch(error => {
      if (!res.headersSent && !res.destroyed) res.status(409).json({ error: error instanceof Error ? error.message : 'Browser resource is unavailable' });
    });
  };
  const target = (request: Request): BrowserResourceBinding => ({
    browserId: String(request.params.browserId), instanceId: String(request.params.instanceId),
    ...(request.params.pageId ? { pageId: String(request.params.pageId) } : {}),
  });
  const stopOnClose = (response: Response) => {
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    return controller.signal;
  };
  app.get(prefix, route(async (_req, res) => { res.json({ resources: await resources.list() }); }));
  const pages = prefix + '/:browserId/:instanceId/pages';
  app.get(pages, route(async (req, res) => {
    res.json({ pages: await resources.use(target(req), { signal: stopOnClose(res) }, owner => owner.list()) });
  }));
  app.get(pages + '/:pageId', route(async (req, res) => {
    const binding = target(req), signal = stopOnClose(res);
    const view = req.query.view ?? 'overview';
    if (view !== 'structure' && view !== 'overview' && view !== 'screenshot') { res.status(400).json({ error: 'Unknown browser observation view' }); return; }
    const [observation, usage] = await Promise.all([
      resources.use(binding, { signal }, owner => owner.read({ pageId: binding.pageId!, view }, signal)),
      resources.currentUsage(binding, signal),
    ]);
    res.json({ observation, usage });
  }));
  app.post(pages + '/:pageId/:action', route(async (req, res) => {
    const action = req.params.action;
    if (action !== 'takeover' && action !== 'resume' && action !== 'activate') { res.status(400).json({ error: 'Unknown browser resource action' }); return; }
    res.json({ usage: await resources.control(target(req), action) });
  }));
  app.post(prefix + '/connector/exchange', json({ limit: '64mb' }), route(async (req, res) => {
    const client = await clientId(req);
    if (!client) { res.status(403).json({ error: 'A paired client credential is required' }); return; }
    const input = req.body as Partial<ConnectorExchange> | undefined;
    if (!input || typeof input.browserId !== 'string' || !input.browserId || input.browserId.length > 128
      || typeof input.instanceId !== 'string' || !input.instanceId || input.instanceId.length > 128
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 160
      || (input.disconnected !== undefined && typeof input.disconnected !== 'boolean')
      || !Array.isArray(input.capabilities) || input.capabilities.length > 64
      || input.capabilities.some(value => typeof value !== 'string' || value.length > 80)
      || (input.events !== undefined && (!Array.isArray(input.events) || input.events.some(event => !event || typeof event.kind !== 'string')))
      || (input.results !== undefined && (!Array.isArray(input.results) || input.results.some(result => !result || typeof result.id !== 'string' || typeof result.ok !== 'boolean')))) {
      res.status(400).json({ error: 'Invalid browser connector exchange' }); return;
    }
    const id = connectorResourceId(client, input.browserId);
    let owner = connectors.get(id);
    if (!owner) {
      owner = new ConnectedBrowserOwner(id);
      connectors.set(id, owner);
      resources.register(owner, input.label, 'Paired browser');
    }
    const reply = await owner.exchange(input as ConnectorExchange, stopOnClose(res));
    if (!res.destroyed) res.json(reply);
  }));
}
