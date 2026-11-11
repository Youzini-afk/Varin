import { EventEmitter } from 'node:events';
import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { expect, it, vi } from 'vitest';
import { registerExternalAgentRoutes } from './routes.js';
import type { ExternalAgentsService } from './service.js';
function fixture() {
  const conversations = [{ id: 'mine', principalId: 'alice' }, { id: 'foreign', principalId: 'bob' }, { id: 'public', principalId: null }, { id: 'deleted', principalId: 'alice', deleted: true }];
  const children = [{ operation_id: 'mine-op', parent_run_id: 'mine-run', conversation_id: 'pending', binding: {} }, { operation_id: 'foreign-op', parent_run_id: 'foreign-run', conversation_id: 'foreign', binding: {} }];
  const service = { inspect: vi.fn(async (id: string) => conversations.find(item => item.id === id)), list: vi.fn(async () => conversations),
    children: vi.fn(async () => children), childPrincipal: vi.fn(async (child: typeof children[number]) => child.parent_run_id === 'mine-run' ? 'alice' : 'bob'),
    childPresentation: vi.fn(async () => ({ name: 'Own pending delegate' })), read: vi.fn(async (id: string) => ({ id })),
    update: vi.fn(async () => ({ deleted: true })), send: vi.fn(), connect: vi.fn(), uploadAttachment: vi.fn(), readAttachment: vi.fn(),
    subscribe: vi.fn(() => () => {}), settings: vi.fn(async () => ({ agents: [] })), create: vi.fn(async () => ({ id: 'created' })) };
  const router = Router();
  registerExternalAgentRoutes(router as unknown as Express, service as unknown as ExternalAgentsService, (_req, _res, next) => next(), async req => ({ principalId: req.headers['x-user'] ?? null }));
  const call = (action: string, body: unknown = {}, user: string | null = 'alice', method = 'POST') => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, destroyed: false, writableEnded: false,
      status(value: number) { this.statusCode = value; return this; }, json(value: unknown) { this.writableEnded = true; resolve({ status: this.statusCode, body: value }); return this; },
      set() { return this; }, setHeader() {}, flushHeaders() { resolve({ status: this.statusCode, body: 'stream' }); }, write() { return true; }, end() {} });
    const url = `/api/external-agents/${action}`;
    (router as unknown as { handle(req: Request, res: Response, next: NextFunction): void }).handle({ method, url, body, headers: { ...(user ? { 'x-user': user } : {}) }, query: Object.fromEntries(new URL(url, 'http://host').searchParams) } as unknown as Request, response as unknown as Response, error => reject(error ?? new Error('No matching route')));
  });
  return { service, call };
}
it('scopes external directory and pending child presentations to trusted request ownership', async () => {
  const f = fixture();
  expect((await f.call('list')).body).toEqual([{ id: 'mine', principalId: 'alice' }, { id: 'deleted', principalId: 'alice', deleted: true }]);
  expect((await f.call('list', {}, null)).body).toEqual([{ id: 'public', principalId: null }]);
  expect((await f.call('children')).body).toMatchObject([{ operationId: 'mine-op', conversationId: 'pending' }]);
  expect((await f.call('child-presentation', { operationId: 'foreign-op' })).status).toBe(403);
  expect(f.service.childPresentation).not.toHaveBeenCalled();
  expect((await f.call('child-presentation', { operationId: 'mine-op' })).status).toBe(200);
});
it('denies foreign execution, attachments and streams before touching their original owners', async () => {
  const f = fixture();
  for (const action of ['read', 'connect', 'authenticate', 'continue', 'disconnect', 'send', 'stop', 'respond', 'update']) expect((await f.call(action, { id: 'foreign' })).status).toBe(403);
  expect((await f.call('attachments/read?id=foreign&ref=file', {}, 'alice', 'GET')).status).toBe(403);
  expect((await f.call('attachments/upload?id=foreign')).status).toBe(403);
  expect((await f.call('observe?id=foreign', {}, 'alice', 'GET')).status).toBe(403);
  expect(f.service.read).not.toHaveBeenCalled(); expect(f.service.send).not.toHaveBeenCalled(); expect(f.service.subscribe).not.toHaveBeenCalled();
  expect(f.service.readAttachment).not.toHaveBeenCalled(); expect(f.service.uploadAttachment).not.toHaveBeenCalled();
});
it('authorizes owned tombstones and never accepts a body principal override', async () => {
  const f = fixture();
  expect((await f.call('update', { id: 'deleted', expectedRevision: 1, patch: { deleted: true } })).status).toBe(200);
  expect(f.service.update).toHaveBeenCalledOnce();
  expect((await f.call('read', { id: 'foreign', principalId: 'bob' })).status).toBe(400);
  expect((await f.call('settings', {}, null)).status).toBe(200);
  expect((await f.call('observe?id=*', {}, 'alice', 'GET')).status).toBe(200);
});

it('retains frozen source registration, placement and key through external creation admission', async () => {
  const f = fixture(); const input = { key: 'create-key', configurationId: 'program', organization: { containerId: 'group' }, source: { resourceOwner: { kind: 'local' }, path: '/project', expectedWorkspaceId: 'original-registration' } };
  expect((await f.call('create', input)).status).toBe(200);
  expect(f.service.create).toHaveBeenCalledWith(input, 'alice');
  expect((await f.call('create', { ...input, principalId: 'bob' })).status).toBe(400);
  expect((await f.call('create', { ...input, source: { ...input.source, principalId: 'bob' } })).status).toBe(400);
  expect(f.service.create).toHaveBeenCalledOnce();
});
