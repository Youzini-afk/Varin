import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerThreadRoutes } from './thread-routes.js';
import { registerThreadAttachmentRoutes } from './thread-attachment-routes.js';
import { registerThreadUserDispatchRoutes } from './thread-user-dispatch-routes.js';
import { registerThreadExportRoutes } from './thread-export-routes.js';
import { registerThreadRememberRoutes } from '../memory/thread-remember-routes.js';
import { registerInteractiveUiRoutes } from '../interactive-ui/routes.js';
import { createThreadPrincipalMiddleware } from './request-principal.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ThreadAdapter } from './thread-adapter.js';
import type { OwnershipSelection } from './ownership-resolver.js';

const owner = (id: string) => id.startsWith('public') ? null : id.split(':')[0]!;
const setup = () => {
  const acted = vi.fn(async () => ({}));
  const runtime = { ownershipResolve: vi.fn(async (selected: OwnershipSelection) => {
    const runs = new Set(selected.runs ?? []);
    for (const id of selected.operations ?? []) runs.add(`${owner(id)}:run`);
    const threads = new Set(selected.threads ?? []);
    for (const id of [...runs, ...(selected.inputs ?? [])]) threads.add(`${owner(id) ?? 'public'}:thread`);
    return { threads: [...threads].map(id => ({ id, principalId: owner(id) })),
      runs: [...runs].map(id => ({ id, threadId: `${owner(id) ?? 'public'}:thread` })),
      inputs: (selected.inputs ?? []).map(id => ({ id, threadId: `${owner(id) ?? 'public'}:thread` })),
      operations: (selected.operations ?? []).map(id => ({ id, runId: `${owner(id)}:run` })) };
  }) };
  const adapter = new Proxy({ runtime }, { get(target, key) { return key in target ? target[key as keyof typeof target] : acted; } }) as unknown as ThreadAdapter;
  const service = new Proxy({}, { get: () => acted });
  const app = express(); app.use(express.json());
  const auth: express.RequestHandler = (_req, _res, next) => next();
  app.use(['/api/threads', '/api/interactive-ui'], createThreadPrincipalMiddleware(runtime as unknown as AgentRuntimeClient,
    async req => ({ principalId: req.headers.authorization }), async id => id === 'owner'));
  registerThreadRoutes(app, adapter, auth, service as never, service as never, service as never, service as never, service as never);
  registerThreadAttachmentRoutes(app, service as never, auth);
  registerThreadUserDispatchRoutes(app, service as never, auth);
  registerThreadExportRoutes(app, { runtime: service as never }, auth);
  registerThreadRememberRoutes(app, service as never, auth);
  registerInteractiveUiRoutes(app, service as never, auth);
  return { app, acted, runtime };
};
const identity = { runtime: 'agent', threadId: 'alice:thread', branchId: 'branch' };

