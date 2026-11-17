import crypto from 'crypto';
import { getExternalIngress } from './public-ingress.js';
interface TunnelRequest {
  connection?: { remoteAddress?: string | undefined } | undefined;
  headers: Record<string, string | string[] | undefined>;
  hostname?: string | undefined;
  secure?: boolean | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

interface CookieResponse {
  setHeader(name: string, value: string): unknown;
}

interface TunnelResponse extends CookieResponse {
  json(value: unknown): unknown;
  status(code: number): TunnelResponse;
}

type Next = () => unknown;

const BOOTSTRAP_TOKEN_COOKIE_SAFE_BYTES = 32;
const TUNNEL_SESSION_COOKIE_NAME = 'varin_tunnel_session';

const CONNECT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const CONNECT_RATE_LIMIT_LOCK_MS = 10 * 60 * 1000;
const CONNECT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const CONNECT_RATE_LIMIT_NO_IP_MAX_ATTEMPTS = 5;

interface BootstrapRecord {
  expiresAt: number | null;
  id: string;
  issuedAt: number;
  revokedAt: number | null;
  tokenHash: string;
  tunnelId: string;
  usedAt: number | null;
}

interface TunnelSessionRecord {
  createdAt: number;
  expiredAt: number | null;
  expiresAt: number;
  lastSeenAt: number;
  mode: string | null;
  publicUrl: string | null;
  revokedAt: number | null;
  revokedReason: string | null;
  sessionId: string;
  tunnelId: string;
}

interface RateLimitRecord { count: number; lastAttempt: number; lockedUntil: number | null }

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
    acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
};

const isSecureRequest = (req: TunnelRequest): boolean => {
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

const buildCookie = ({ name, value, maxAge, secure }: {
  maxAge: number;
  name: string;
  secure: boolean;
  value: string;
}): string => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
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

const nowTs = (): number => Date.now();

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

const normalizeHost = (candidate: unknown): string | null => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/:\d+$/, '');
};

const normalizeIpCandidate = (candidate: unknown): string | null => {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutBrackets = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;

  const withoutZone = withoutBrackets.split('%')[0];
  if (!withoutZone) {
    return null;
  }

  if (withoutZone.startsWith('::ffff:')) {
    const mappedIpv4 = withoutZone.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mappedIpv4)) {
      return mappedIpv4;
    }
  }

  return withoutZone;
};

const getSocketRemoteIp = (req: TunnelRequest): string | null => {
  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  return normalizeIpCandidate(remoteAddress);
};

const isPrivateOrLoopbackIpv4 = (candidate: string): boolean => {
  const octets = candidate.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  if (first === 127) {
    return true;
  }
  if (first === 10) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  return false;
};

const isPrivateOrLoopbackIpv6 = (candidate: string): boolean => {
  if (candidate === '::1') {
    return true;
  }

  if (candidate.startsWith('fc') || candidate.startsWith('fd')) {
    return true;
  }

  return candidate.startsWith('fe8')
    || candidate.startsWith('fe9')
    || candidate.startsWith('fea')
    || candidate.startsWith('feb');
};

const isPrivateOrLoopbackIp = (candidate: unknown): boolean => {
  const normalized = normalizeIpCandidate(candidate);
  if (!normalized) {
    return false;
  }

  if (normalized.includes(':')) {
    return isPrivateOrLoopbackIpv6(normalized);
  }

  return isPrivateOrLoopbackIpv4(normalized);
};

const isLocalHost = (host: string | null, req: TunnelRequest): boolean => {
  if (!host) {
    return false;
  }

  const isLocalHostname = host === 'localhost'
    || host === 'host.docker.internal'
    || isPrivateOrLoopbackIp(host);
  return isLocalHostname && isPrivateOrLoopbackIp(getSocketRemoteIp(req));
};

