import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDocumentAuthorityHarness } from './contract-fixtures.js';
import { registerDocumentRoutes } from './routes.js';

describe('document routes', () => {
  it('serves revisioned reads without mapping failures to missing', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const app = express();
      app.use(express.json());
      registerDocumentRoutes(app, { documents: harness.authority });
      const missing = await request(app)
        .post('/api/documents/read')
        .send({ resource: harness.resource('missing.txt') })
        .expect(200);
      expect(missing.body.status).toBe('missing');
      const created = await request(app)
        .post('/api/documents/write')
        .send({
          token: harness.token(),
          resource: harness.resource('note.txt'),
          content: 'hello',
          encoding: 'utf-8',
          bom: false,
          expectedRevision: null,
          operationId: 'op-1',
        })
        .expect(200);
      expect(created.body.status).toBe('written');
      await request(app)
        .post('/api/documents/dirty/publish')
        .send({
          generation: 1,
          ownerId: 'web-surface',
          resources: [{ baseRevision: null, localEditRevision: 1, resource: harness.resource('note.txt') }],
          workspaceId: harness.identity.workspaceId,
        })
        .expect(200);
      expect(await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))
        .toEqual([expect.objectContaining({ ownerId: 'web-surface' })]);
      const captured = await request(app)
        .post('/api/documents/agent-input/capture')
        .send({
          generation: 1,
          ownerId: 'web-surface',
          resources: [{ baseRevision: null, content: 'unsaved hello', localEditRevision: 1, resource: harness.resource('note.txt') }],
          consumer: { kind: 'thread', threadId: 'thread-1', branchId: 'branch-1' },
          workspaceId: harness.identity.workspaceId,
        })
        .expect(200);
      expect(captured.body).toMatchObject({ source: 'surface', snapshot: { status: 'ready' } });
      expect(JSON.stringify(captured.body)).not.toContain('unsaved hello');
      await request(app)
        .post('/api/documents/agent-input/release')
        .send({ context: captured.body, consumer: { kind: 'thread', threadId: 'thread-1', branchId: 'branch-1' } })
        .expect(200, { released: true });
      await request(app)
        .post('/api/documents/dirty/clear')
        .send({ generation: 1, ownerId: 'web-surface', workspaceId: harness.identity.workspaceId })
        .expect(200);
      const escaped = await request(app)
        .post('/api/documents/read')
        .send({ resource: harness.resource('../secret.txt') })
        .expect(403);
      expect(escaped.body.reason).toBe('path-escape');
      expect(JSON.stringify(escaped.body)).not.toContain('hello');
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects an unknown watch workspace before opening an event stream', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const app = express();
      registerDocumentRoutes(app, { documents: harness.authority });
      const response = await request(app)
        .get('/api/documents/watch')
        .query({ workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
        .expect(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body.reason).toBe('workspace-unregistered');
    } finally {
      await harness.cleanup();
    }
  });
});
