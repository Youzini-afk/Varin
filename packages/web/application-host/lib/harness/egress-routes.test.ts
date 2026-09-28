import { describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { EgressRuntime } from './egress.js';
import { registerEgressRoutes } from './egress-routes.js';
import { OUTBOUND_PROXY_CREDENTIAL_REF, readOutboundProxyAuth } from './egress-settings.js';

const setting = (proxyUrl = 'http://proxy-a.test:8080', credentialRef = 'generation-a') => ({
  outboundNetwork: { mode: 'proxy', proxyUrl, credentialRef },
});

describe('Host egress routes', () => {
  it('rejects unauthenticated credential writes and connection verification', async () => {
    const app = express();
    const saveAuth = vi.fn();
    const removeAuth = vi.fn();
    const prepare = vi.fn();
    const requireAuth: RequestHandler = (_req, res) => { res.status(401).json({ error: 'Unauthorized' }); };
    registerEgressRoutes(app, {
      requireAuth, readSettings: async () => setting(), readAuth: () => ({}),
      saveAuth, removeAuth, egress: { prepare } as unknown as EgressRuntime,
    });
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user', password: 'secret', credentialRef: 'generation-a' }).expect(401);
    await request(app).post('/api/harness/egress/verify').send({ url: 'http://example.com/' }).expect(401);
    await request(app).delete('/api/harness/egress/credentials').send({ credentialRef: 'generation-a' }).expect(401);
    expect(saveAuth).not.toHaveBeenCalled();
    expect(removeAuth).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('refuses a stale endpoint binding and reports credential write failures without activating it', async () => {
    const app = express();
    let document = setting();
    let auth: Record<string, unknown> = {};
    let failWrite = false;
    registerEgressRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      readSettings: async () => document,
      readAuth: () => auth,
      saveAuth: (ref, entry) => {
        if (failWrite) throw new Error('storage failed');
        auth = { ...auth, [ref]: { type: 'api_key', ...entry } };
      },
      removeAuth: (ref) => { delete auth[ref]; return true; },
      egress: {} as EgressRuntime,
    });
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user', password: 'secret', credentialRef: 'old-generation' }).expect(409);
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user', password: 'secret', credentialRef: 'generation-a' }).expect(200);
    expect(readOutboundProxyAuth(auth, 'generation-a', 'http://proxy-a.test:8080')).toEqual({ username: 'user', password: 'secret' });
    document = setting('http://proxy-b.test:8080', 'generation-b');
    await request(app).get('/api/harness/egress/credentials').expect(200, { configured: false });
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user', password: 'new-secret', credentialRef: 'generation-a' }).expect(409);
    failWrite = true;
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user', password: 'new-secret', credentialRef: 'generation-b' }).expect(500);
    await request(app).get('/api/harness/egress/credentials').expect(200, { configured: false });
    expect(auth).toHaveProperty(OUTBOUND_PROXY_CREDENTIAL_REF);
    expect(JSON.stringify(auth)).not.toContain('new-secret');
  });

  it('does not let an old tab delete credentials saved for a new proxy endpoint', async () => {
    const app = express();
    let document = setting();
    let auth: Record<string, unknown> = {};
    const removeAuth = vi.fn((ref: string) => { delete auth[ref]; return true; });
    registerEgressRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      readSettings: async () => document,
      readAuth: () => auth,
      saveAuth: (ref, entry) => { auth = { ...auth, [ref]: { type: 'api_key', ...entry } }; },
      removeAuth,
      egress: {} as EgressRuntime,
    });
    // Tab A has generation-a. Tab B switches the endpoint and saves its credential.
    document = setting('http://proxy-b.test:8080', 'generation-b');
    await request(app).put('/api/harness/egress/credentials')
      .send({ username: 'user-b', password: 'secret-b', credentialRef: 'generation-b' }).expect(200);
    await request(app).delete('/api/harness/egress/credentials')
      .send({ credentialRef: 'generation-a' }).expect(409);
    expect(removeAuth).not.toHaveBeenCalled();
    expect(readOutboundProxyAuth(auth, 'generation-b', 'http://proxy-b.test:8080'))
      .toEqual({ username: 'user-b', password: 'secret-b' });
    await request(app).delete('/api/harness/egress/credentials')
      .send({ credentialRef: 'generation-b' }).expect(200);
    expect(removeAuth).toHaveBeenCalledOnce();
    expect(auth).not.toHaveProperty(OUTBOUND_PROXY_CREDENTIAL_REF);
  });
});