const getClientIp = (req: TunnelRequest): string | null => {
  // Bootstrap-token exchange happens before authentication. Never let an
  // untrusted X-Forwarded-For value choose its rate-limit bucket.
  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req: TunnelRequest): string => {
  const ip = getClientIp(req);
  if (ip) {
    return ip;
  }
  return 'connect-rate-limit:no-ip';
};

const rateLimitMaxForKey = (key: string): number => {
  if (key === 'connect-rate-limit:no-ip') {
    return CONNECT_RATE_LIMIT_NO_IP_MAX_ATTEMPTS;
  }
  return CONNECT_RATE_LIMIT_MAX_ATTEMPTS;
};

export const createTunnelAuth = () => {
  let activeTunnelId: string | null = null;
  let activeTunnelHost: string | null = null;
  let activeTunnelMode: string | null = null;
  let activeTunnelPublicUrl: string | null = null;
  let bootstrapRecord: BootstrapRecord | null = null;

  const tunnelSessions = new Map<string, TunnelSessionRecord>();
  const connectRateLimiter = new Map<string, RateLimitRecord>();

  const clearTunnelSessionCookie = (req: TunnelRequest, res: CookieResponse): void => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: TUNNEL_SESSION_COOKIE_NAME,
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const setTunnelSessionCookie = (req: TunnelRequest, res: CookieResponse, sessionId: string, ttlMs: number): void => {
    const secure = isSecureRequest(req);
    const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
    const header = buildCookie({
      name: TUNNEL_SESSION_COOKIE_NAME,
      value: encodeURIComponent(sessionId),
      maxAge,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const classifyRequestScope = (req: TunnelRequest): 'local' | 'tunnel' | 'unknown-public' => {
    if (getExternalIngress(req)) return 'tunnel';
    const hostHeader = normalizeHost(typeof req.headers.host === 'string' ? req.headers.host : '');
    const reqHost = normalizeHost(typeof req.hostname === 'string' ? req.hostname : '') || hostHeader;

    if (activeTunnelHost && reqHost === activeTunnelHost) {
      return 'tunnel';
    }

    if (isLocalHost(reqHost, req)) {
      return 'local';
    }

    if (!activeTunnelId) {
      return 'local';
    }

    return 'unknown-public';
  };

  const revokeBootstrapToken = (): number => {
    if (!bootstrapRecord) {
      return 0;
    }
    if (bootstrapRecord.revokedAt) {
      return 0;
    }
    if (!bootstrapRecord.revokedAt) {
      bootstrapRecord.revokedAt = nowTs();
    }
    return 1;
  };

  const invalidateTunnelSessions = (tunnelId: string, reason = 'tunnel-stopped'): number => {
    const revokedAt = nowTs();
    let count = 0;
    for (const record of tunnelSessions.values()) {
      if (record.tunnelId === tunnelId && !record.revokedAt) {
        record.revokedAt = revokedAt;
        record.revokedReason = reason;
        count += 1;
      }
    }
    return count;
  };

  const revokeTunnelArtifacts = (tunnelId: string) => {
    const revokedBootstrapCount = bootstrapRecord && bootstrapRecord.tunnelId === tunnelId
      ? revokeBootstrapToken()
      : 0;
    const invalidatedSessionCount = invalidateTunnelSessions(tunnelId, 'tunnel-revoked');
    return { revokedBootstrapCount, invalidatedSessionCount };
  };

  const setActiveTunnel = ({ tunnelId, publicUrl, mode = null }: {
    mode?: string | null;
    publicUrl: string;
    tunnelId: string;
  }): void => {
    activeTunnelId = tunnelId;
    activeTunnelMode = mode;
    activeTunnelPublicUrl = publicUrl || null;
    try {
      activeTunnelHost = normalizeHost(new URL(publicUrl).host);
    } catch {
      activeTunnelHost = null;
    }
  };

  const clearActiveTunnel = (): void => {
    if (activeTunnelId) {
      revokeTunnelArtifacts(activeTunnelId);
    }
    activeTunnelId = null;
    activeTunnelHost = null;
    activeTunnelMode = null;
    activeTunnelPublicUrl = null;
    bootstrapRecord = null;
  };

  const isBootstrapRecordUsable = (record: BootstrapRecord | null): record is BootstrapRecord => {
    if (!record || record.revokedAt || record.usedAt) {
      return false;
    }
    if (typeof record.expiresAt === 'number' && nowTs() >= record.expiresAt) {
      return false;
    }
    return true;
  };

  const issueBootstrapToken = ({ ttlMs }: { ttlMs: number | null }) => {
    if (!activeTunnelId) {
      throw new Error('Tunnel is not active');
    }

    revokeBootstrapToken();

    const token = crypto.randomBytes(BOOTSTRAP_TOKEN_COOKIE_SAFE_BYTES).toString('base64url');
    const issuedAt = nowTs();
    const expiresAt = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? issuedAt + ttlMs : null;

    bootstrapRecord = {
      id: crypto.randomUUID(),
      tunnelId: activeTunnelId,
      tokenHash: hashToken(token),
      issuedAt,
      expiresAt,
      usedAt: null,
      revokedAt: null,
    };

    return {
      token,
      expiresAt,
    };
  };

  const getBootstrapStatus = () => {
    if (!isBootstrapRecordUsable(bootstrapRecord)) {
      return {
        hasBootstrapToken: false,
        bootstrapExpiresAt: null,
      };
    }

    return {
      hasBootstrapToken: true,
      bootstrapExpiresAt: bootstrapRecord.expiresAt,
    };
  };

  const checkConnectRateLimit = (req: TunnelRequest): { allowed: boolean; retryAfter: number } => {
    const key = getRateLimitKey(req);
    const now = nowTs();
    const maxAttempts = rateLimitMaxForKey(key);
    const record = connectRateLimiter.get(key);

    if (record?.lockedUntil && now < record.lockedUntil) {
      return {
        allowed: false,
        retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      };
    }

    if (!record || now - record.lastAttempt > CONNECT_RATE_LIMIT_WINDOW_MS) {
      return { allowed: true, retryAfter: 0 };
    }

    if (record.count >= maxAttempts) {
      const lockedUntil = now + CONNECT_RATE_LIMIT_LOCK_MS;
      connectRateLimiter.set(key, {
        count: record.count + 1,
        lastAttempt: now,
        lockedUntil,
      });
      return {
        allowed: false,
        retryAfter: Math.ceil(CONNECT_RATE_LIMIT_LOCK_MS / 1000),
      };
    }

    return { allowed: true, retryAfter: 0 };
  };

  const recordConnectFailedAttempt = (req: TunnelRequest): void => {
    const key = getRateLimitKey(req);
    const now = nowTs();
    const record = connectRateLimiter.get(key);

    if (!record || now - record.lastAttempt > CONNECT_RATE_LIMIT_WINDOW_MS) {
      connectRateLimiter.set(key, { count: 1, lastAttempt: now, lockedUntil: null });
      return;
    }

    connectRateLimiter.set(key, {
      count: record.count + 1,
      lastAttempt: now,
      lockedUntil: record.lockedUntil || null,
    });
  };

  const clearConnectRateLimit = (req: TunnelRequest): void => {
    const key = getRateLimitKey(req);
    connectRateLimiter.delete(key);
  };

  const getTunnelSessionFromRequest = (req: TunnelRequest): TunnelSessionRecord | null => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[TUNNEL_SESSION_COOKIE_NAME];
    if (!token) {
      return null;
    }
    const session = tunnelSessions.get(token);
    if (!session) {
      return null;
    }
    if (session.revokedAt) {
      return null;
    }
    if (session.expiresAt <= nowTs()) {
      if (!session.expiredAt) {
        session.expiredAt = nowTs();
      }
      return null;
    }
    if (session.tunnelId !== activeTunnelId) {
      return null;
    }
    session.lastSeenAt = nowTs();
    return session;
  };

  const requireTunnelSession = (req: TunnelRequest, res: TunnelResponse, next: Next): void => {
    const session = getTunnelSessionFromRequest(req);
    if (session) {
      next();
      return;
    }

    clearTunnelSessionCookie(req, res);
    res.status(401).json({
      error: 'Tunnel authentication required',
      locked: true,
      tunnelLocked: true,
    });
  };

  const exchangeBootstrapToken = ({ req, res, token, sessionTtlMs }: {
    req: TunnelRequest;
    res: CookieResponse;
    sessionTtlMs: number;
    token: unknown;
  }) => {
    const rateLimit = checkConnectRateLimit(req);
    if (!rateLimit.allowed) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfter: rateLimit.retryAfter,
      };
    }

    if (!activeTunnelId || !bootstrapRecord) {
      recordConnectFailedAttempt(req);
      return { ok: false, reason: 'inactive' };
    }

    if (!token || typeof token !== 'string') {
      recordConnectFailedAttempt(req);
      return { ok: false, reason: 'missing-token' };
    }

    if (!isBootstrapRecordUsable(bootstrapRecord)) {
      recordConnectFailedAttempt(req);
      return { ok: false, reason: 'expired' };
    }

    if (bootstrapRecord.tunnelId !== activeTunnelId) {
      recordConnectFailedAttempt(req);
      return { ok: false, reason: 'tunnel-mismatch' };
    }

    const incomingHash = hashToken(token);
    const expected = bootstrapRecord.tokenHash;
    const validHash = incomingHash.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(expected));

    if (!validHash) {
      recordConnectFailedAttempt(req);
      return { ok: false, reason: 'invalid-token' };
    }

    bootstrapRecord.usedAt = nowTs();
    clearConnectRateLimit(req);

    const sessionId = crypto.randomBytes(32).toString('base64url');
    const createdAt = nowTs();
    const expiresAt = createdAt + sessionTtlMs;

    tunnelSessions.set(sessionId, {
      sessionId,
      tunnelId: activeTunnelId,
      mode: activeTunnelMode,
      publicUrl: activeTunnelPublicUrl,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      expiredAt: null,
    });

    setTunnelSessionCookie(req, res, sessionId, sessionTtlMs);

    return {
      ok: true,
      sessionExpiresAt: expiresAt,
    };
  };

  const listTunnelSessions = () => {
    const now = nowTs();

    const sessions: Array<{
      createdAt: number;
      expiresAt: number;
      inactiveReason: string | null;
      lastSeenAt: number;
      mode: string | null;
      publicUrl: string | null;
      revokedAt: number | null;
      sessionId: string;
      status: string;
      tunnelId: string;
    }> = [];
    for (const record of tunnelSessions.values()) {
      const isExpired = record.expiresAt <= now;
      if (isExpired && !record.expiredAt) {
        record.expiredAt = now;
      }

      const active = !record.revokedAt && !isExpired && record.tunnelId === activeTunnelId;
      const status = active ? 'active' : 'inactive';
      const inactiveReason = record.revokedAt ? (record.revokedReason || 'revoked') : (isExpired ? 'expired' : 'inactive');

      sessions.push({
        sessionId: record.sessionId,
        tunnelId: record.tunnelId,
        mode: record.mode,
        publicUrl: record.publicUrl,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt,
        status,
        inactiveReason: status === 'inactive' ? inactiveReason : null,
      });
    }

    sessions.sort((a, b) => b.createdAt - a.createdAt);
    return sessions;
  };

  return {
    classifyRequestScope,
    setActiveTunnel,
    clearActiveTunnel,
    revokeTunnelArtifacts,
    issueBootstrapToken,
    getBootstrapStatus,
    requireTunnelSession,
    getTunnelSessionFromRequest,
    exchangeBootstrapToken,
    listTunnelSessions,
    clearTunnelSessionCookie,
    getActiveTunnelId: () => activeTunnelId,
    getActiveTunnelHost: () => activeTunnelHost,
    getActiveTunnelMode: () => activeTunnelMode,
  };
};
