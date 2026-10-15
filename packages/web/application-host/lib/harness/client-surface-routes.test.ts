import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { expect, it } from 'vitest';
import { registerVarinEventRoutes } from '../scheduled-tasks/routes.js';
import { createClientSurfaceBridge, type ThreadSelection } from './client-surfaces.js';

function fixture(resolveSurfaceThread: (identity: ThreadSelection) => Promise<boolean>) {
  const clients = new Set<Response>();
  const handlers = new Map<string, RequestHandler>();
  const auth: RequestHandler = (_request, _response, next) => next();
  const bridge = createClientSurfaceBridge({ writeSseEvent: () => {} });
  const app = Object.fromEntries(['get', 'post'].map(method => [method, (route: string, guard: RequestHandler, handler: RequestHandler) => {
    expect(guard).toBe(auth); handlers.set(route, handler);
  }])) as unknown as Express;
  registerVarinEventRoutes(app, { getVarinEventClients: () => clients, writeSseEvent: () => {}, surfaceBridge: bridge, requireAuth: auth, resolveSurfaceThread });
  const request = (body: unknown = {}, query: unknown = {}) => Object.assign(new EventEmitter(), { body, query, varinAuth: { type: 'client', clientId: 'principal' } }) as unknown as Request;
  const response = () => Object.assign(new EventEmitter(), { code: 200, body: undefined as unknown, writableEnded: false,
    status(value: number) { this.code = value; return this; }, json(value: unknown) { this.body = value; this.writableEnded = true; return this; }, setHeader() {}, flushHeaders() {} });
  const invoke = (route: string, req: Request, res: ReturnType<typeof response>) => Promise.resolve(handlers.get(route)!(req, res as unknown as Response, () => {}));
  return { bridge, clients, request, response, invoke, principal: `client:${createHash('sha256').update('principal').digest('hex')}` };
}
it('does not let a delayed old Catalog check replace the latest authenticated Surface binding', async () => {
  let resolveOld!: (value: boolean) => void;
  const f = fixture(identity => identity.branchId === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(true));
  const oldResponse = f.response();
  const old = f.invoke('/api/varin/client-settings/bind', f.request({ threadId: 'thread', branchId: 'old', surfaceId: 'surface' }), oldResponse);
  const nextResponse = f.response();
  await f.invoke('/api/varin/client-settings/bind', f.request({ threadId: 'thread', branchId: 'new', surfaceId: 'surface' }), nextResponse);
  resolveOld(true); await old;
  expect(nextResponse.code).toBe(200); expect(oldResponse.code).toBe(409);
  expect(f.bridge.consumeThreadBinding(f.principal, { threadId: 'thread', branchId: 'old' }, 'surface')).toBe(false);
  expect(f.bridge.consumeThreadBinding(f.principal, { threadId: 'thread', branchId: 'new' }, 'surface')).toBe(true);
});
it('releases broadcast and Surface state when SSE closes during Catalog validation', async () => {
  let finish!: (value: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const identity = { threadId: 'thread', branchId: 'branch' };
  f.bridge.bindThread(f.principal, identity, 'surface');
  const request = f.request({}, { ...identity, surface: 'surface' }), response = f.response();
  const pending = f.invoke('/api/varin/events', request, response);
  expect(f.clients.size).toBe(1);
  request.emit('close'); finish(true); await pending;
  expect(f.clients.size).toBe(0); expect(f.bridge.listForThread(identity)).toEqual([]);
});
it('rejects renderer paths and grants before Catalog admission', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return true; });
  for (const field of ['cwd', 'contextDir', 'grantId', 'sessionId', 'workspaceId']) {
    const response = f.response();
    await f.invoke('/api/varin/client-settings/bind', f.request({ threadId: 'thread', branchId: 'branch', surfaceId: 'surface', [field]: 'forged' }), response);
    expect(response.code).toBe(400);
  }
  expect(calls).toBe(0);
});
