import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import fs from 'fs';
import path from 'path';
import { createUiPasskeys } from './ui-passkeys.js';
import { resolveVarinDataDir } from '../platform/data-paths.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction } from 'express';
import type { VarinAuthenticatedClient } from '../client-auth/request-context.js';

const SESSION_COOKIE_NAME = 'varin_ui_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_DEVICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const URL_AUTH_TOKEN_TTL_MS = 60 * 1000;
const URL_AUTH_TOKEN_PREFIX = 'varin_url_';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.VARIN_RATE_LIMIT_MAX_ATTEMPTS) || 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;
const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.VARIN_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

interface UiAuthRequest {
  baseUrl?: string | undefined;
  body?: Record<string, unknown> | undefined;
  connection?: { remoteAddress: string | undefined };
  headers: IncomingHttpHeaders;
  hostname?: string | undefined;
  method?: string | undefined;
  originalUrl?: string | undefined;
  params?: Record<string, string | string[] | undefined>;
  path?: string | undefined;
  query?: Record<string, unknown>;
  secure?: boolean | undefined;
  socket?: { encrypted?: boolean | undefined; remoteAddress: string | undefined };
  url?: string | undefined;
}

interface UiAuthHeaderResponse {
  setHeader(name: string, value: number | string | readonly string[]): unknown;
}

interface UiAuthResponse extends UiAuthHeaderResponse {
  json(payload: unknown): UiAuthResponse;
  send?(payload: unknown): UiAuthResponse;
  status(code: number): UiAuthResponse;
  type?(contentType: string): UiAuthResponse;
}

interface ClientAuthResult {
  /** A short-lived token derived from an authenticated UI session. */
  session?: boolean;
  client?: VarinAuthenticatedClient;
  clientId?: string;
  id?: string;
  ok?: boolean;
  sessionToken?: string;
}

interface ClientAuthController {
  authenticateBearerToken?(token: string, req: UiAuthRequest): Promise<ClientAuthResult | null>;
  createClient?(input: Record<string, unknown>): Promise<{
    client: Record<string, unknown> & { id: string };
    token: string;
  }>;
}

interface UiAuthOptions {
  clientAuthController?: ClientAuthController | null;
  cookieName?: string;
  password?: unknown;
  readSettingsFromDisk?: () => Promise<Record<string, unknown>>;
  requireClientAuth?: boolean;
  sessionTtlMs?: number;
}

interface RateLimitRecord {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  locked?: boolean;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const loginRateLimiter = new Map<string, RateLimitRecord>();
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

const rateLimitLocks = new Map<string, Promise<void>>();

const getClientIp = (req: UiAuthRequest): string | null => {
  // Password login is unauthenticated, so forwarded headers are attacker input
  // unless every deployment configures an exact proxy trust chain. Bucket by
  // the actual peer instead; a reverse proxy intentionally becomes one shared
  // protection boundary rather than an unlimited source of spoofed identities.
  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req: UiAuthRequest): string => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key: string): { maxAttempts: number; windowMs: number } => {
  if (key === 'rate-limit:no-ip') {
    return {
      maxAttempts: RATE_LIMIT_NO_IP_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS
    };
  }
  return {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_MS
  };
};

const acquireRateLimitLock = async (key: string): Promise<void> => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => { rateLimitLocks.delete(key); });
  rateLimitLocks.set(key, curr);
  await curr;
};

const checkRateLimit = async (req: UiAuthRequest): Promise<RateLimitResult> => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
    console.error('[RateLimit] Failed to get record', { key, error: errorMessage(err) });
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record?.lockedUntil && now < record.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(record.lockedUntil / 1000)
    };
  }

  if (record?.lockedUntil && now >= record.lockedUntil) {
    try {
      loginRateLimiter.delete(key);
    } catch (err) {
      console.error('[RateLimit] Failed to delete expired record', { key, error: errorMessage(err) });
    }
  }

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record.count >= maxAttempts) {
    const lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
    try {
      loginRateLimiter.set(key, { count: record.count + 1, lastAttempt: now, lockedUntil });
    } catch (err) {
      console.error('[RateLimit] Failed to set lockout', { key, error: errorMessage(err) });
    }
    return {
      allowed: false,
      retryAfter: Math.ceil(RATE_LIMIT_LOCKOUT_MS / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(lockedUntil / 1000)
    };
  }

  const remaining = maxAttempts - record.count;
  const reset = Math.ceil((record.lastAttempt + RATE_LIMIT_WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: maxAttempts,
    remaining,
    reset
  };
};

const recordFailedAttempt = async (req: UiAuthRequest): Promise<void> => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: errorMessage(err) });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: errorMessage(err) });
    }
  }
};

