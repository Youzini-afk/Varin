import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express, Request, Response as ExpressResponse, RequestHandler } from 'express';
import { expect, it } from 'vitest';
import { AgentSettingsService } from '../models/settings.js';
import { createAgentProfilesHttpAPI } from '@varin/application-client';
import { createAgentProfilesAPI } from './agent-profiles.js';
import { registerAgentProfileRoutes } from './agent-profile-routes.js';

it('retains the actual owner failure through registered routes and the public HTTP client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-http-owner-'));
  const path = join(root, 'agent-settings.json');
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, RequestHandler>();
  const requireAuth: RequestHandler = (_request, _response, next) => next();
  let nativeUnavailable = false;
  let nativeRequests = 0;
  const service = createAgentProfilesAPI({ settings: new AgentSettingsService(root, () => false), capabilities: async () => {
    nativeRequests += 1;
    if (nativeUnavailable) throw new Error('private implementation detail must not cross HTTP');
    return [];
  } });
  // Exercise the exact registered handlers without opening a network/IPC listener.
  const app = { post: (uri: string, auth: RequestHandler, handler: RequestHandler) => {
    expect(auth).toBe(requireAuth); handlers.set(uri, handler);
  } } as unknown as Express;
  registerAgentProfileRoutes(app, service, requireAuth);
  globalThis.fetch = async (url, init) => {
    let code = 200;
    let body: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(status: number) { code = status; return this; },
      json(value: unknown) { body = value; this.writableEnded = true; return this; },
    });
    const handler = handlers.get(String(url));
    if (!handler) throw new Error(`Unexpected route: ${url}`);
    await handler({ body: JSON.parse(String(init?.body)) } as Request, response as unknown as ExpressResponse, () => {});
    return Response.json(body, { status: code });
  };
  try {
    const api = createAgentProfilesHttpAPI();
    for (const field of ['models', 'agents']) {
      await writeFile(path, JSON.stringify({ harness: { [field]: [] } }));
      await expect(api.read({ runtime: 'agent' })).rejects.toMatchObject({ status: 400, code: 'agent-settings-invalid', message: `harness.${field} must be an object` });
    }
    expect(nativeRequests).toBe(2);
    await writeFile(path, JSON.stringify({ secret: 'not a profile field', harness: {} }));
    const view = await api.read({ runtime: 'agent' });
    expect(JSON.stringify(view)).not.toContain('not a profile field');
    const worker = view.profiles.find(profile => profile.id === 'varin:builtin:worker')!;
    const saved = await api.save({ runtime: 'agent', expectedRevision: view.revision, id: worker.id, config: worker.config, tools: [] });
    await expect(api.save({ runtime: 'agent', expectedRevision: view.revision, id: worker.id, config: worker.config })).rejects.toMatchObject({
      status: 409, code: 'agent-settings-conflict', message: 'Agent settings changed. Reload them before saving.',
    });
    expect(saved.snapshot.profiles.find(profile => profile.id === worker.id)?.tools).toEqual({ source: 'explicit', names: [] });
    const disk = await readFile(path, 'utf8');
    nativeUnavailable = true;
    await expect(api.read({ runtime: 'agent' })).rejects.toMatchObject({ status: 503, code: 'agent-capabilities-unavailable',
      message: 'Native tool capabilities are unavailable. Check the Agent runtime connection and reload.' });
    expect(await readFile(path, 'utf8')).toBe(disk);
    const invalid = await fetch('/api/agent-profiles/read', { method: 'POST', body: JSON.stringify({ runtime: 'other' }) });
    expect(invalid.status).toBe(400);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
