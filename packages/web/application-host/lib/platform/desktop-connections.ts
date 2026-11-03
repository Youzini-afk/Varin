/** Shared desktop connection owner. No Host/Catalog or Electron imports. */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SettingsFileStore } from '@varin/settings-store';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.js';
const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type DesktopConnectionFetch = (url: string, init: RequestInit) => Promise<Response>;
export async function getOrCreateDesktopInstallId(store: Pick<SettingsFileStore, 'readSync' | 'update'>): Promise<string> {
  const existing = store.readSync().desktopInstallId;
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const generated = randomUUID();
  await store.update(root => {
    if (typeof root.desktopInstallId !== 'string' || !root.desktopInstallId.trim()) root.desktopInstallId = generated;
  });
  const after = store.readSync().desktopInstallId;
  if (typeof after !== 'string' || !after.trim()) throw new Error('Desktop installation identity was not persisted');
  return after.trim();
}
export function desktopDeviceMetadata(platform: NodeJS.Platform, appVersion?: string) {
  const devicePlatform = ({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Partial<Record<NodeJS.Platform, string>>)[platform];
  return { ...(devicePlatform ? { devicePlatform } : {}), ...(appVersion ? { appVersion } : {}) };
}
export const normalizeHostUrl = (raw: unknown): string | null => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const isMachineLocalHostname = (hostname: unknown): boolean => {
  const clean = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0' || clean === '::') {
    return true;
  }
  try {
    return Object.values(os.networkInterfaces()).some((entries) =>
      (entries || []).some((entry) => entry?.address === clean));
  } catch {
    return false;
  }
};

export const isKnownLocalDesktopUrl = (targetUrl: unknown, localUrl: string | null | undefined): boolean => {
  if (!localUrl) return false;
  try { if (new URL(String(targetUrl)).origin === new URL(localUrl).origin) return true; } catch { return false; }
  // The embedded server bound to 0.0.0.0 for LAN access is still THIS
  // machine's server when addressed via any of its own interfaces on the same
  // port — the minted client token must carry the desktop-local kind, or the
  // server's client-create gate rejects it (the "Local — Auth required" +
  // unreachable-screen regression).
  try {
    const normalizedTarget = normalizeHostUrl(targetUrl);
    if (!normalizedTarget) return false;
    const target = new URL(normalizedTarget);
    const local = new URL(localUrl);
    const portOf = (url: URL): string => url.port || (url.protocol === 'https:' ? '443' : '80');
    return portOf(target) === portOf(local) && isMachineLocalHostname(target.hostname);
  } catch {
    return false;
  }
};