describe('HTTP routes authorize the actual resources they consume', () => {
  it('rejects another principal on every registered resource route before the owner acts', async () => {
    const { app, acted } = setup();
    const routes = (app.router as unknown as { stack: Array<{ route?: { path: string; methods: { post?: boolean } } }> }).stack
      .flatMap(layer => layer.route?.methods.post ? [layer.route.path] : []);
    // These routes have no existing execution identity. Draft source routes are
    // gated separately by Host-owner authority in requirePrincipalAccess.
    const unscoped = new Set(['observe/interests', 'create', 'list', 'models', 'attention', 'events', 'source/draft-files', 'resources/draft-skills']);
    let checked = 0;
    for (const route of routes) {
      const method = route.replace('/api/threads/', '');
      if (unscoped.has(method) || method === 'attachments/upload') continue;
      let body: Record<string, unknown> = { ...identity, threadId: 'bob:thread' };
      if (['update', 'delete', 'read'].includes(method)) delete body.branchId;
      if (method === 'inspectMany') body = { threadIds: ['alice:thread', 'bob:thread'] };
      else if (method === 'run' || method.startsWith('run/')) body = { runId: 'bob:run' };
      else if (method === 'operation' || method.startsWith('operation/')) body = { operationId: 'bob:operation' };
      else if (method.startsWith('input/')) body = { inputId: 'bob:input' };
      else if (method === 'child/dispatch') body = { ...body, runId: 'bob:run', key: 'k', expectedHead: null, text: 'task', model: 'm', projectId: null, workMode: 'shared' };
      else if (method === 'computer/stop') body.runId = 'bob:run';
      else if (method === 'computer/decide') Object.assign(body, { requestId: 'r', expectedRevision: 1, decision: 'grant', key: 'k' });
      const response = await request(app).post(route).set('Authorization', 'alice').send(body);
      expect(response.status, route + ': ' + JSON.stringify(response.body)).toBe(403);
      checked++;
    }
    expect(checked).toBeGreaterThan(120);
    expect(acted).not.toHaveBeenCalled();
  });

  it('checks secondary nested selectors without scanning opaque content', async () => {
    const { app, acted, runtime } = setup();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['messages/send', { request: { targetThreadId: 'bob:thread' } }],
      ['messages/exchanges/control', { request: { operationId: 'bob:operation' } }],
      ['messages/exchange', { request: { senderThreadId: 'bob:thread' } }],
      ['family/runs', { request: { threadId: 'bob:thread' } }],
      ['family/read', { request: { threadId: 'alice:thread', runId: 'bob:run' } }],
      ['family/item', { request: { threadId: 'bob:thread' } }],
      ['media/read', { holder: { kind: 'family', threadId: 'bob:thread' } }],
      ['media/read', { holder: { kind: 'input', inputId: 'bob:input' } }],
      ['media/read', { holder: { kind: 'operation', operationId: 'bob:operation' } }],
      ['followup/register', { trigger: { kind: 'all', sources: [{ kind: 'job_stopped', operationId: 'bob:operation' }] } }],
      ['followup/arrangement/put', { arrangement: { threadId: 'bob:thread' } }],
      ['followup/arrangement/put', { arrangement: { threadId: 'alice:thread', sourceRunId: 'bob:run' } }],
      ['followup/source-route/put', { route: { threadId: 'bob:thread' } }],
      ['submit', { references: [{ kind: 'thread', threadId: 'bob:thread' }] }],
      ['child/continue', { sourceAgent: 'bob:thread' }],
      ['child/dispatch', { key: 'k', runId: 'alice:run', expectedHead: null, text: 'task', model: 'm', projectId: null, workMode: 'shared',
        background: [{ threadId: 'bob:thread', branchId: 'branch', headId: 'head', itemIds: ['item'] }] }],
    ];
    for (const [route, extra] of cases) expect((await request(app).post(`/api/threads/${route}`).set('Authorization', 'alice').send({ ...identity, ...extra })).status, route).toBe(403);
    expect(acted).not.toHaveBeenCalled();
    const before = runtime.ownershipResolve.mock.calls.length;
    const response = await request(app).post('/api/threads/question/answer').set('Authorization', 'alice')
      .send({ ...identity, operationId: 'alice:operation', answers: [{ value: { threadId: 'bob:thread' } }] });
    expect(response.status).toBe(200);
    expect(runtime.ownershipResolve.mock.calls.slice(before).flatMap(([value]) => value.threads ?? [])).not.toContain('bob:thread');
  });

  it('protects attachment query identities and interactive observations', async () => {
    const { app, acted } = setup();
    expect((await request(app).get('/api/threads/attachments/read').set('Authorization', 'alice').query({ ...identity, threadId: 'bob:thread', ref: 'attachment' })).status).toBe(403);
    expect((await request(app).post('/api/threads/attachments/upload').set('Authorization', 'alice').query({ ...identity, threadId: 'bob:thread' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('bytes'))).status).toBe(403);
    expect((await request(app).get('/api/interactive-ui/view/observe').set('Authorization', 'alice').query({ threadId: 'bob:thread', branchId: 'branch' })).status).toBe(403);
    expect(acted).not.toHaveBeenCalled();
  });

  it('allows public reads but denies actual public mutations for non-owner clients', async () => {
    const { app } = setup();
    const publicIdentity = { ...identity, threadId: 'public:thread' };
    expect((await request(app).post('/api/threads/snapshot').set('Authorization', 'alice').send(publicIdentity)).status).toBe(200);
    for (const route of ['delete', 'update', 'read', 'enqueue', 'submit', 'context/compact']) {
      expect((await request(app).post(`/api/threads/${route}`).set('Authorization', 'alice').send(['update', 'delete', 'read'].includes(route) ? { runtime: 'agent', threadId: 'public:thread' } : publicIdentity)).status, route).toBe(403);
    }
    expect((await request(app).post('/api/interactive-ui/fragment/register').set('Authorization', 'alice').send(publicIdentity)).status).toBe(403);
  });
});
