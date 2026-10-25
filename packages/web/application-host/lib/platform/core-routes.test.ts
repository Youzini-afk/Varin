import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { createTunnelAuth } from './tunnel-auth.js';
import { RelayUnavailableError } from '../relay/endpoint.js';
import type { NextFunction, Request, Response } from 'express';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './core-routes.js';

// Run the production parser registration without a listener, using real byte streams.
async function parseCommonBody(path: string, bytes: Buffer, headers: Record<string, string> = {}) {
  const router = express.Router();
  registerCommonRequestMiddleware(router as unknown as express.Express, { express });
  const req = Object.assign(new PassThrough(), {
    method: 'POST', url: path, path,
    headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers },
  });
  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(status: number) { this.statusCode = status; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
      };
      router.use((request, response) => {
        const remaining: Buffer[] = [];
        const finish = () => response.json({ parsed: request.body, unparsed: Buffer.concat(remaining).toString() });
        if (request.readableEnded) finish();
        else request.on('data', chunk => remaining.push(chunk)).once('end', finish);
      });
      router.use((error: { status?: number; type?: string }, _request: Request, response: Response, _next: NextFunction) => {
        response.status(error.status ?? 500).json({ type: error.type });
      });
      router(req as unknown as Request, res as unknown as Response, reject);
      req.end(bytes);
    });
  } finally {
    req.destroy();
  }
}

const bodyEncoders = [
  { encoding: 'identity', encode: (bytes: Buffer) => bytes },
  { encoding: 'gzip', encode: zlib.gzipSync },
  { encoding: 'deflate', encode: zlib.deflateSync },
  { encoding: 'br', encode: zlib.brotliCompressSync },
  ...(typeof zlib.zstdCompressSync === 'function' ? [{ encoding: 'zstd', encode: zlib.zstdCompressSync }] : []),
];