const clearRateLimit = async (req: UiAuthRequest): Promise<void> => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: errorMessage(err) });
  }
};

const cleanupRateLimitRecords = (): void => {
  const now = Date.now();
  for (const [key, record] of loginRateLimiter.entries()) {
    const isExpired = record.lockedUntil && now >= record.lockedUntil;
    const isStale = now - record.lastAttempt > RATE_LIMIT_CLEANUP_MS;
    if (isExpired || isStale) {
      try {
        loginRateLimiter.delete(key);
      } catch (err) {
        console.error('[RateLimit] Cleanup failed', { key, error: errorMessage(err) });
      }
    }
  }
};

const startRateLimitCleanup = (): void => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer.unref === 'function') {
      rateLimitCleanupTimer.unref();
    }
  }
};

const stopRateLimitCleanup = (): void => {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
};

const isSecureRequest = (req: UiAuthRequest): boolean => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const parseCookies = (cookieHeader: unknown): Record<string, string> => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce<Record<string, string>>((acc, segment) => {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      return acc;
    }
    const key = name.trim();
    if (!key) {
      return acc;
    }
    const value = rest.join('=').trim();
    try {
      acc[key] = decodeURIComponent(value || '');
    } catch {
      acc[key] = value || '';
    }
    return acc;
  }, {});
};

const getBearerTokenFromRequest = (req: UiAuthRequest): string | null => {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string') {
    const match = value.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || '';
    if (token) return token;
  }
  return null;
};

const getUrlAuthTokenFromRequest = (req: UiAuthRequest): string | null => {
  const headerToken = req?.headers?.['x-varin-application-token'];
  const normalizedHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof normalizedHeader === 'string' && normalizedHeader.trim()) return normalizedHeader.trim();
  const queryToken = req?.query?.varin_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (typeof token !== 'string' && typeof req?.url === 'string') {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('varin_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  return typeof token === 'string' && token.trim() ? token.trim() : null;
};

const isApplicationTokenWritePath = (pathname: string): boolean => (
  /^\/api\/varin\/extensions\/v1\/extensions\/[^/]+\/activate$/.test(pathname)
  || /^\/api\/varin\/extensions\/v1\/extensions\/[^/]+\/enabled$/.test(pathname)
  || pathname === '/api/varin/extensions/v1/assets/read'
  || pathname === '/api/varin/extensions/v1/entrypoints/read'
  || pathname === '/api/varin/extensions/v1/candidates/prepare'
  || pathname === '/api/varin/extensions/v1/candidates/discard-prepared'
  || pathname === '/api/varin/extensions/v1/candidates/review-capabilities'
  || pathname === '/api/varin/extensions/v1/candidates/select'
  || pathname === '/api/varin/extensions/v1/host-state/wait'
  || pathname === '/api/varin/extensions/v1/services/invoke'
  || pathname === '/api/varin/extensions/v1/services/lease'
  || pathname === '/api/varin/extensions/v1/actual'
  || pathname === '/api/varin/extensions/v1/install'
);

const getRequestPathname = (req: UiAuthRequest): string => {
  const rawUrl = req?.originalUrl || req?.url;
  if (typeof rawUrl === 'string' && rawUrl) {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      // Fall through to Express' derived path fields.
    }
  }
  if (typeof req?.baseUrl === 'string' && req.baseUrl && typeof req?.path === 'string' && req.path) {
    return `${req.baseUrl}${req.path}`.replace(/\/+/g, '/');
  }
  if (typeof req?.path === 'string' && req.path) return req.path;
  return '';
};

