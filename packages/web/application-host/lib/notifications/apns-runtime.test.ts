import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApnsRuntime } from './apns-runtime.js';

type ApnsDependencies = Parameters<typeof createApnsRuntime>[0];
type ApnsConfig = Parameters<ReturnType<typeof createApnsRuntime>['signApnsJwt']>[0];
type FetchMock = ReturnType<typeof vi.fn>;
type FetchCall = [unknown, { body: string; headers: Record<string, string> }];

// A real P-256 key so the ES256 signing path (direct mode) runs for real.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS_CONFIG: ApnsConfig = { keyId: 'KEY123', teamId: 'TEAM123', p8: P8, bundleId: 'dev.varin.mobile', environment: 'sandbox' };
const APNS_CONFIG_WITHOUT_ENVIRONMENT = {
  keyId: APNS_CONFIG.keyId,
  teamId: APNS_CONFIG.teamId,
  p8: APNS_CONFIG.p8,
  bundleId: APNS_CONFIG.bundleId,
};

// In-memory fs so add-then-read reflects within a test.
const createMemoryFs = () => {
  let content: string | null = null;
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => {
      if (content == null) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }
      return content;
    }),
    writeFile: vi.fn(async (_path: string, data: string) => {
      content = data;
    }),
  };
};

const createMemoryStore = () => {
  let document: Record<string, unknown> = { version: 1, tokensBySession: {} };
  return {
    read: vi.fn(async () => structuredClone(document)),
    update: vi.fn(async (mutator: (document: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) => {
      document = await mutator(structuredClone(document));
      return structuredClone(document);
    }),
  };
};

const makeDeps = (overrides: Record<string, unknown> = {}): ApnsDependencies => {
  // Stateful settings so the auto-generated relay signing keypair persists + reads back.
  let settings: Record<string, unknown> = {};
  return {
    fsPromises: createMemoryFs(),
    path: { dirname: () => '/tmp' },
    crypto,
    http2: { connect: vi.fn(() => { throw new Error('http2 must not be used in relay mode'); }) },
    APNS_TOKENS_FILE_PATH: '/tmp/apns-tokens.json',
    tokensStore: createMemoryStore(),
    readSettingsFromDisk: vi.fn(async () => settings),
    updateSettingsOnDisk: vi.fn(async (mutator: (settings: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) => {
      settings = await mutator(settings);
      return settings;
    }),
    ...overrides,
  } as unknown as ApnsDependencies;
};

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Mirror of the relay's verifier (crypto.subtle), to prove the server's signatures are valid.
const verifyRelaySignature = async (publicKeyJwk: JsonWebKey, message: string, sigB64Url: string) => {
  const key = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(Buffer.from(sigB64Url, 'base64url')),
    new TextEncoder().encode(message),
  );
};

const fetchCalls = (mock: FetchMock): FetchCall[] => mock.mock.calls as unknown as FetchCall[];
const isRegister = ([url]: FetchCall) => String(url).endsWith('/register-token');
const isSend = ([url]: FetchCall) => String(url) === 'https://relay.test/v1/push/send';
const requiredCall = (call: FetchCall | undefined): FetchCall => {
  if (!call) throw new Error('Expected fetch call');
  return call;
};

const createSuccessfulHttp2 = ({
  onConnect,
  onToken,
}: {
  onConnect?: (host: string) => void;
  onToken?: (token: string) => void;
} = {}): ApnsDependencies['http2'] => ({
  connect: (host: string) => {
    onConnect?.(host);
    return {
      on: () => undefined,
      close: () => undefined,
      request: (headers: Record<string, unknown>) => {
        onToken?.(String(headers[':path']).replace('/3/device/', ''));
        const listeners: {
          end?: () => void;
          response?: (headers: Record<string, unknown>) => void;
        } = {};
        return {
          on: (event: string, callback: unknown) => {
            if (event === 'response') listeners.response = callback as (headers: Record<string, unknown>) => void;
            if (event === 'end') listeners.end = callback as () => void;
          },
          setEncoding: () => undefined,
          end: () => queueMicrotask(() => {
            listeners.response?.({ ':status': '200' });
            listeners.end?.();
          }),
        };
      },
    };
  },
}) as unknown as ApnsDependencies['http2'];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VARIN_PUSH_RELAY_URL;
  delete process.env.VARIN_PUSH_RELAY_DISABLED;
  delete process.env.VARIN_APNS_ENVIRONMENT;
});

