import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-ui-auth-test-'));
process.env.VARIN_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const loadCreateUiAuth = async () => {
  const module = await import('./ui-auth.js');
  return module.createUiAuth;
};

const createResponse = () => {
  let statusCode = 200;
  let body: Record<string, unknown> = {};
  const headers = new Map<string, unknown>();
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : { value: payload };
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
};

describe('ui auth client credential seam', () => {
  it('does not let spoofed forwarded addresses bypass password rate limiting', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    try {
      for (let index = 0; index < 10; index += 1) {
        const response = createResponse();
        await auth.handleSessionCreate({
          body: { password: 'wrong' },
          connection: { remoteAddress: '203.0.113.10' },
          headers: { 'x-forwarded-for': `198.51.100.${index}` },
          socket: { remoteAddress: '203.0.113.10' },
        }, response);
        expect(response.statusCode).toBe(401);
      }

      const blocked = createResponse();
      await auth.handleSessionCreate({
        body: { password: 'wrong' },
        connection: { remoteAddress: '203.0.113.10' },
        headers: { 'x-forwarded-for': '192.0.2.200' },
        socket: { remoteAddress: '203.0.113.10' },
      }, blocked);
      expect(blocked.statusCode).toBe(429);
    } finally {
      auth.dispose();
    }
  });

  it('accepts bearer client credentials when UI password auth is enabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();
    let called = false;

    await auth.requireAuth(req, res, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(req, res)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(req, res, { allowUrlToken: false })).toMatchObject({
      type: 'client',
      clientId: 'device-1',
      token: 'client:device-1',
    });
  });

  it('does not accept bearer client credentials for UI-session-only auth', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const clientReq = { method: 'GET', path: '/api/client-auth/clients', headers: { authorization: 'Bearer client-token' } };
    const clientRes = createResponse();
    let clientCalled = false;
    await auth.requireSessionAuth(clientReq, clientRes, () => {
      clientCalled = true;
    });
    expect(clientCalled).toBe(false);
    expect(clientRes.statusCode).toBe(401);

    const loginReq = { method: 'POST', headers: {}, body: { password: 'secret' } };
    const loginRes = createResponse();
    await auth.handleSessionCreate(loginReq, loginRes);
    const sessionCookie = String(loginRes.getHeader('set-cookie') || '').split(';', 1)[0] ?? '';
    expect(sessionCookie.startsWith('varin_ui_session=')).toBe(true);

    const sessionReq = { method: 'GET', path: '/api/client-auth/clients', headers: { cookie: sessionCookie } };
    const sessionRes = createResponse();
    let sessionCalled = false;
    await auth.requireSessionAuth(sessionReq, sessionRes, () => {
      sessionCalled = true;
    });
    expect(sessionCalled).toBe(true);
  });

  it('can require bearer client credentials when UI password is disabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, sessionToken: 'remote-session' } : null,
      },
    });

    const allowedReq = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const allowedRes = createResponse();
    let called = false;
    await auth.requireAuth(allowedReq, allowedRes, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(allowedReq, allowedRes)).toBe('client:remote-session');

    const deniedReq = { method: 'GET', headers: {} };
    const deniedRes = createResponse();
    await auth.requireAuth(deniedReq, deniedRes, () => {});
    expect(deniedRes.statusCode).toBe(401);
    expect(deniedRes.body).toEqual({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
    expect(await auth.resolveWebSocketAuthContext(deniedReq)).toBe(null);
    expect(await auth.resolveWebSocketAuthContext({
      method: 'GET',
      headers: { cookie: 'varin_ui_session=attacker-controlled' },
    })).toBe(null);
    expect(await auth.resolveWebSocketAuthContext(allowedReq)).toMatchObject({
      type: 'client',
      token: 'client:remote-session',
    });
  });

  it('allows anonymous WebSockets only for explicitly unauthenticated local runtimes', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth();

    expect(await auth.resolveWebSocketAuthContext({ headers: {} })).toEqual({
      type: 'anonymous',
      token: 'anonymous',
    });
  });

  it('reports authenticated client session status with bearer credentials', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });
    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();

    await auth.handleSessionStatus(req, res);

    expect(res.body).toEqual({ authenticated: true, scope: 'client' });
  });

  it('exchanges bearer credentials for short-lived URL auth tokens', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const oldQueryReq = { method: 'GET', path: '/api/config/settings', url: '/api/config/settings?untrusted_token=client-token', headers: { accept: 'application/json' } };
    const oldQueryRes = createResponse();
    let oldQueryCalled = false;
    await auth.requireAuth(oldQueryReq, oldQueryRes, () => {
      oldQueryCalled = true;
    });
    expect(oldQueryCalled).toBe(false);
    expect(oldQueryRes.statusCode).toBe(401);

    const mintReq = { method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer client-token', accept: 'application/json' } };
    const mintRes = createResponse();
    await auth.handleUrlAuthToken(mintReq, mintRes);
    const mintedToken = typeof mintRes.body.token === 'string' ? mintRes.body.token : '';
    expect(typeof mintRes.body.token).toBe('string');
    expect(mintedToken.startsWith('varin_url_')).toBe(true);
    expect(mintRes.body.expiresAt).toBeGreaterThan(Date.now());
    expect(mintRes.getHeader('cache-control')).toBe('no-store');

    const urlToken = mintedToken;
    const urlReq = { method: 'GET', path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&varin_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const urlRes = createResponse();
    let urlCalled = false;
    await auth.requireAuth(urlReq, urlRes, () => {
      urlCalled = true;
    });
    expect(urlCalled).toBe(true);
    expect(await auth.ensureSessionToken(urlReq, urlRes)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(urlReq, urlRes, { allowUrlToken: false })).toBe(null);

    const extensionAssetReq = {
      method: 'POST',
      path: '/api/varin/extensions/v1/assets/read',
      url: '/api/varin/extensions/v1/assets/read',
      headers: { 'x-varin-application-token': urlToken },
    };
    const extensionAssetRes = createResponse();
    let extensionAssetCalled = false;
    await auth.requireAuth(extensionAssetReq, extensionAssetRes, () => {
      extensionAssetCalled = true;
    });
    expect(extensionAssetCalled).toBe(true);

    const extensionEnabledReq = {
      method: 'PATCH',
      path: '/api/varin/extensions/v1/extensions/varin.builtin.pi-agents/enabled',
      url: '/api/varin/extensions/v1/extensions/varin.builtin.pi-agents/enabled',
      headers: { 'x-varin-application-token': urlToken },
    };
    const extensionEnabledRes = createResponse();
    let extensionEnabledCalled = false;
    await auth.requireAuth(extensionEnabledReq, extensionEnabledRes, () => {
      extensionEnabledCalled = true;
    });
    expect(extensionEnabledCalled).toBe(true);

    for (const [endpoint, allowed] of [['invoke', true], ['lease', true], ['select', false]] as const) {
      const request = {
        method: 'POST',
        url: `/api/varin/extensions/v1/services/${endpoint}`,
        headers: { 'x-varin-application-token': urlToken },
      };
      const response = createResponse();
      let admitted = false;
      await auth.requireAuth(request, response, () => { admitted = true; });
      expect(admitted).toBe(allowed);
      if (allowed) expect(await auth.ensureSessionToken(request, response)).toBe('client:device-1');
      else expect(response.statusCode).toBe(401);
    }

    const unrelatedHeaderReq = {
      method: 'POST',
      path: '/api/fs/raw',
      url: '/api/fs/raw',
      headers: { 'x-varin-application-token': urlToken },
    };
    const unrelatedHeaderRes = createResponse();
    let unrelatedHeaderCalled = false;
    await auth.requireAuth(unrelatedHeaderReq, unrelatedHeaderRes, () => {
      unrelatedHeaderCalled = true;
    });
    expect(unrelatedHeaderCalled).toBe(false);
    expect(unrelatedHeaderRes.statusCode).toBe(401);

    const serveReq = { method: 'GET', path: '/api/fs/serve/tmp/index.html', url: `/api/fs/serve/tmp/index.html?varin_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const serveRes = createResponse();
    let serveCalled = false;
    await auth.requireAuth(serveReq, serveRes, () => {
      serveCalled = true;
    });
    expect(serveCalled).toBe(true);

    const absoluteServeReq = { method: 'GET', path: '/api/fs/serve/Users/test/project/preview-test.html', url: `/api/fs/serve/Users/test/project/preview-test.html?varin_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const absoluteServeRes = createResponse();
    let absoluteServeCalled = false;
    await auth.requireAuth(absoluteServeReq, absoluteServeRes, () => {
      absoluteServeCalled = true;
    });
    expect(absoluteServeCalled).toBe(true);

    const mountedServeReq = {
      method: 'GET',
      baseUrl: '/api',
      path: '/fs/serve/Users/test/project/preview-test.html',
      originalUrl: `/api/fs/serve/Users/test/project/preview-test.html?varin_url_token=${encodeURIComponent(urlToken)}`,
      url: `/fs/serve/Users/test/project/preview-test.html?varin_url_token=${encodeURIComponent(urlToken)}`,
      headers: {},
    };
    const mountedServeRes = createResponse();
    let mountedServeCalled = false;
    await auth.requireAuth(mountedServeReq, mountedServeRes, () => {
      mountedServeCalled = true;
    });
    expect(mountedServeCalled).toBe(true);

    const dictationWsReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?varin_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(dictationWsReq, null)).toBe('client:device-1');

    const piRuntimeWsReq = {
      method: 'GET',
      path: '/api/varin/runtime/ws',
      url: `/api/varin/runtime/ws?varin_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.resolveWebSocketAuthContext(piRuntimeWsReq)).toMatchObject({
      type: 'client',
      token: 'client:device-1',
    });

    const dictationHttpReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?varin_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'application/json' },
    };
    const dictationHttpRes = createResponse();
    let dictationHttpCalled = false;
    await auth.requireAuth(dictationHttpReq, dictationHttpRes, () => {
      dictationHttpCalled = true;
    });
    expect(dictationHttpCalled).toBe(false);
    expect(dictationHttpRes.statusCode).toBe(401);

    const runtimeManagerSseReq = {
      method: 'GET',
      path: '/api/varin/runtime-manager/events',
      url: `/api/varin/runtime-manager/events?varin_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'text/event-stream' },
    };
    const runtimeManagerSseRes = createResponse();
    let runtimeManagerSseCalled = false;
    await auth.requireAuth(runtimeManagerSseReq, runtimeManagerSseRes, () => {
      runtimeManagerSseCalled = true;
    });
    expect(runtimeManagerSseCalled).toBe(true);

    const arbitraryGetReq = { method: 'GET', path: '/api/config/settings', url: `/api/config/settings?varin_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
    const arbitraryGetRes = createResponse();
    let arbitraryGetCalled = false;
    await auth.requireAuth(arbitraryGetReq, arbitraryGetRes, () => {
      arbitraryGetCalled = true;
    });
    expect(arbitraryGetCalled).toBe(false);
    expect(arbitraryGetRes.statusCode).toBe(401);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const writeReq = { method, path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&varin_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
      const writeRes = createResponse();
      let writeCalled = false;
      await auth.requireAuth(writeReq, writeRes, () => {
        writeCalled = true;
      });
      expect(writeCalled).toBe(false);
      expect(writeRes.statusCode).toBe(401);
    }
  });

  it('issues desktop client tokens with the UI session expiry', async () => {
    const createUiAuth = await loadCreateUiAuth();
    let createClientInput: Record<string, unknown> | null = null;
    const auth = createUiAuth({
      password: 'secret',
      sessionTtlMs: 123_000,
      clientAuthController: {
        createClient: async (input) => {
          createClientInput = input;
          return {
            token: 'client-token',
            client: {
              id: 'device-1',
              label: input.label,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: input.expiresAt,
            },
          };
        },
      },
    });

    const before = Date.now();
    const req = {
      method: 'POST',
      headers: {},
      body: {
        password: 'secret',
        issueClientToken: true,
        clientLabel: 'Varin Desktop',
      },
    };
    const res = createResponse();

    await auth.handleSessionCreate(req, res);

    expect(res.body.clientToken).toBe('client-token');
    const capturedInput = createClientInput as Record<string, unknown> | null;
    if (!capturedInput) throw new Error('Expected createClient input');
    expect(capturedInput.label).toBe('Varin Desktop');
    const expiresAt = Date.parse(String(capturedInput.expiresAt));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 122_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 124_000);
  });
});