const isWebSocketUpgrade = (req: UiAuthRequest): boolean => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const isUrlAuthReadableHttpPath = (pathname: string): boolean => {
  return pathname === '/api/varin/events'
    || pathname === '/api/threads/observe'
    || pathname === '/api/varin/extensions/v1/catalog'
    || pathname === '/api/varin/extensions/v1/host-state'
    || pathname === '/api/varin/realtime-proxy/sse'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || pathname === '/api/fs/serve'
    || pathname.startsWith('/api/fs/serve/')
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname: string): boolean => {
  return pathname === '/api/varin/realtime-proxy/ws'
    || pathname === '/api/varin/observations/ws'
    || pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws'
    || pathname.startsWith('/api/preview/proxy/');
};

const canUseUrlAuthTokenForRequest = (req: UiAuthRequest): boolean => {
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
  const outerPath = getRequestPathname(req);
  // A saved-connection gateway keeps its mount in browser URLs. Authorize only
  // the same enumerated inner read/realtime routes; the gateway separately
  // requires full Host-wide delegation before substituting a peer credential.
  const pathname = outerPath.replace(/^\/api\/connections\/hosts\/[^/]+\/proxy(?=\/)/u, '');
  if (isWebSocketUpgrade(req)) {
    return isUrlAuthWebSocketPath(pathname);
  }
  if ((method === 'POST' || method === 'PATCH') && isApplicationTokenWritePath(pathname)) return true;
  return method === 'GET' && isUrlAuthReadableHttpPath(pathname);
};

const buildCookie = ({
  name,
  value,
  maxAge,
  secure,
}: { maxAge: number; name: string; secure: boolean; value: string }): string => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (typeof maxAge === 'number') {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

const normalizePassword = (candidate: unknown): string => {
  if (typeof candidate !== 'string') {
    return '';
  }
  return candidate.normalize().trim();
};

const isTrustedDeviceRequest = (value: unknown): boolean => value === true;

const VARIN_DATA_DIR = resolveVarinDataDir(process);
const JWT_SECRET_FILE = path.join(VARIN_DATA_DIR, 'jwt-secret');

function getOrCreateJwtSecret(): Uint8Array {
  const envSecret = process.env.VARIN_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return new TextEncoder().encode(fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim());
    }
  } catch (e) {
    console.warn('[JWT] Failed to read secret file:', errorMessage(e));
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(VARIN_DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.log('[JWT] Generated and persisted new secret to', JWT_SECRET_FILE);
  } catch (e) {
    console.warn('[JWT] Failed to persist secret:', errorMessage(e));
  }

  return new TextEncoder().encode(secret);
}