describe('apns runtime relay mode (explicit)', () => {
  it('does not overwrite a token store whose schema is not the current contract', async () => {
    const tokensStore = {
      read: vi.fn(),
      update: vi.fn(async (mutator) => mutator({ version: 2, tokensBySession: {} })),
    };
    const runtime = createApnsRuntime(makeDeps({ tokensStore }));

    await expect(runtime.addOrUpdateApnsToken('s1', 'tokenA'))
      .rejects.toThrow('Unsupported APNs tokens version: 2');
  });

  it('registers tokens (signed) and posts signed generic text, dropping dead tokens', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).endsWith('/register-token')
        ? jsonResponse({ ok: true })
        : jsonResponse({
            results: [
              { token: 'tokenA', ok: true, drop: false },
              { token: 'tokenDead', ok: false, drop: true },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenDead');

    // Each new token is bound on the relay with a signed register-token call.
    const registerCalls = fetchCalls(fetchMock).filter(isRegister);
    expect(registerCalls).toHaveLength(2);
    for (const [url, init] of registerCalls) {
      expect(url).toBe('https://relay.test/v1/push/register-token');
      const body = JSON.parse(init.body);
      expect(body.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
      expect(typeof body.ts).toBe('number');
      expect(body.platform).toBe('ios');
      expect(await verifyRelaySignature(body.publicKeyJwk, `${body.ts}.${body.token}.${body.platform}`, body.sig)).toBe(true);
    }

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions(
      { title: 'Agent response is ready', body: 'My session', badge: 3, tag: 'ready-x', data: { sessionId: 'sess1' } },
      {},
    );

    const sendCall = requiredCall(fetchCalls(fetchMock).find(isSend));
    const sent = JSON.parse(sendCall[1].body);
    expect(sendCall[1].headers.authorization).toBeUndefined();
    expect(new Set(sent.tokens)).toEqual(new Set(['tokenA', 'tokenDead']));
    expect(sent.title).toBe('Agent response is ready');
    expect(sent.body).toBe('My session');
    expect(sent.badge).toBe(3);
    expect(sent.env).toBe('production');
    expect(sent.data).toEqual({ sessionId: 'sess1' });
    expect(sent.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const sendMessage = `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.title}`;
    expect(await verifyRelaySignature(sent.publicKeyJwk, sendMessage, sent.sig)).toBe(true);

    // tokenDead should have been dropped → next send targets only tokenA.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'x', body: 'y', tag: 't' }, {});
    expect(JSON.parse(requiredCall(fetchCalls(fetchMock).find(isSend))[1].body).tokens).toEqual(['tokenA']);
  });

  it('reuses one persisted keypair (same serverId) across register + send', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {});

    const keys = fetchCalls(fetchMock).map(([, init]) => JSON.parse(init.body).publicKeyJwk);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const firstKey = keys[0];
    if (!firstKey) throw new Error('Expected relay public key');
    expect(keys.every((key) => key.x === firstKey.x && key.y === firstKey.y)).toBe(true);
    // Keypair was generated + persisted exactly once.
    expect(deps.updateSettingsOnDisk).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit sandbox environment override for every token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    process.env.VARIN_APNS_ENVIRONMENT = 'sandbox';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA', undefined, 'ios', 'production');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const sent = JSON.parse(requiredCall(fetchCalls(fetchMock).find(isSend))[1].body);
    expect(sent.env).toBe('sandbox');
  });

  it('routes each token to its registered environment (dev build sandbox, release production)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenXcode', undefined, 'ios', 'sandbox');
    await runtime.addOrUpdateApnsToken('s2', 'tokenStore', undefined, 'ios', 'production');
    await runtime.addOrUpdateApnsToken('s3', 'tokenLegacy'); // no environment → production

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const sends = fetchCalls(fetchMock).filter(isSend).map(([, init]) => JSON.parse(init.body));
    expect(sends).toHaveLength(2);
    const byEnv = Object.fromEntries(sends.map((s) => [s.env, new Set(s.tokens)]));
    expect(byEnv.sandbox).toEqual(new Set(['tokenXcode']));
    expect(byEnv.production).toEqual(new Set(['tokenStore', 'tokenLegacy']));
  });

  it('no-ops (no relay call) when no tokens are registered', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send Varin device tokens to an undeclared central relay', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('apns runtime direct fallback (relay disabled)', () => {
  it('leaves direct APNs environment unset without an explicit override (per-token routing)', async () => {
    const configWithoutEnvironment = APNS_CONFIG_WITHOUT_ENVIRONMENT;
    const runtime = createApnsRuntime(
      makeDeps({ readSettingsFromDisk: vi.fn(async () => ({ apnsConfig: configWithoutEnvironment })) }),
    );

    await expect(runtime.resolveApnsConfig()).resolves.toMatchObject({ environment: null });
  });

  it('sends each token to the APNs host of its registered environment', async () => {
    process.env.VARIN_PUSH_RELAY_DISABLED = 'true';
    const configWithoutEnvironment = APNS_CONFIG_WITHOUT_ENVIRONMENT;
    const hosts: Array<{ host: string; targeted: string[] }> = [];
    let currentTargets: string[] = [];
    const http2 = createSuccessfulHttp2({
      onConnect: (host) => {
        currentTargets = [];
        hosts.push({ host, targeted: currentTargets });
      },
      onToken: (token) => currentTargets.push(token),
    });
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDisk: vi.fn(async () => ({ apnsConfig: configWithoutEnvironment })) }),
    );
    await runtime.addOrUpdateApnsToken('s1', 'tokenXcode', undefined, 'ios', 'sandbox');
    await runtime.addOrUpdateApnsToken('s2', 'tokenStore', undefined, 'ios', 'production');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });

    const byHost = Object.fromEntries(hosts.map(({ host, targeted }) => [host, targeted]));
    expect(byHost['https://api.sandbox.push.apple.com']).toEqual(['tokenXcode']);
    expect(byHost['https://api.push.apple.com']).toEqual(['tokenStore']);
  });

  it('signs an ES256 JWT and sends over http2 when relay is disabled', async () => {
    process.env.VARIN_PUSH_RELAY_DISABLED = 'true';
    const targeted: string[] = [];
    const http2 = createSuccessfulHttp2({ onToken: (token) => targeted.push(token) });
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDisk: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(targeted).toEqual(['tokenDirect']);
  });

  it('signApnsJwt produces a 3-part ES256 token with the expected header/claims', () => {
    const runtime = createApnsRuntime(makeDeps());
    const parts = runtime.signApnsJwt(APNS_CONFIG).split('.');
    expect(parts).toHaveLength(3);
    const [header, claims] = parts;
    if (!header || !claims) throw new Error('Expected signed APNs JWT parts');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss).toBe('TEAM123');
  });
  it('binds each native deep link to its token registration instead of producer Host claims', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    const a = JSON.stringify(['https://a.test', 'server:a']);
    const b = JSON.stringify(['https://b.test', 'server:b']);
    await runtime.addOrUpdateApnsToken('auth-a', 'tokenA', undefined, 'ios', 'production', a);
    await runtime.addOrUpdateApnsToken('auth-b', 'tokenB', undefined, 'ios', 'production', b);
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'Ready', data: { threadId: 'thread:1', branchId: 'branch:review', hostKey: 'forged', url: 'varin://session/fake' } });
    const sends = fetchCalls(fetchMock).filter(isSend).map(([, init]) => JSON.parse(init.body));
    expect(sends).toHaveLength(2);
    for (const send of sends) {
      const expected = send.tokens[0] === 'tokenA' ? a : b;
      expect(send.data.hostKey).toBe(expected);
      const url = new URL(send.data.url);
      expect(url.hostname).toBe('thread'); expect(url.searchParams.get('branch')).toBe('branch:review'); expect(url.searchParams.get('host')).toBe(expected);
    }
  });

  it('rebinds a device token once when its client registration changes Host transport', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.VARIN_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('old-auth', 'same-token', undefined, 'ios', 'production', 'old-host');
    await runtime.addOrUpdateApnsToken('new-auth', 'same-token', undefined, 'ios', 'production', 'current-host');
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'Ready', data: { threadId: 'thread:1', branchId: 'branch:1' } });
    const sends = fetchCalls(fetchMock).filter(isSend).map(([, init]) => JSON.parse(init.body));
    expect(sends).toHaveLength(1);
    expect(sends[0].tokens).toEqual(['same-token']);
    expect(sends[0].data.hostKey).toBe('current-host');
  });

});
