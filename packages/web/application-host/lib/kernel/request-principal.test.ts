import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createThreadPrincipalMiddleware, currentRequestPrincipal, assertRequestAccess } from './request-principal.js';
import { OwnershipResolver, type OwnershipSelection } from './ownership-resolver.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

export function ownershipRuntime() {
  return {
    ownershipResolve: vi.fn(async (selection: OwnershipSelection) => {
      const subject = (id: string) => id.split(':')[0]!;
      const threads = new Set(selection.threads ?? []);
      const runs = new Set(selection.runs ?? []);
      for (const id of selection.operations ?? []) runs.add(`${subject(id)}:run`);
      for (const id of selection.inputs ?? []) threads.add(`${subject(id)}:thread`);
      for (const id of runs) threads.add(`${subject(id)}:thread`);
      return { threads: [...threads].filter(id => !id.startsWith('missing')).map(id => ({ id, principalId: subject(id) === 'public' ? null : subject(id) })),
        runs: [...runs].map(id => ({ id, threadId: `${subject(id)}:thread` })),
        operations: (selection.operations ?? []).map(id => ({ id, runId: `${subject(id)}:run` })),
        inputs: (selection.inputs ?? []).map(id => ({ id, threadId: `${subject(id)}:thread` })) };
    }),
  };
}
describe('authenticated Thread ingress', () => {
  const setup = () => {
    const runtime = ownershipRuntime();
    const action = vi.fn((_req, res) => res.json({ principal: currentRequestPrincipal() }));
    const app = express(); app.use(express.json());
    app.use('/api/threads', createThreadPrincipalMiddleware(runtime as unknown as AgentRuntimeClient,
      async req => ({ principalId: req.headers.authorization }), async id => id === 'owner'));
    app.post('/api/threads/:action', async (req, res) => {
      try { await assertRequestAccess(req.body, req.params.action === 'read' ? 'read' : 'write'); action(req, res); }
      catch { res.status(403).json({ error: 'Forbidden' }); }
    });
    return { app, action, runtime };
  };
  it('denies each foreign Catalog edge, including mixed-owned batches', async () => {
    const { app, action } = setup();
    for (const kind of ['threads', 'runs', 'operations', 'inputs']) {
      const response = await request(app).post('/api/threads/read').set('Authorization', 'alice').send({ [kind]: ['alice:1', 'bob:1'] });
      expect(response.status).toBe(403);
    }
    expect(action).not.toHaveBeenCalled();
  });
  it('allows public reads, but only owner or anonymous local work can write public executions', async () => {
    const { app } = setup();
    for (const principal of ['alice', 'bob', 'owner', '']) for (const mode of ['read', 'write']) {
      const response = await request(app).post(`/api/threads/${mode}`).set('Authorization', principal).send({ threads: ['public:thread'] });
      expect(response.status).toBe(mode === 'read' || principal === 'owner' || !principal ? 200 : 403);
    }
    expect((await request(app).post('/api/threads/read').send({ threads: ['alice:thread'] })).status).toBe(403);
  });
  it('keeps simultaneous request principals isolated and never treats body-selected principals as authority', async () => {
    const { app } = setup();
    const replies = await Promise.all(['alice', 'bob'].map(id => request(app).post('/api/threads/read').set('Authorization', id)
      .send({ threads: [`${id}:thread`], principalId: 'owner', content: { runId: 'other users text is not an identifier' } })));
    expect(replies.map(reply => reply.body.principal)).toEqual(['alice', 'bob']);
  });
  it('does not perform Catalog reads in middleware or scan arbitrary request content', async () => {
    const { app, runtime } = setup();
    const response = await request(app).post('/api/threads/read').set('Authorization', 'alice')
      .send({ toolArguments: { runId: 'bob:run', nested: { threadId: 'bob:thread' } } });
    expect(response.status).toBe(200);
    expect(runtime.ownershipResolve).not.toHaveBeenCalled();
  });
});

describe('immutable ownership resolution', () => {
  it('batches concurrent edge misses and caches their transitive ownership', async () => {
    const runtime = ownershipRuntime(); const resolver = new OwnershipResolver(runtime);
    const result = await Promise.all([resolver.owners({ operations: ['alice:operation'] }), resolver.owners({ inputs: ['bob:input'] })]);
    expect(result).toEqual([['alice'], ['bob']]);
    expect(runtime.ownershipResolve).toHaveBeenCalledTimes(1);
    expect(await resolver.owners({ threads: ['alice:thread'], runs: ['alice:run'], operations: ['alice:operation'] })).toEqual(['alice']);
    expect(runtime.ownershipResolve).toHaveBeenCalledTimes(1);
  });
  it('fails closed for missing edges and retries instead of negative caching', async () => {
    const runtime = ownershipRuntime(); const resolver = new OwnershipResolver(runtime);
    await expect(resolver.owners({ threads: ['missing:thread'] })).rejects.toThrow('access denied');
    await expect(resolver.owners({ threads: ['missing:thread'] })).rejects.toThrow('access denied');
    expect(runtime.ownershipResolve).toHaveBeenCalledTimes(2);
  });
});