function persistJwtSecret(secret: string): Uint8Array {
  if (process.env.VARIN_JWT_SECRET) {
    const error = Object.assign(new Error('Global sign-out is unavailable while VARIN_JWT_SECRET is set'), { statusCode: 400 });
    throw error;
  }

  fs.mkdirSync(VARIN_DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return new TextEncoder().encode(secret);
}

export const createUiAuth = ({
  password,
  cookieName = SESSION_COOKIE_NAME,
  sessionTtlMs = SESSION_TTL_MS,
  readSettingsFromDisk,
  clientAuthController = null,
  requireClientAuth = false,
}: UiAuthOptions = {}) => {
  const normalizedPassword = normalizePassword(password);
  const urlAuthTokens = new Map<string, { expiresAt: number; sessionToken: string; bearerToken?: string }>();

  const sweepUrlAuthTokens = (): void => {
    const now = Date.now();
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (!entry || entry.expiresAt <= now) {
        urlAuthTokens.delete(token);
      }
    }
  };

  const issueUrlAuthTokenForSession = (sessionToken: string, bearerToken?: string) => {
    sweepUrlAuthTokens();
    const token = `${URL_AUTH_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const expiresAt = Date.now() + URL_AUTH_TOKEN_TTL_MS;
    urlAuthTokens.set(token, { sessionToken, expiresAt, ...(bearerToken ? { bearerToken } : {}) });
    return { token, expiresAt };
  };

  const authenticateUrlAuthToken = async (req: UiAuthRequest): Promise<ClientAuthResult | null> => {
    if (!canUseUrlAuthTokenForRequest(req)) return null;
    const token = getUrlAuthTokenFromRequest(req);
    if (!token || !token.startsWith(URL_AUTH_TOKEN_PREFIX)) return null;
    const entry = urlAuthTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      urlAuthTokens.delete(token);
      return null;
    }
    if (entry.bearerToken) {
      // A URL grant cannot outlive revocation or acquire broader capabilities
      // than its original client. The bearer stays only in this short-lived map.
      try {
        const result = await clientAuthController?.authenticateBearerToken?.(entry.bearerToken, req);
        return result?.ok ? result : null;
      } catch { return null; }
    }
    return { ok: true, session: true, sessionToken: entry.sessionToken };
  };

  const authenticateClientRequest = async (
    req: UiAuthRequest,
    { allowUrlToken = true }: { allowUrlToken?: boolean } = {},
  ): Promise<ClientAuthResult | null> => {
    if (allowUrlToken) {
      const urlAuth = await authenticateUrlAuthToken(req);
      if (urlAuth) return urlAuth;
    }
    const token = getBearerTokenFromRequest(req);
    if (!token || typeof clientAuthController?.authenticateBearerToken !== 'function') {
      return null;
    }
    try {
      const result = await clientAuthController.authenticateBearerToken(token, req);
      if (result?.ok) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  };

  const clientSessionToken = (clientAuth: ClientAuthResult): string => {
    const raw = clientAuth?.sessionToken || clientAuth?.clientId || clientAuth?.id;
    if (typeof raw === 'string' && (raw.startsWith('client:') || raw.startsWith('url:'))) return raw;
    return typeof raw === 'string' && raw.length > 0 ? `client:${raw}` : 'client:authenticated';
  };

  const clientAuthClientId = (clientAuth: ClientAuthResult): string | null => {
    const raw = clientAuth?.client?.id || clientAuth?.clientId || clientAuth?.id || clientAuth?.sessionToken;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return raw.startsWith('client:') ? raw.slice('client:'.length) : raw;
  };

  const clientAuthContext = (clientAuth: ClientAuthResult) => clientAuth.session === true
    ? { type: 'session', token: clientAuth.sessionToken }
    : ({
    type: 'client',
    token: clientSessionToken(clientAuth),
    clientId: clientAuthClientId(clientAuth),
    client: clientAuth?.client || null,
  });

  if (!normalizedPassword) {
    const setSessionCookie = (req: UiAuthRequest, res: UiAuthHeaderResponse, token: string, ttlMs = sessionTtlMs): void => {
      const secure = isSecureRequest(req);
      const maxAgeSeconds = Math.floor(ttlMs / 1000);
      const header = buildCookie({
        name: cookieName,
        value: encodeURIComponent(token),
        maxAge: maxAgeSeconds,
        secure,
      });
      res.setHeader('Set-Cookie', header);
    };

    const ensureSessionToken = async (req: UiAuthRequest, res: UiAuthHeaderResponse): Promise<string | null> => {
      if (requireClientAuth) {
        const clientAuth = await authenticateClientRequest(req);
        return clientAuth ? clientSessionToken(clientAuth) : null;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[cookieName]) {
        return cookies[cookieName];
      }
      const token = crypto.randomBytes(32).toString('base64url');
      setSessionCookie(req, res, token, sessionTtlMs);
      return token;
    };

    const requireAuth = async (req: UiAuthRequest, res: UiAuthResponse, next: NextFunction) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      const clientAuth = await authenticateClientRequest(req);
      if (clientAuth) {
        return next();
      }
      return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
    };

    const requireSessionAuth = async (req: UiAuthRequest, res: UiAuthResponse, next: NextFunction) => {
      if (!requireClientAuth) {
        return next();
      }
      if (req.method === 'OPTIONS') {
        return next();
      }
      return res.status(401).json({ error: 'UI session authentication required', locked: true });
    };

    const resolveAuthContext = async (
      req: UiAuthRequest,
      res: UiAuthResponse | null,
      { allowClientAuth = true, allowUrlToken = true }: { allowClientAuth?: boolean; allowUrlToken?: boolean } = {},
    ) => {
      const cookies = parseCookies(req.headers.cookie);
      if (!requireClientAuth && cookies[cookieName]) {
        return { type: 'session', token: cookies[cookieName] };
      }
      if (allowClientAuth) {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
        if (clientAuth) return clientAuthContext(clientAuth);
      }
      if (!requireClientAuth) {
        if (!res) return null;
        const token = await ensureSessionToken(req, res);
        return { type: 'session', token };
      }
      return null;
    };

    const resolveWebSocketAuthContext = async (req: UiAuthRequest) => {
      if (!requireClientAuth) {
        const cookies = parseCookies(req.headers?.cookie);
        if (cookies[cookieName]) {
          return { type: 'session', token: cookies[cookieName] };
        }
      }
      const clientAuth = await authenticateClientRequest(req);
      if (clientAuth) return clientAuthContext(clientAuth);
      return requireClientAuth ? null : { type: 'anonymous', token: 'anonymous' };
    };

    return {
      enabled: false,
      requireAuth,
      requireSessionAuth,
      resolveAuthContext,
      resolveWebSocketAuthContext,
      handleSessionStatus: async (req: UiAuthRequest, res: UiAuthResponse) => {
        if (requireClientAuth) {
          const clientAuth = await authenticateClientRequest(req);
          if (clientAuth) {
            return res.json({ authenticated: true, disabled: true, scope: 'client' });
          }
          return res.status(401).json({ authenticated: false, locked: true, clientAuthRequired: true });
        }
        res.json({ authenticated: true, disabled: true });
      },
      handleSessionCreate: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleUrlAuthToken: async (req: UiAuthRequest, res: UiAuthResponse) => {
        const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
        if (clientAuth) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(issueUrlAuthTokenForSession(clientSessionToken(clientAuth), getBearerTokenFromRequest(req) || undefined));
        }
        if (requireClientAuth) {
          return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
        }
        const sessionToken = await ensureSessionToken(req, res);
        res.setHeader('Cache-Control', 'no-store');
        if (!sessionToken) return res.status(401).json({ error: 'Authentication required' });
        return res.json(issueUrlAuthTokenForSession(sessionToken));
      },
      handlePasskeyStatus: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
      },
      handlePasskeyRegistrationOptions: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyRegistrationVerify: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationOptions: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyAuthenticationVerify: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handlePasskeyList: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.json({ passkeys: [] });
      },
      handlePasskeyRevoke: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      handleResetAuth: (_req: UiAuthRequest, res: UiAuthResponse) => {
        res.status(400).json({ error: 'UI password not configured' });
      },
      issueTrustedSession: async (req: UiAuthRequest, res: UiAuthResponse) => {
        const token = crypto.randomBytes(32).toString('base64url');
        setSessionCookie(req, res, token, TRUSTED_DEVICE_SESSION_TTL_MS);
        return token;
      },
      ensureSessionToken: async (req: UiAuthRequest, res: UiAuthHeaderResponse | null): Promise<string | null> => {
        const clientAuth = await authenticateClientRequest(req);
        if (clientAuth) return clientSessionToken(clientAuth);
        if (!res) return null;
        return ensureSessionToken(req, res);
      },
      dispose: () => undefined,
    };
  }

  const salt = crypto.randomBytes(16);
  const expectedHash = crypto.scryptSync(normalizedPassword, salt, 64);
  let jwtSecret = getOrCreateJwtSecret();
  let passwordBinding = crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex');
  const resolveSessionTtlMs = (trustDevice: unknown): number => (trustDevice ? TRUSTED_DEVICE_SESSION_TTL_MS : sessionTtlMs);
  let passkeyController = createUiPasskeys({
    passwordBinding,
    ...(readSettingsFromDisk ? { readSettingsFromDisk } : {}),
  });

  const rebuildPasskeyController = (): void => {
    passkeyController.dispose();
    passwordBinding = crypto.createHmac('sha256', jwtSecret).update(normalizedPassword).digest('hex');
    passkeyController = createUiPasskeys({
      passwordBinding,
      ...(readSettingsFromDisk ? { readSettingsFromDisk } : {}),
    });
  };

  const rotateJwtSecret = (): void => {
    const nextSecret = crypto.randomBytes(32).toString('hex');
    jwtSecret = persistJwtSecret(nextSecret);
    urlAuthTokens.clear();
    rebuildPasskeyController();
  };

  const getTokenFromRequest = (req: UiAuthRequest): string | null => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[cookieName]) {
      return cookies[cookieName];
    }
    return null;
  };

  const setSessionCookie = (req: UiAuthRequest, res: UiAuthHeaderResponse, token: string, ttlMs: number): void => {
    const secure = isSecureRequest(req);
    const maxAgeSeconds = Math.floor(ttlMs / 1000);
    const header = buildCookie({
      name: cookieName,
      value: encodeURIComponent(token),
      maxAge: maxAgeSeconds,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const clearSessionCookie = (req: UiAuthRequest, res: UiAuthHeaderResponse): void => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: cookieName,
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const verifyPassword = (candidate: unknown): boolean => {
    if (!candidate) {
      return false;
    }
    const normalizedCandidate = normalizePassword(candidate);
    if (!normalizedCandidate) {
      return false;
    }
    try {
      const candidateHash = crypto.scryptSync(normalizedCandidate, salt, 64);
      return crypto.timingSafeEqual(candidateHash, expectedHash);
    } catch {
      return false;
    }
  };

  const isSessionValid = async (token: string | null): Promise<boolean> => {
    if (!token) {
      return false;
    }
    try {
      await jwtVerify(token, jwtSecret);
      return true;
    } catch {
      return false;
    }
  };

  const issueSession = async (
    req: UiAuthRequest,
    res: UiAuthHeaderResponse,
    { trustDevice = false }: { trustDevice?: boolean } = {},
  ): Promise<string> => {
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const token = await new SignJWT({ type: 'ui-session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ttlMs / 1000 + 's')
      .sign(jwtSecret);
    setSessionCookie(req, res, token, ttlMs);
    return token;
  };

  startRateLimitCleanup();

  const respondUnauthorized = (req: UiAuthRequest, res: UiAuthResponse) => {
    res.status(401);
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson || req.path?.startsWith('/api')) {
      res.json({ error: 'UI authentication required', locked: true });
    } else if (res.type && res.send) {
      res.type('text/plain').send?.('Authentication required');
    } else {
      res.json({ error: 'UI authentication required', locked: true });
    }
  };

  const requireAuth = async (req: UiAuthRequest, res: UiAuthResponse, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const requireSessionAuth = async (req: UiAuthRequest, res: UiAuthResponse, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const handleSessionStatus = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      res.json({ authenticated: true });
      return;
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      res.json({ authenticated: true, scope: 'client' });
      return;
    }
    clearSessionCookie(req, res);
    res.status(401).json({ authenticated: false, locked: true });
  };

  const resolveAuthenticatedSessionToken = async (
    req: UiAuthRequest,
    { allowUrlToken = true }: { allowUrlToken?: boolean } = {},
  ): Promise<string | null> => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return token;
    }
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientSessionToken(clientAuth) : null;
  };

  const resolveAuthContext = async (
    req: UiAuthRequest,
    _res: UiAuthResponse | null,
    { allowClientAuth = true, allowUrlToken = true }: { allowClientAuth?: boolean; allowUrlToken?: boolean } = {},
  ) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return { type: 'session', token };
    }
    if (!allowClientAuth) return null;
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientAuthContext(clientAuth) : null;
  };

  const resolveWebSocketAuthContext = async (req: UiAuthRequest) => resolveAuthContext(req, null);

  const handleUrlAuthToken = async (req: UiAuthRequest, res: UiAuthResponse) => {
    const sessionToken = await resolveAuthenticatedSessionToken(req, { allowUrlToken: false });
    if (!sessionToken) {
      clearSessionCookie(req, res);
      return respondUnauthorized(req, res);
    }
    // Preserve whether the grant came from a UI session or a bearer client.
    const cookieToken = getTokenFromRequest(req);
    const bearerToken = await isSessionValid(cookieToken) ? undefined : getBearerTokenFromRequest(req) || undefined;
    res.setHeader('Cache-Control', 'no-store');
    return res.json(issueUrlAuthTokenForSession(sessionToken, bearerToken));
  };

  const handleSessionCreate = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter ?? 0);
      res.status(429).json({
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter
      });
      return;
    }

    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyPassword(candidate)) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    await issueSession(req, res, { trustDevice });
    let clientTokenResult = null;
    if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
      clientTokenResult = await clientAuthController.createClient({
        label: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        profile: req.body?.clientProfile,
        dedupeKey: req.body?.dedupeKey,
        reuseDedupeIdentity: true,
        authMethod: 'password',
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
    });
  };

  const respondPasskeyError = (res: UiAuthResponse, error: unknown): void => {
    const record = asRecord(error);
    const statusCode = typeof record?.statusCode === 'number' ? record.statusCode : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Passkey request failed' });
  };

  const handlePasskeyStatus = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      res.json(await passkeyController.getStatus(req));
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationOptions = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label : '';
      const options = await passkeyController.beginRegistration(req, { label });
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationVerify = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      const result = await passkeyController.finishRegistration(req.body);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationOptions = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      const options = await passkeyController.beginAuthentication(req);
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationVerify = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      await passkeyController.finishAuthentication(req.body);
      const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
      const ttlMs = resolveSessionTtlMs(trustDevice);
      await issueSession(req, res, { trustDevice });
      let clientTokenResult = null;
      if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
        clientTokenResult = await clientAuthController.createClient({
          label: req.body?.clientLabel,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          clientKind: req.body?.clientKind,
          dedupeKey: req.body?.dedupeKey,
          authMethod: 'passkey',
          deviceName: req.body?.deviceName,
          devicePlatform: req.body?.devicePlatform,
          deviceModel: req.body?.deviceModel,
          appVersion: req.body?.appVersion,
        });
      }
      res.json({
        authenticated: true,
        ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyList = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      res.json({ passkeys: await passkeyController.listPasskeys(req) });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRevoke = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      const result = await passkeyController.revokePasskey(req, req.params?.id);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handleResetAuth = async (req: UiAuthRequest, res: UiAuthResponse): Promise<void> => {
    try {
      const passkeyResult = await passkeyController.clearAllPasskeys();
      rotateJwtSecret();
      clearSessionCookie(req, res);
      res.json({
        cleared: true,
        clearedPasskeys: passkeyResult.clearedCount,
        signedOutEverywhere: true,
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const dispose = (): void => {
    loginRateLimiter.clear();
    stopRateLimitCleanup();
    passkeyController.dispose();
  };

  return {
    enabled: true,
    requireAuth,
    requireSessionAuth,
    resolveAuthContext,
    resolveWebSocketAuthContext,
    handleSessionStatus,
    handleSessionCreate,
    handleUrlAuthToken,
    handlePasskeyStatus,
    handlePasskeyRegistrationOptions,
    handlePasskeyRegistrationVerify,
    handlePasskeyAuthenticationOptions,
    handlePasskeyAuthenticationVerify,
    handlePasskeyList,
    handlePasskeyRevoke,
    handleResetAuth,
    issueTrustedSession: (req: UiAuthRequest, res: UiAuthResponse) => issueSession(req, res, { trustDevice: true }),
    ensureSessionToken: async (req: UiAuthRequest, res: UiAuthHeaderResponse | null) => {
      void res;
      return resolveAuthenticatedSessionToken(req);
    },
    dispose,
  };
};