export const buildHealthUrl = (url: unknown): string | null => {
  try {
    const normalized = normalizeHostUrl(url);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/health`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const buildVersionUrl = (url: unknown): string | null => {
  try {
    const normalized = normalizeHostUrl(url);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/api/version`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const buildSessionStatusUrl = (url: unknown): string | null => {
  try {
    const normalized = normalizeHostUrl(url);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/auth/session`;
    return parsed.toString();
  } catch {
    return null;
  }
};

export type HostProbeStatus = 'auth' | 'incompatible' | 'ok' | 'unreachable' | 'update-recommended' | 'wrong-service';
export interface HostProbeResult { latencyMs: number; status: HostProbeStatus }

const classifyVersionPayload = (payload: unknown): Exclude<HostProbeStatus, 'auth' | 'unreachable'> => {
  const value = recordOf(payload);
  const compatibility = recordOf(value.compatibility);
  if (value.status !== 'ok' || Object.keys(compatibility).length === 0) {
    return 'wrong-service';
  }

  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes('api.runtime-url.v1')) {
    return 'incompatible';
  }

  if (compatibility.apiVersion !== 1 || typeof compatibility.minClientApiVersion !== 'number' || compatibility.minClientApiVersion > 1) {
    return 'update-recommended';
  }

  return 'ok';
};

const extractCookieHeader = (response: Response): string => {
  const getSetCookie = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie.bind(response.headers)
    : null;
  const cookies = getSetCookie ? getSetCookie() : [];
  const rawCookies = cookies.length > 0
    ? cookies
    : String(response.headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,=]+=[^;,]+)/);
  return rawCookies
    .map((cookie) => String(cookie || '').split(';')[0]?.trim() || '')
    .filter(Boolean)
    .join('; ');
};


export function createDesktopConnections(options: {
  /** A single HTTP hop, backed by the desktop's system proxy/certificate stack. */
  fetch: DesktopConnectionFetch;
  getInstallId(): Promise<string>;
  deviceMetadata(): { devicePlatform?: string; appVersion?: string };
  isLocalRuntimeUrl(url: string): boolean;
}) {
  const isLocalRuntimeUrl = options.isLocalRuntimeUrl;
  const desktopDeviceMetadata = options.deviceMetadata;
  const getOrCreateDesktopInstallId = options.getInstallId;
  const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
  const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';
  const REMOTE_DESKTOP_CLIENT_KIND = 'desktop';
  // Credentials, passwords and custom gateway headers never cross an origin
  // boundary. Redirects are not delegated to an opaque automatic fetch policy.
  const fetch: DesktopConnectionFetch = async (url, init) => {
    const original = new URL(url);
    let target = original;
    let method = (init.method ?? 'GET').toUpperCase();
    const { body: originalBody, ...otherInit } = init;
    let body = originalBody;
    const headers = new Headers(init.headers);
    for (let count = 0; ; count++) {
      const response = await options.fetch(target.href, { ...otherInit, method, ...(body === undefined ? {} : { body }), headers, redirect: 'manual' });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel();
      const next = new URL(location, target);
      if (next.origin !== original.origin || next.username || next.password || count >= 20) throw new Error('Desktop connection redirect is outside the selected Host');
      if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
        method = 'GET'; body = undefined; headers.delete('content-type'); headers.delete('content-length');
      }
      target = next;
    }
  };
  const fetchVersionPayload = (url: string, { headers, timeoutMs }: { headers: Record<string, string>; timeoutMs: number }) => fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
const probeHostWithTimeout = async (
  url: string,
  timeoutMs: number,
  clientToken = '',
  requestHeaders: unknown = {},
  expectedServerId = '',
): Promise<HostProbeResult> => {
  const versionUrl = buildVersionUrl(url);
  const sessionStatusUrl = buildSessionStatusUrl(url);
  if (!versionUrl || !sessionStatusUrl) {
    throw new Error('Invalid URL');
  }

  const started = Date.now();

  // Identity gate for learned/untrusted addresses: verify the UNAUTHENTICATED
  // /health identity before the token-carrying version fetch, so the bearer
  // token is never sent to a re-assigned address that now belongs to a
  // different machine. Older servers omit serverId from /health; only an
  // explicit mismatch rejects.
  if (typeof expectedServerId === 'string' && expectedServerId.trim()) {
    const healthUrl = buildHealthUrl(url);
    if (healthUrl) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
        if (!response.ok) await response.body?.cancel();
        if (response.ok) {
          const payload = recordOf(await response.json().catch(() => null));
          const reported = typeof payload?.serverId === 'string' ? payload.serverId.trim() : '';
          if (reported && reported !== expectedServerId.trim()) {
            return { status: 'wrong-service', latencyMs: Date.now() - started };
          }
        }
      } catch {
        // Unreachable/timeout surfaces in the version fetch below.
      }
    }
  }

  try {
    const headers: Record<string, string> = { ...sanitizeRuntimeRequestHeaders(requestHeaders), Accept: 'application/json' };
    const token = typeof clientToken === 'string' ? clientToken.trim() : '';
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchVersionPayload(versionUrl, { headers, timeoutMs });
    const status = response.status;
    if (status < 200 || status >= 300) await response.body?.cancel();
    if (status === 401 || status === 403) {
      return { status: 'auth', latencyMs: Date.now() - started };
    }
    if (status < 200 || status >= 300) {
      return { status: 'unreachable', latencyMs: Date.now() - started };
    }
    const payload = recordOf(await response.json().catch(() => null));
    const versionStatus = classifyVersionPayload(payload);
    if (versionStatus !== 'ok') {
      return { status: versionStatus, latencyMs: Date.now() - started };
    }
    const sessionResponse = await fetchVersionPayload(sessionStatusUrl, { headers, timeoutMs });
    await sessionResponse.body?.cancel();
    if (sessionResponse.status === 401 || sessionResponse.status === 403) {
      return { status: 'auth', latencyMs: Date.now() - started };
    }
    if (!sessionResponse.ok) {
      return { status: 'unreachable', latencyMs: Date.now() - started };
    }
    return {
      status: versionStatus,
      latencyMs: Date.now() - started,
    };
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - started };
  }
};

const loginRemoteAndIssueClientToken = async ({ url, password, trustDevice, requestHeaders }: {
  password: unknown;
  requestHeaders: unknown;
  trustDevice: boolean;
  url: unknown;
}) => {
  const baseUrl = normalizeHostUrl(String(url || ''));
  const candidatePassword = typeof password === 'string' ? password : '';
  const safeRequestHeaders = sanitizeRuntimeRequestHeaders(requestHeaders || {});
  if (!baseUrl) throw new Error('Invalid URL');
  if (!candidatePassword) throw new Error('Password is required');

  // Stable client identity so re-login reuses the same device record. Local
  // uses the fixed desktop-local identity; remote uses this install's id with a
  // regular 'desktop' kind.
  const clientIdentity = isLocalRuntimeUrl(baseUrl)
    ? { clientKind: LOCAL_DESKTOP_CLIENT_KIND, dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY, ...desktopDeviceMetadata() }
    : { clientKind: REMOTE_DESKTOP_CLIENT_KIND, dedupeKey: `desktop:${await getOrCreateDesktopInstallId()}`, ...desktopDeviceMetadata() };

  const loginResponse = await fetch(new URL('/auth/session', `${baseUrl}/`).toString(), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...safeRequestHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      password: candidatePassword,
      trustDevice: trustDevice === true,
      issueClientToken: true,
      clientLabel: 'Varin Desktop',
      ...clientIdentity,
    }),
  });
  if (!loginResponse.ok) {
    await loginResponse.body?.cancel();
    return { ok: false, status: loginResponse.status };
  }

  const loginPayload = recordOf(await loginResponse.json().catch(() => null));
  if (typeof loginPayload?.clientToken === 'string' && loginPayload.clientToken.trim()) {
    return { ok: true, token: loginPayload.clientToken.trim() };
  }

  const cookie = extractCookieHeader(loginResponse);
  if (!cookie) {
    return { ok: false, status: 401 };
  }

  const tokenResponse = await fetch(new URL('/api/client-auth/clients', `${baseUrl}/`).toString(), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...safeRequestHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      label: 'Varin Desktop',
      ...clientIdentity,
    }),
  });
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel();
    return { ok: false, status: tokenResponse.status };
  }
  const tokenPayload = recordOf(await tokenResponse.json().catch(() => null));
  const token = typeof tokenPayload?.token === 'string' ? tokenPayload.token.trim() : '';
  return token ? { ok: true, token } : { ok: false, status: 500 };
};


return { probeHostWithTimeout, loginRemoteAndIssueClientToken };
}
