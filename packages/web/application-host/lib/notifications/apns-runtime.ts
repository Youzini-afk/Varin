// APNs (Apple Push Notification service) runtime for the native iOS mobile app.
//
// Device tokens are persisted per UI session (mirrors push-runtime.ts). Delivery has two
// modes, chosen at send time:
//   - Relay (explicit): POST tokens + notification payload to VARIN_PUSH_RELAY_URL, whose service
//     holds the selected project APNs key and signs+sends.
//   - Direct: sign an ES256 JWT with Node crypto and send over HTTP/2 ourselves for
//     self-hosters who configure VARIN_APNS_*.
// Native Thread notifications use the Thread title and fixed status text from thread-runtime.ts.
// This transport forwards that payload through the configured channel; see APNS.md.

import {
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';
import { createSettingsFileStore } from '@varin/settings-store';
import type { SettingsFileStore } from '@varin/settings-store';
import type cryptoModule from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http2';

const APNS_TOKENS_VERSION = 1;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// APNs rejects auth tokens older than 1h; refresh well inside that window.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'dev.varin.mobile';
const MAX_TOKENS_PER_SESSION = 10;
// APNs reasons that mean the token is permanently invalid → drop it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

type PushEnvironment = 'production' | 'sandbox';
type PushPlatform = 'android' | 'ios';

interface ApnsTokenRecord {
  hostKey?: string | undefined;
  createdAt: number | null;
  deviceToken: string;
  environment: PushEnvironment;
  lastSeenAt: number | null;
  platform: PushPlatform;
  userAgent?: string | undefined;
}

interface ApnsTokenStore extends Record<string, unknown> {
  tokensBySession: Record<string, unknown>;
  version: number;
}

interface ApnsConfig {
  bundleId: string;
  environment: PushEnvironment | null;
  keyId: string;
  p8: string;
  teamId: string;
}

interface ApnsSendConfig extends ApnsConfig {
  tag?: string | undefined;
}

interface NotificationPayload {
  badge?: number;
  body?: string;
  data?: Record<string, unknown>;
  tag?: string;
  title?: string;
}

interface RelayConfig {
  environment: PushEnvironment | null;
  registerUrl: string;
  url: string;
}

interface RelayKeypair {
  privateKey: cryptoModule.KeyObject;
  publicJwk: JsonWebKey;
}

interface ApnsRuntimeDependencies {
  APNS_TOKENS_FILE_PATH: string;
  crypto: typeof cryptoModule;
  fsPromises: Pick<typeof fsPromisesModule, 'readFile'>;
  http2: Http2Like;
  readSettingsFromDisk: () => Promise<Record<string, unknown>>;
  tokensStore?: Pick<SettingsFileStore, 'read' | 'update'>;
  updateSettingsOnDisk: (
    mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

interface ApnsRequest {
  end(body: string): void;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'response', listener: (headers: Record<string, unknown>) => void): unknown;
  setEncoding(encoding: BufferEncoding): void;
}

interface ApnsClient {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  request(headers: OutgoingHttpHeaders): ApnsRequest;
}

interface Http2Like {
  connect(host: string): ApnsClient;
}

const trimmedEnv = (name: string): string | null => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

// Env vars commonly store the .p8 with literal "\n" sequences; restore real newlines.
const normalizePem = (value: unknown): string => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsRuntime = (deps: ApnsRuntimeDependencies) => {
  const {
    fsPromises,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    readSettingsFromDisk,
    updateSettingsOnDisk,
  } = deps;

  const emptyStore = (): ApnsTokenStore => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });
  const tokensStore = deps.tokensStore ?? createSettingsFileStore({
    filePath: APNS_TOKENS_FILE_PATH,
    defaultValue: emptyStore(),
  });
  let cachedJwt: { issuedAtMs: number; keyId: string; token: string } | null = null;
  let cachedRelayKey: RelayKeypair | null = null;
  let warnedUnconfigured = false;

  // ---------------------------------------------------------------------------
  // Per-server relay signing identity (ECDSA P-256). Auto-generated + persisted in settings
  // (mirrors getOrCreateVapidKeys). The relay derives serverId = SHA-256(publicKey), verifies
  // each request's signature, and only delivers to tokens this server registered — so a leaked
  // device token alone can't be used to push. Zero-config: the keypair generates on first use.
  // ---------------------------------------------------------------------------

  // Key access lives in lib/relay/signing-key.js now (shared with the private
  // relay identity — same keypair, same storage, same serverId derivation).
  const getOrCreateRelayKeypair = async (): Promise<RelayKeypair> => {
    if (cachedRelayKey) return cachedRelayKey;
    cachedRelayKey = await getOrCreateRelaySigningKeypair({
      crypto,
      readSettingsFromDisk,
      updateSettingsOnDisk: (mutator) => updateSettingsOnDisk((current) => {
        const next = mutator(current);
        return isRecord(next) ? next : current;
      }),
    }) as RelayKeypair;
    return cachedRelayKey;
  };

  const signRelayMessage = (privateKey: cryptoModule.KeyObject, message: string): string => signRelayMessageShared({ crypto }, privateKey, message);

  // Trim to the 4 fields the relay's schema accepts (and that feed the serverId hash).
  const relayPublicJwk = (publicJwk: JsonWebKey) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registerTokenWithRelay = async (token: string, platform: PushPlatform = 'ios'): Promise<void> => {
    const relay = resolveRelayConfig();
    if (!relay) return; // direct mode — no relay binding needed
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      // platform is part of the signed message so it can't be tampered en route.
      const sig = signRelayMessage(privateKey, `${ts}.${token}.${platform}`);
      const res = await fetch(relay.registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
      });
      if (!res.ok) console.warn(`[Push relay] register-token failed status=${res.status}`);
    } catch (error) {
      console.warn('[Push relay] register-token request failed:', error instanceof Error ? error.message : error);
    }
  };

  // ---------------------------------------------------------------------------
  // Token persistence (same shape + write-lock pattern as push-runtime.js)
  // ---------------------------------------------------------------------------

  const readTokensFromDisk = async (): Promise<ApnsTokenStore> => {
    try {
      const parsed = await tokensStore.read();
      if (!isRecord(parsed) || parsed.version !== APNS_TOKENS_VERSION) {
        throw new Error(`Unsupported APNs tokens version: ${String(parsed?.version)}`);
      }
      if (!isRecord(parsed.tokensBySession)) {
        throw new Error('APNs tokens file has invalid tokensBySession');
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession: parsed.tokensBySession };
    } catch (error) {
      console.warn('Failed to read APNs tokens file:', error);
      throw error;
    }
  };

  const persistTokenUpdate = async (
    mutate: (current: ApnsTokenStore) => ApnsTokenStore,
  ): Promise<Record<string, unknown>> => {
    return tokensStore.update((stored) => {
      if (stored.version !== APNS_TOKENS_VERSION) {
        throw new Error(`Unsupported APNs tokens version: ${String(stored.version)}`);
      }
      if (!isRecord(stored.tokensBySession)) {
        throw new Error('APNs tokens file has invalid tokensBySession');
      }
      return mutate({
        version: APNS_TOKENS_VERSION,
        tokensBySession: stored.tokensBySession,
      });
    });
  };

  const normalizeTokens = (record: unknown): ApnsTokenRecord[] => {
    if (!Array.isArray(record)) return [];
    return record
      .map((value): ApnsTokenRecord | null => {
        const entry = isRecord(value) ? value : null;
        if (!entry) return null;
        const deviceToken = entry.deviceToken;
        if (typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return null;
        return {
          deviceToken: deviceToken.trim(),
          hostKey: typeof entry.hostKey === 'string' && entry.hostKey.trim() ? entry.hostKey : undefined,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : undefined,
          // 'ios' (APNs) or 'android' (FCM). Older entries without one are APNs by default.
          platform: entry.platform === 'android' ? 'android' : 'ios',
          // APNs delivery environment for this token. Xcode/dev-signed installs produce
          // sandbox tokens, TestFlight/App Store produce production ones; the client reports
          // which at registration. Older entries without one default to production (matches
          // released builds).
          environment: entry.environment === 'sandbox' ? 'sandbox' : 'production',
        };
      })
      .filter((entry): entry is ApnsTokenRecord => Boolean(entry));
  };

  // Normalize an incoming platform hint to the two we support; default to APNs/iOS since that
  // was the only registrant before Android/FCM existed.
  const normalizePlatform = (platform: unknown): PushPlatform => (platform === 'android' ? 'android' : 'ios');

  const normalizeEnvironment = (environment: unknown): PushEnvironment => (environment === 'sandbox' ? 'sandbox' : 'production');

  const addOrUpdateApnsToken = async (
    uiSessionToken: string,
    deviceToken: string,
    userAgent?: string,
    platform?: string,
    environment?: string,
    hostKey?: string,
  ): Promise<void> => {
    if (!uiSessionToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return;
    const token = deviceToken.trim();
    const tokenPlatform = normalizePlatform(platform);
    const tokenEnvironment = normalizeEnvironment(environment);
    const now = Date.now();

    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      // A refreshed registration supersedes this device token's older authenticated binding.
      for (const [sessionToken, entries] of Object.entries(tokensBySession)) {
        tokensBySession[sessionToken] = normalizeTokens(entries).filter(entry => entry.deviceToken !== token);
      }
      const existing = normalizeTokens(tokensBySession[uiSessionToken]);
      const filtered = existing.filter((entry) => entry.deviceToken !== token);
      filtered.unshift({
        deviceToken: token,
        hostKey: typeof hostKey === 'string' && hostKey.trim() ? hostKey : undefined,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        platform: tokenPlatform,
        environment: tokenEnvironment,
      });
      tokensBySession[uiSessionToken] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });

    // (Re)bind this token to our server on the relay so only we can push to it. The device
    // re-sends its token on each launch; this is an idempotent upsert relay-side, and binding
    // every time (not just for new tokens) keeps existing tokens bound after a relay/server
    // upgrade rather than silently going unbound. Platform is bound too so the relay routes
    // it to APNs vs FCM.
    await registerTokenWithRelay(token, tokenPlatform);
  };

  const removeApnsToken = async (uiSessionToken: string, deviceToken: string): Promise<void> => {
    if (!uiSessionToken || !deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const filtered = normalizeTokens(tokensBySession[uiSessionToken]).filter(
        (entry) => entry.deviceToken !== deviceToken,
      );
      if (filtered.length === 0) delete tokensBySession[uiSessionToken];
      else tokensBySession[uiSessionToken] = filtered;
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsTokenFromAllSessions = async (deviceToken: string): Promise<void> => {
    if (!deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      for (const [session, entries] of Object.entries(tokensBySession)) {
        const filtered = normalizeTokens(entries).filter((entry) => entry.deviceToken !== deviceToken);
        if (filtered.length === 0) delete tokensBySession[session];
        else tokensBySession[session] = filtered;
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  // ---------------------------------------------------------------------------
  // Config (env first, then settings.apnsConfig) — mirrors resolveVapidSubject
  // ---------------------------------------------------------------------------

  const resolveApnsConfig = async (): Promise<ApnsConfig | null> => {
    let keyId = trimmedEnv('VARIN_APNS_KEY_ID');
    let teamId = trimmedEnv('VARIN_APNS_TEAM_ID');
    let bundleId = trimmedEnv('VARIN_APNS_BUNDLE_ID');
    let environment = (trimmedEnv('VARIN_APNS_ENVIRONMENT') || '').toLowerCase();
    let p8 = normalizePem(process.env.VARIN_APNS_P8 || '');

    const p8Path = trimmedEnv('VARIN_APNS_P8_PATH');
    if (!p8 && p8Path) {
      try {
        p8 = (await fsPromises.readFile(p8Path, 'utf8')).trim();
      } catch (error) {
        console.warn('[APNs] Failed to read VARIN_APNS_P8_PATH:', error instanceof Error ? error.message : error);
      }
    }

    if (!keyId || !teamId || !p8) {
      try {
        const settings = await readSettingsFromDisk();
        const stored = isRecord(settings.apnsConfig) ? settings.apnsConfig : null;
        if (stored) {
          keyId = keyId || (typeof stored.keyId === 'string' ? stored.keyId.trim() : null);
          teamId = teamId || (typeof stored.teamId === 'string' ? stored.teamId.trim() : null);
          bundleId = bundleId || (typeof stored.bundleId === 'string' ? stored.bundleId.trim() : null);
          environment = environment || (typeof stored.environment === 'string' ? stored.environment.toLowerCase() : '');
          if (!p8 && typeof stored.p8 === 'string') p8 = normalizePem(stored.p8);
        }
      } catch {
        // settings unavailable — fall through to the unconfigured result
      }
    }

    if (!keyId || !teamId || !p8) return null;

    return {
      keyId,
      teamId,
      p8,
      bundleId: bundleId || DEFAULT_BUNDLE_ID,
      // Explicit env/settings value forces every send to that environment; when unset (null),
      // each token is delivered to the environment it registered with.
      environment: environment === 'sandbox' ? 'sandbox' : environment === 'production' ? 'production' : null,
    };
  };

  // ---------------------------------------------------------------------------
  // JWT (ES256, JOSE/raw signature) + HTTP/2 send
  // ---------------------------------------------------------------------------

  const signApnsJwt = (config: ApnsConfig): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = crypto
      .sign('sha256', Buffer.from(signingInput), { key: config.p8, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return `${signingInput}.${signature}`;
  };

  const getJwt = (config: ApnsConfig): string => {
    const now = Date.now();
    if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAtMs < JWT_TTL_MS) {
      return cachedJwt.token;
    }
    const token = signApnsJwt(config);
    cachedJwt = { token, issuedAtMs: now, keyId: config.keyId };
    return token;
  };

  const buildBody = (payload: NotificationPayload): string => {
    const data = isRecord(payload.data) ? payload.data : {};
    return JSON.stringify({
      aps: {
        alert: {
          title: typeof payload?.title === 'string' ? payload.title : undefined,
          body: typeof payload?.body === 'string' ? payload.body : undefined,
        },
        badge: typeof payload.badge === 'number' && Number.isFinite(payload.badge) && payload.badge >= 0
          ? Math.trunc(payload.badge)
          : undefined,
        sound: 'default',
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
        // Wakes the Notification Service Extension so it can refresh the home/lock-screen
        // widgets (attention count + unread dot) from the push, even when the app is closed.
        // No extra network call — just an extra key on the push we already send.
        'mutable-content': 1,
      },
      ...data,
    });
  };

  const sendOne = (
    client: ApnsClient,
    deviceToken: string,
    body: string,
    jwt: string,
    config: ApnsSendConfig,
  ): Promise<void> => new Promise((resolve) => {
      const headers: OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      };
      // collapse-id dedups like web-push tags; APNs caps it at 64 bytes.
      const collapseId = typeof config.tag === 'string' ? config.tag.slice(0, 64) : undefined;
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', error instanceof Error ? error.message : error);
        resolve();
        return;
      }

      let status = 0;
      let responseBody = '';
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      req.on('end', async () => {
        if (status === 200) {
          resolve();
          return;
        }
        let reason = '';
        try {
          reason = JSON.parse(responseBody)?.reason || '';
        } catch {
          // non-JSON error body
        }
        if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
          await removeApnsTokenFromAllSessions(deviceToken);
        } else {
          console.warn(`[APNs] push failed status=${status} reason=${reason || 'unknown'}`);
        }
        resolve();
      });
      req.on('error', (error) => {
        console.warn('[APNs] request error:', error?.message ?? error);
        resolve();
      });
      req.end(body);
    });

  // Relay mode is explicit: the selected service owns the APNs key, while this server POSTs
  // device tokens and the notification payload, then receives token-drop results. Without a relay URL, direct
  // mode below uses the deployment's VARIN_APNS_* configuration when available.
  const resolveRelayConfig = (): RelayConfig | null => {
    if (trimmedEnv('VARIN_PUSH_RELAY_DISABLED') === 'true') return null;
    const url = trimmedEnv('VARIN_PUSH_RELAY_URL');
    if (!url) return null;
    const override = (trimmedEnv('VARIN_APNS_ENVIRONMENT') || '').toLowerCase();
    return {
      url,
      registerUrl: url.replace(/\/send$/, '/register-token'),
      // Explicit VARIN_APNS_ENVIRONMENT forces every send to that environment; when
      // unset (null), each token is delivered to the environment it registered with.
      environment: override === 'sandbox' ? 'sandbox' : override === 'production' ? 'production' : null,
    };
  };

  const sendViaRelay = async (
    deviceTokens: string[],
    payload: NotificationPayload,
    relay: RelayConfig,
    environment: PushEnvironment,
  ): Promise<void> => {
    const tokens = deviceTokens.slice(0, 100);
    const title = typeof payload?.title === 'string' && payload.title.length > 0 ? payload.title : 'Varin';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    // Sign over the same canonical form the relay verifies: ts.sortedTokens.title.
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
    const requestBody = JSON.stringify({
      tokens,
      title,
      body: typeof payload?.body === 'string' ? payload.body : '',
      badge: typeof payload.badge === 'number' && Number.isFinite(payload.badge) && payload.badge >= 0
        ? Math.trunc(payload.badge)
        : undefined,
      collapseId: typeof payload?.tag === 'string' ? payload.tag.slice(0, 64) : undefined,
      env: environment,
      data: payload?.data && typeof payload.data === 'object' ? payload.data : undefined,
      publicKeyJwk: relayPublicJwk(publicJwk),
      ts,
      sig,
    });
    try {
      const res = await fetch(relay.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      if (!res.ok) {
        console.warn(`[APNs relay] send failed status=${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null);
      const dataRecord = isRecord(data) ? data : null;
      const results = Array.isArray(dataRecord?.results) ? dataRecord.results : [];
      for (const result of results) {
        if (result && result.drop === true && typeof result.token === 'string') {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] request failed:', error instanceof Error ? error.message : error);
    }
  };

  const sendViaDirectApns = async (
    tokenGroups: Map<PushEnvironment, string[]>,
    payload: NotificationPayload,
  ): Promise<void> => {
    const config = await resolveApnsConfig();
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          '[APNs] Relay disabled and no direct config; set VARIN_APNS_KEY_ID / VARIN_APNS_TEAM_ID / VARIN_APNS_P8 for direct send.',
        );
      }
      return;
    }

    const jwt = getJwt(config);
    const body = buildBody(payload);
    const sendConfig: ApnsSendConfig = {
      ...config,
      ...(typeof payload.tag === 'string' ? { tag: payload.tag } : {}),
    };

    // One HTTP/2 session per APNs environment; a sandbox token sent to the production host
    // (or vice versa) gets BadDeviceToken and would be wrongly dropped as dead.
    for (const [environment, deviceTokens] of tokenGroups) {
      const effectiveEnvironment = config.environment ?? environment;
      const host = effectiveEnvironment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

      let client;
      try {
        client = http2.connect(host);
      } catch (error) {
        console.warn('[APNs] connect failed:', error instanceof Error ? error.message : error);
        continue;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            client.close();
          } catch {
            // ignore close errors
          }
          resolve();
        };
        client.on('error', (error) => {
          console.warn('[APNs] session error:', error instanceof Error ? error.message : error);
          finish();
        });
        Promise.all(
          deviceTokens.map((token) => sendOne(client, token, body, jwt, sendConfig)),
        ).finally(finish);
      });
    }
  };

  // NOT gated on UI visibility (unlike web push). A backgrounded WKWebView can't reliably
  // report "hidden" before iOS suspends it, so a visibility gate wrongly suppressed
  // background push for short responses. Instead we always send, and rely on iOS to NOT
  // display the alert while the app is foreground (presentationOptions: [] in
  // capacitor.config) — so there is no notification when the app is active, with no race.
  const sendApnsToAllUiSessions = async (
    payload: NotificationPayload,
    options: Record<string, unknown> = {},
  ): Promise<void> => {
    void options;
    const store = await readTokensFromDisk();
    // Tokens are grouped by their registered APNs environment so each batch goes to the
    // endpoint that actually knows the token (Xcode builds → sandbox, TestFlight/App Store
    // → production). Mixing them gets BadDeviceToken and the token wrongly dropped as dead.
    const groups = new Map<string, { hostKey?: string | undefined; environments: Map<PushEnvironment, string[]> }>();
    const seen = new Set<string>();
    for (const record of Object.values(store.tokensBySession || {})) {
      for (const entry of normalizeTokens(record)) {
        if (seen.has(entry.deviceToken)) continue;
        seen.add(entry.deviceToken);
        const key = entry.hostKey ?? '';
        const group = groups.get(key) ?? { hostKey: entry.hostKey, environments: new Map<PushEnvironment, string[]>() };
        const tokens = group.environments.get(entry.environment) ?? [];
        tokens.push(entry.deviceToken); group.environments.set(entry.environment, tokens); groups.set(key, group);
      }
    }
    const relay = resolveRelayConfig();
    for (const group of groups.values()) {
      const data = { ...(isRecord(payload.data) ? payload.data : {}) };
      // Routing is bound to the original authenticated token registration, never a producer's claim.
      delete data.hostKey; delete data.url;
      if (group.hostKey) {
        data.hostKey = group.hostKey;
        if (typeof data.threadId === 'string' && typeof data.branchId === 'string') {
          const params = new URLSearchParams({ branch: data.branchId, host: group.hostKey });
          data.url = `varin://thread/${encodeURIComponent(data.threadId)}?${params}`;
        }
      }
      const targeted = { ...payload, data };
      if (relay) {
        for (const [environment, tokens] of group.environments) await sendViaRelay(tokens, targeted, relay, relay.environment ?? environment);
      } else await sendViaDirectApns(group.environments, targeted);
    }
  };

  return {
    addOrUpdateApnsToken,
    removeApnsToken,
    removeApnsTokenFromAllSessions,
    sendApnsToAllUiSessions,
    resolveApnsConfig,
    // exposed for tests
    signApnsJwt,
  };
};
