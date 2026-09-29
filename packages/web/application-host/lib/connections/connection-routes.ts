import type { Express, RequestHandler } from 'express';
import { HostSshManager } from './ssh-manager.js';
import { readHostConnections, writeHostConnections } from './hosts.js';

export function registerConnectionRoutes(app: Express, ssh: HostSshManager, requireAuth: RequestHandler): void {
  const route = (method: 'get' | 'post' | 'put' | 'delete', path: string, handle: (request: import('express').Request) => unknown | Promise<unknown>) => {
    app[method](`/api/connections${path}`, requireAuth, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      try { response.json(await handle(request) ?? { ok: true }); }
      catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Connection operation failed' }); }
    });
  };
  route('get', '/hosts', () => readHostConnections(ssh.settingsStore));
  route('put', '/hosts', (request) => writeHostConnections(ssh.settingsStore, request.body));
  route('get', '/ssh', () => ssh.readInstances());
  route('put', '/ssh', (request) => ssh.setInstances(request.body));
  route('get', '/ssh/import', () => ssh.importHosts());
  route('get', '/ssh/status', (request) => ssh.statusesWithDefaults(typeof request.query.id === 'string' ? request.query.id : undefined));
  route('post', '/ssh/:id/connect', (request) => ssh.connect(request.params.id));
  route('post', '/ssh/:id/disconnect', (request) => ssh.disconnect(request.params.id));
  route('get', '/ssh/:id/logs', (request) => ssh.logsForInstance(String(request.params.id), request.query.limit ? Number(request.query.limit) : undefined));
  route('delete', '/ssh/:id/logs', (request) => ssh.clearLogsForInstance(String(request.params.id)));
  route('post', '/hosts/probe', async (request) => {
    const url = new URL(String(request.body?.url));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('An HTTP Host URL is required');
    const started = Date.now();
    try {
      const health = await fetch(new URL('health', `${url.href.replace(/\/$/u, '')}/`), { redirect: 'error' });
      if (!health.ok) return { status: 'wrong-service', latencyMs: Date.now() - started };
      const identity = await health.json() as { serverId?: string; varinVersion?: string; status?: string };
      if (identity.status !== 'ok' || typeof identity.varinVersion !== 'string') return { status: 'wrong-service', latencyMs: Date.now() - started };
      if (request.body.expectedServerId && identity.serverId !== request.body.expectedServerId) return { status: 'wrong-service', latencyMs: Date.now() - started };
      const headers = new Headers(request.body.requestHeaders ?? {});
      if (request.body.clientToken) headers.set('Authorization', `Bearer ${request.body.clientToken}`);
      const response = await fetch(new URL('auth/session', `${url.href.replace(/\/$/u, '')}/`), { headers, redirect: 'error' });
      return { status: response.ok ? 'ok' : response.status === 401 || response.status === 403 ? 'auth' : 'unreachable', latencyMs: Date.now() - started };
    } catch { return { status: 'unreachable', latencyMs: Date.now() - started }; }
  });
}