describe('core-routes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(bodyEncoders)('preserves JSON and extended forms with $encoding request bodies', async ({ encoding, encode }) => {
    const headers = { 'content-encoding': encoding };
    const json = await parseCommonBody('/api/threads/submit', encode(Buffer.from('{"text":"你好","items":[1,2]}')), headers);
    expect(json).toEqual({ status: 200, body: { parsed: { text: '你好', items: [1, 2] }, unparsed: '' } });
    const form = await parseCommonBody('/api/config/settings', encode(Buffer.from('name=Varin&scope[project]=workspace&items[]=one&items[]=two')),
      { ...headers, 'content-type': 'application/x-www-form-urlencoded' });
    expect(form).toEqual({ status: 200, body: { parsed: { name: 'Varin', scope: { project: 'workspace' }, items: ['one', 'two'] }, unparsed: '' } });
  });

  it.each([
    { path: '/api/behavior', limit: 1024 * 1024 },
    { path: '/api/smart-search', limit: 256 * 1024 },
  ])('enforces the decoded JSON limit for $path even with a small gzip frame', async ({ path, limit }) => {
    const headers = { 'content-encoding': 'gzip' };
    const atLimit = JSON.stringify({ text: 'x'.repeat(limit - 11) });
    expect(Buffer.byteLength(atLimit)).toBe(limit);
    const accepted = await parseCommonBody(path, zlib.gzipSync(atLimit), headers);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ parsed: { text: 'x'.repeat(limit - 11) } });
    const rejected = await parseCommonBody(path, zlib.gzipSync(`${atLimit} `), headers);
    expect(rejected).toEqual({ status: 413, body: { type: 'entity.too.large' } });
  });

  it('retains the real Thread body ceiling and pre-admission classification without allocating a 50 MB fixture', async () => {
    expect(await parseCommonBody('/api/threads/submit', Buffer.from('{}'), { 'content-length': String(50 * 1024 * 1024 + 1) }))
      .toEqual({ status: 413, body: { code: 'http-body-too-large', admission: 'not_started' } });
    expect(await parseCommonBody('/api/threads/submit', zlib.gzipSync('{'), { 'content-encoding': 'gzip' }))
      .toEqual({ status: 400, body: { code: 'thread-request-invalid', admission: 'not_started' } });
  });

  it('leaves multipart uploads and unregistered API JSON streams for their route owners', async () => {
    const multipart = '--upload\r\nContent-Disposition: form-data; name="files"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--upload--\r\n';
    expect(await parseCommonBody('/api/workspace/upload', Buffer.from(multipart), { 'content-type': 'multipart/form-data; boundary=upload' }))
      .toEqual({ status: 200, body: { parsed: undefined, unparsed: multipart } });
    expect(await parseCommonBody('/api/unregistered', Buffer.from('{"route":"owned"}')))
      .toEqual({ status: 200, body: { parsed: undefined, unparsed: '{"route":"owned"}' } });
  });

  it('marks only the Thread JSON parser rejection as not admitted', async () => {
    const app = express();
    // Exercise the real parser failure with a small test body budget.
    registerCommonRequestMiddleware(app, { express: { ...express, json: () => express.json({ limit: 32 }) } as typeof express });
    const admitted = vi.fn();
    app.post('/api/threads/submit', (_req, res) => { admitted(); res.json({}); });
    await request(app).post('/api/threads/submit').send({ text: 'x'.repeat(64) }).expect(413, { code: 'http-body-too-large', admission: 'not_started' });
    await request(app).post('/api/threads/submit').set('Content-Type', 'application/json').send('{').expect(400, { code: 'thread-request-invalid', admission: 'not_started' });
    expect(admitted).not.toHaveBeenCalled();
  });

  it.each([
    '/api/documents/workspace/resolve',
    '/api/language/sync',
    '/api/language-support/status',
    '/api/tasks/run',
    '/api/agent-profiles/read',
    '/api/runtime/content/collect',
    '/api/bot-memory/preview',
    '/api/computers/automation/stop',
    '/api/harness/managed-execution/v1/sources/resolve',
    '/api/debug/start',
    '/api/tests/run',
  ])('parses JSON bodies for workbench endpoint %s', async (endpoint) => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post(endpoint, (req, res) => res.json(req.body));

    await request(app)
      .post(endpoint)
      .send({ path: '/workspace', workspaceId: 'workspace-1' })
      .expect(200, { path: '/workspace', workspaceId: 'workspace-1' });
  });

  it('reports service addresses from the active server and tunnel owners', async () => {
    const app = express();
    registerServerStatusRoutes(app, {
      express,
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({}),
      getServerPort: () => 4123,
      getTunnelUrl: () => 'https://varin.example/',
      varinVersion: '1.0.0',
      runtimeName: 'test',
    });

    const response = await request(app).get('/api/system/info').expect(200);
    expect(response.body).toMatchObject({
      varinVersion: '1.0.0',
      port: 4123,
      tunnelUrl: 'https://varin.example/',
    });
  });

  it('should call gracefulShutdown with exitProcess: true on /api/system/shutdown', async () => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({ status: 'ok' }),
      varinVersion: '1.0.0',
      runtimeName: 'test',
      express,
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app).post('/api/system/shutdown');

    expect(dependencies.gracefulShutdown).toHaveBeenCalled();
    expect(shutdownOpts).toEqual({ exitProcess: true });
  });

  it('should require UI auth before /api/system/shutdown when auth is configured', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      varinVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Unauthorized' });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should allow authenticated /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      varinVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(200, { ok: true });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
  });

  it('should require tunnel auth for tunneled /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      varinVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        requireTunnelSession: vi.fn((_req, res) => res.status(401).json({ error: 'Tunnel auth required' })),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Tunnel auth required' });

    expect(dependencies.tunnelAuthController.requireTunnelSession).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).not.toHaveBeenCalled();
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('requires API auth before saving outbound proxy settings', async () => {
    const app = express();
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req: Request, res: Response) => res.status(401).json({ error: 'Unauthorized' }),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDisk: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    const saveTrustedProxy = vi.fn((_req, res) => res.json({ ok: true }));
    app.put('/api/config/settings', saveTrustedProxy);
    await request(app).put('/api/config/settings')
      .send({ outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy.test:8080' } })
      .expect(401);
    expect(saveTrustedProxy).not.toHaveBeenCalled();
  });

  const createPairingRouteApp = (overrides = {}) => {
    const app = express();
    const dependencies = {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'session-token' })),
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireSessionAuth: vi.fn((_req, _res, next) => next()),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handleUrlAuthToken: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      remoteClientAuthRuntime: {
        listClients: vi.fn(async () => []),
        createClient: vi.fn(),
        revokeClient: vi.fn(),
        purgeRevokedClients: vi.fn(),
      },
      clientPairingRuntime: {
        createPairingSession: vi.fn(async () => ({ pairing: { id: 'pair_1', secret: 'secret', expiresAt: '2099-01-01T00:00:00.000Z', fingerprint: 'ABCD-1234' } })),
        cancelPairingSession: vi.fn(async () => ({ cancelled: true })),
        redeemPairingSession: vi.fn(async () => ({
          pairing: { fingerprint: 'ABCD-1234' },
          client: { id: 'client-1', label: 'Phone', authMethod: 'pairing' },
          token: 'varin_client_token',
        })),
      },
      readSettingsFromDisk: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
      ...overrides,
    };
    registerAuthAndAccessRoutes(app, dependencies);
    return { app, dependencies };
  };

  it('creates pairing sessions behind owner auth and returns no-store payload data', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', allowedClientKinds: ['mobile'] })
      .expect(201);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.pairing).toMatchObject({ id: 'pair_1', secret: 'secret' });
    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
    expect(dependencies.clientPairingRuntime.createPairingSession).toHaveBeenCalledWith({
      label: 'Pair phone',
      allowedClientKinds: ['mobile'],
      createdByClientId: null,
      usesRelay: false,
    });
  });

  it('advertises the caller-supplied serverUrl first and keeps a public request origin as fallback', async () => {
    const { app } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'varin.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send({ label: 'Pair phone', serverUrl: 'http://192.168.1.20:2606' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:2606', priority: 10 },
      { type: 'tunnel', url: 'https://varin.example.com', priority: 20 },
    ]);
  });

  it('does not duplicate a matching request origin or advertise desktop loopback', async () => {
    const { app } = createPairingRouteApp();

    const matching = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', '192.168.1.20:2606')
      .send({ label: 'Pair phone', serverUrl: 'http://192.168.1.20:2606' })
      .expect(201);
    expect(matching.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:2606', priority: 10 },
    ]);

    const loopback = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', '127.0.0.1:3000')
      .send({ label: 'Pair phone', serverUrl: 'http://192.168.1.20:2606' })
      .expect(201);
    expect(loopback.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:2606', priority: 10 },
    ]);
  });

  it('folds in a relay candidate when the host relay is enabled', async () => {
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv_1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' },
      priority: 30,
    };
    const { app } = createPairingRouteApp({ getRelayPairingCandidate: vi.fn(async () => relayCandidate) });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://runtime.example', priority: 10 },
      relayCandidate,
    ]);
  });

  it('still returns the direct candidate when the relay candidate lookup throws', async () => {
    const { app } = createPairingRouteApp({
      getRelayPairingCandidate: vi.fn(async () => { throw new Error('relay status read failed'); }),
    });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
  });

  it('refuses an Anywhere link when the server has no relay endpoint, without creating a session', async () => {
    const { app, dependencies } = createPairingRouteApp({
      getRelayPairingCandidate: vi.fn(async () => { throw new RelayUnavailableError({ state: 'missing' }); }),
    });

    const relayOnly = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', includeRelay: true, includeDirect: false })
      .expect(409);
    expect(relayOnly.body).toEqual({
      error: expect.stringContaining('VARIN_RELAY_URL'),
      code: 'relay_unconfigured',
    });

    const withDirect = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', includeRelay: true })
      .expect(409);
    expect(withDirect.body.code).toBe('relay_unconfigured');
    expect(dependencies.clientPairingRuntime.createPairingSession).not.toHaveBeenCalled();
  });

  it('fails an Anywhere link whose relay cannot be prepared instead of dropping the relay', async () => {
    const { app, dependencies } = createPairingRouteApp({
      getRelayPairingCandidate: vi.fn(async () => { throw new Error('identity unreadable'); }),
    });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', includeRelay: true })
      .expect(503);
    expect(response.body.error).toContain('identity unreadable');
    expect(dependencies.clientPairingRuntime.createPairingSession).not.toHaveBeenCalled();
  });

  it('does not offer the relay transport unless the server reports one', async () => {
    const { app } = createPairingRouteApp();

    const response = await request(app)
      .get('/api/client-auth/pairing/transports')
      .expect(200);
    expect(response.body.relayAvailable).toBe(false);
  });

  it('requires owner auth before creating or cancelling pairing sessions', async () => {
    const { app, dependencies } = createPairingRouteApp({
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => null),
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
        requireSessionAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    });

    await request(app).post('/api/client-auth/pairing/sessions').send({}).expect(401);
    await request(app).delete('/api/client-auth/pairing/sessions/pair_1').expect(401);
    expect(dependencies.clientPairingRuntime.createPairingSession).not.toHaveBeenCalled();
    expect(dependencies.clientPairingRuntime.cancelPairingSession).not.toHaveBeenCalled();
  });

  it('redeems pairing sessions with no-store response and generic errors', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('Host', 'runtime.example')
      .send({ pairingId: 'pair_1', secret: 'secret', clientKind: 'mobile', deviceName: 'Phone' })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      ok: true,
      server: { label: 'Varin', url: 'http://runtime.example', fingerprint: 'ABCD-1234' },
      client: { id: 'client-1', authMethod: 'pairing' },
      clientToken: 'varin_client_token',
    });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledWith(expect.objectContaining({
      pairingId: 'pair_1',
      secret: 'secret',
      clientKind: 'mobile',
      deviceName: 'Phone',
    }));

    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValueOnce(new Error('Invalid or expired pairing session'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .send({ pairingId: 'pair_2', secret: 'wrong' })
      .expect(400, { error: 'Invalid or expired pairing session' });
  });

  it('rate limits pairing redeem attempts by socket address and pairingId, then resets after the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { app, dependencies } = createPairingRouteApp();
    app.set('trust proxy', true);
    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValue(new Error('Invalid or expired pairing session'));

    // The X-Forwarded-For headers below are deliberate spoof attempts: the rate
    // limiter buckets by socket address (not forwarded headers), so rotating the
    // header must NOT reset the counter or evade the lockout.
    for (let index = 0; index < 10; index += 1) {
      await request(app)
        .post('/api/client-auth/pairing/redeem')
        .set('X-Forwarded-For', `203.0.113.${index}`)
        .send({ pairingId: 'pair_rate', secret: `wrong-${index}` })
        .expect(400, { error: 'Invalid or expired pairing session' });
    }

    const locked = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-locked' })
      .expect(429, { error: 'Invalid or expired pairing session' });
    expect(locked.headers['retry-after']).toBe('300');
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(10);

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-after-reset' })
      .expect(400, { error: 'Invalid or expired pairing session' });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(11);
  });

  it('should let preview proxy credentials reach preview proxy validation', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, res) => res.status(401).type('text/plain').send('Authentication required'));

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth,
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDisk: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    app.use('/api/preview/proxy', (_req, res) => res.json({ reached: true }));

    await request(app)
      .get('/api/preview/proxy/abc123/?varin_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .set('Cookie', 'varin_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .expect(401, 'Authentication required');

    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('attaches client auth context to downstream API routes', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, _res, next) => next());
    const client = {
      id: 'client-1',
      label: 'External agent',
      profile: 'full-control',
      capabilities: ['filesystem:read'],
    };

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth,
        resolveAuthContext: vi.fn(async () => ({ type: 'client', clientId: client.id, client })),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      remoteClientAuthRuntime: {
        recordAuditEvent: vi.fn(async () => ({ recorded: true })),
      },
      readSettingsFromDisk: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    app.get('/api/downstream', (req, res) => {
      res.json({ auth: req.varinAuth });
    });

    const response = await request(app).get('/api/downstream').expect(200);
    expect(response.body.auth).toMatchObject({
      type: 'client',
      clientId: 'client-1',
      client: {
        profile: 'full-control',
      },
    });
    expect(requireAuth).not.toHaveBeenCalled();
  });
});

