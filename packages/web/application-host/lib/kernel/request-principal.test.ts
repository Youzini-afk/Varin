import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createThreadPrincipalMiddleware, currentRequestPrincipal } from './request-principal.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

describe('authenticated Thread ingress', () => {
  const setup = () => {
    const runtime = {
      thread: vi.fn(async (id: string) => ({ thread_id: id, principal_id: id === 'public' ? null : id.startsWith('alice') ? 'alice' : 'bob' })),
      run: vi.fn(async (id: string) => ({ thread_id: id, principal_id: id.startsWith('alice') ? 'alice' : 'bob' })),
      input: vi.fn(async () => ({ thread_id: 'bob' })), operation: vi.fn(async () => ({ run_id: 'bob-run' })),
    } as unknown as AgentRuntimeClient;
    const action = vi.fn((_req, res) => res.json({ principal: currentRequestPrincipal() }));
    const app = express(); app.use(express.json());
    app.use('/api/threads', createThreadPrincipalMiddleware(runtime, async req => req.headers.authorization ? { principalId: req.headers.authorization } : { type: 'session', token: 'unverified' }));
    app.post('/api/threads/:action', action); app.get('/api/threads/observe', action);
    return { app, action, runtime };
  };
  it('denies foreign read, start, cancel and confirmation before calling the operation', async () => {
    const { app, action } = setup();
    for (const [endpoint, body] of [
      ['snapshot', { threadId: 'bob' }], ['submit', { threadId: 'bob' }], ['cancel', { runId: 'bob-run' }],
      ['confirm', { operationId: 'bob-operation' }], ['input', { inputId: 'bob-input' }],
      ['send', { threadId: 'alice', request: { targetThreadId: 'bob' } }],
    ] as const) expect((await request(app).post(`/api/threads/${endpoint}`).set('Authorization', 'alice').send(body)).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });
  it('keeps public access unattributed and authenticated scope fixed independently on each request', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/threads/snapshot').send({ threadId: 'public' })).body).toEqual({ principal: null });
    expect((await request(app).post('/api/threads/snapshot').send({ threadId: 'alice' })).status).toBe(403);
    expect((await request(app).post('/api/threads/snapshot').set('Authorization', 'alice').send({ threadId: 'public' })).status).toBe(200);
    const [alice, bob] = await Promise.all(['alice', 'bob'].map(id => request(app).get('/api/threads/observe').set('Authorization', id)));
    expect(alice!.body.principal).toBe('alice'); expect(bob!.body.principal).toBe('bob');
  });
  it('preserves anonymous local public work and ignores body-selected principals', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/threads/submit').send({ threadId: 'public', principalId: 'alice' })).body).toEqual({ principal: null });
    expect((await request(app).post('/api/threads/submit').set('Authorization', 'alice').send({ threadId: 'alice', principalId: 'bob' })).body).toEqual({ principal: 'alice' });
  });

});