describe('client auth routes', () => {
  const createDependencies = (options: {
    resolveAuthContext?: () => Promise<Record<string, unknown>>;
  } = {}) => {
    const clients: Array<{
      clientKind: string | null;
      createdAt: string;
      id: string;
      label: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }> = [];
    const requireAuth = vi.fn((_req, _res, next) => next());
    const requireSessionAuth = vi.fn((_req, _res, next) => next());
    const resolveAuthContext = vi.fn(options.resolveAuthContext || (async () => ({ type: 'session' })));
    return {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        getTunnelSessionFromRequest: () => null,
        clearTunnelSessionCookie: () => {},
        requireTunnelSession: (_req: Request, _res: Response, next: NextFunction) => next(),
      },
      uiAuthController: {
        handleSessionStatus: (_req: Request, res: Response) => res.json({ authenticated: true }),
        handleSessionCreate: (_req: Request, res: Response) => res.json({ authenticated: true }),
        handlePasskeyStatus: (_req: Request, res: Response) => res.json({ enabled: false }),
        handlePasskeyAuthenticationOptions: (_req: Request, res: Response) => res.json({}),
        handlePasskeyAuthenticationVerify: (_req: Request, res: Response) => res.json({ authenticated: true }),
        requireAuth,
        requireSessionAuth,
        resolveAuthContext,
        handlePasskeyRegistrationOptions: (_req: Request, res: Response) => res.json({}),
        handlePasskeyRegistrationVerify: (_req: Request, res: Response) => res.json({}),
        handlePasskeyList: (_req: Request, res: Response) => res.json({ passkeys: [] }),
        handlePasskeyRevoke: (_req: Request, res: Response) => res.json({ revoked: true }),
        handleResetAuth: (_req: Request, res: Response) => res.json({ cleared: true }),
      },
      remoteClientAuthRuntime: {
        listClients: async () => clients,
        createClient: async ({ label, clientKind }: { clientKind?: string; label?: string }) => {
          const client = {
            id: `client-${clients.length + 1}`,
            label: label || 'Remote client',
            createdAt: 'now',
            lastUsedAt: null,
            revokedAt: null,
            clientKind: clientKind || null,
          };
          clients.push(client);
          return { client, token: 'varin_client_secret' };
        },
        revokeClient: async (id: string) => {
          const client = clients.find((entry) => entry.id === id);
          if (!client) return { revoked: false };
          client.revokedAt = 'revoked';
          return { revoked: true, client };
        },
        purgeRevokedClients: async () => {
          const before = clients.length;
          for (let index = clients.length - 1; index >= 0; index -= 1) {
            if (clients[index]?.revokedAt) clients.splice(index, 1);
          }
          return { purged: before - clients.length };
        },
      },
      readSettingsFromDisk: async () => ({}),
      normalizeTunnelSessionTtlMs: () => 1000,
      testHooks: { clients, requireAuth, requireSessionAuth, resolveAuthContext },
    };
  };

  it('creates, lists, and revokes remote client tokens', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Laptop' });
    expect(created.status).toBe(201);
    expect(created.body.token).toBe('varin_client_secret');
    expect(created.headers['cache-control']).toBe('no-store');

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toHaveLength(1);
    expect(listed.body.clients[0]).not.toHaveProperty('token');

    const revoked = await request(app).delete('/api/client-auth/clients/client-1');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);

    const listedAfterPurge = await request(app).get('/api/client-auth/clients');
    expect(listedAfterPurge.body.clients).toHaveLength(0);
  });

  it('reports current connection candidates with server identity for paired devices', async () => {
    const app = express();
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'server-abc',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      priority: 30,
    };
    const dependencies = {
      ...createDependencies({ resolveAuthContext: async () => ({ type: 'client', clientId: 'client-1' }) }),
      getDirectCandidateUrls: () => ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'not-a-url'],
      getRelayPairingCandidate: async () => relayCandidate,
      getServerId: async () => 'server-abc',
      getServerLabel: () => 'my-host',
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.serverId).toBe('server-abc');
    expect(response.body.label).toBe('my-host');
    expect(response.body.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
      { type: 'lan', url: 'http://10.0.0.5:3000', priority: 10 },
      relayCandidate,
    ]);
  });

  it('omits serverId and relay candidate when unavailable and survives failures', async () => {
    const app = express();
    const dependencies = {
      ...createDependencies(),
      getDirectCandidateUrls: () => {
        throw new Error('scan failed');
      },
      getRelayPairingCandidate: async () => {
        throw new Error('relay status failed');
      },
      getServerId: async () => null,
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('serverId');
    expect(response.body.candidates).toEqual([]);
  });

  it('scopes non-desktop client credentials to list and revoke only themselves', async () => {
    const app = express();
    let authContext: Record<string, unknown> = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const current = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Varin Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // A regular (non-desktop-local) client token only sees and manages itself.
    authContext = { type: 'client', clientId: other.body.client.id, client: other.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([other.body.client]);

    const denied = await request(app).delete(`/api/client-auth/clients/${current.body.client.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.revoked).toBe(false);

    const deniedPurge = await request(app).delete('/api/client-auth/clients');
    expect(deniedPurge.status).toBe(403);

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);
  });

  it('lets the local desktop client list and revoke every device', async () => {
    const app = express();
    let authContext: Record<string, unknown> = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Varin Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // The trusted desktop shell client manages all devices like a UI session.
    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    const listedIds = listed.body.clients.map((client: { id: string }) => client.id).sort();
    expect(listedIds).toEqual([desktop.body.client.id, other.body.client.id].sort());

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);
  });

  it('allows only the local desktop client token to create remote client tokens', async () => {
    const app = express();
    let authContext: Record<string, unknown> = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Varin Desktop', clientKind: 'desktop-local' });
    const remote = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Phone' });

    authContext = { type: 'client', clientId: remote.body.client.id, client: remote.body.client };
    const denied = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Another phone' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Client tokens cannot create remote clients');

    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };
    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Mobile' });
    expect(created.status).toBe(201);
    expect(created.body.client.label).toBe('Mobile');
  });

  it('requires UI-session auth for passkey registration management routes', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    await request(app).post('/auth/passkey/register/options').expect(200);
    await request(app).post('/auth/passkey/register/verify').expect(200);

    expect(dependencies.testHooks.requireSessionAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.testHooks.requireAuth).not.toHaveBeenCalled();
  });

  it('treats private LAN hosts as local even when a tunnel is active', async () => {
    const app = express();
    const dependencies = createDependencies();
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });
    dependencies.uiAuthController.handlePasskeyStatus = vi.fn((_req: Request, res: Response) => (
      res.json({ enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' })
    ));

    registerAuthAndAccessRoutes(app, { ...dependencies, tunnelAuthController });

    await request(app)
      .get('/auth/passkey/status')
      .set('Host', '192.168.1.5:57123')
      .expect(200, { enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' });

    expect(dependencies.uiAuthController.handlePasskeyStatus).toHaveBeenCalledTimes(1);
  });

  it('does not trust a private Host header from a public socket peer', () => {
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });

    expect(tunnelAuthController.classifyRequestScope({
      headers: { host: '192.168.1.5:57123' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('unknown-public');
  });
});
