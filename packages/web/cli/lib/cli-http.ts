import { buildLocalUrl } from './cli-network.js';
import { readDesktopLocalClientTokenFromSettings, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import { recordOf, type CliOptions } from './cli-types.js';

const UI_SESSION_COOKIE_NAME = 'varin_ui_session';

interface HeadersLike {
  get?(name: string): string | null;
  getSetCookie?(): string[];
  raw?(): Record<string, string[] | undefined>;
}

export interface FetchResponseLike {
  headers?: HeadersLike;
  json(): Promise<unknown>;
  ok: boolean;
  status?: number | undefined;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<FetchResponseLike>;

function extractUiSessionCookie(response: FetchResponseLike): string | null {
  const values: string[] = [];
  const direct = response?.headers?.get?.('set-cookie');
  if (typeof direct === 'string' && direct.length > 0) {
    values.push(direct);
  }
  const getSetCookie = response?.headers?.getSetCookie;
  if (typeof getSetCookie === 'function') {
    const setCookies = getSetCookie.call(response.headers);
    if (Array.isArray(setCookies)) {
      values.push(...setCookies.filter((value) => typeof value === 'string' && value.length > 0));
    }
  }
  const raw = response?.headers?.raw?.();
  if (Array.isArray(raw?.['set-cookie'])) {
    values.push(...raw['set-cookie'].filter((value) => typeof value === 'string' && value.length > 0));
  }

  for (const setCookie of values) {
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)(${UI_SESSION_COOKIE_NAME}=[^;]+)`));
    if (match?.[1]) return match[1];
  }
  return null;
}

async function resolveUiPasswordForPort(port: number, options: CliOptions = {}): Promise<string | null> {
  if (options.explicitUiPassword && typeof options.uiPassword === 'string' && options.uiPassword.trim().length > 0) {
    return options.uiPassword;
  }
  const instanceOptions = readInstanceOptions(await getInstanceFilePath(port));
  if (typeof instanceOptions?.uiPassword === 'string' && instanceOptions.uiPassword.trim().length > 0) {
    return instanceOptions.uiPassword;
  }
  return typeof options.uiPassword === 'string' && options.uiPassword.trim().length > 0
    ? options.uiPassword
    : null;
}

async function createUiSessionCookie(port: number, password: unknown, timeoutMs: number): Promise<string | null> {
  if (typeof password !== 'string' || password.length === 0) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildLocalUrl(port, '/auth/session'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return extractUiSessionCookie(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getDesktopLocalAuthHeader(port: number, requestHeaders: Record<string, string>): string | null {
  if (requestHeaders.Authorization || requestHeaders.authorization) {
    return null;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  if (desktopPort !== port) {
    return null;
  }
  const token = readDesktopLocalClientTokenFromSettings();
  return token ? `Bearer ${token}` : null;
}

async function requestServerShutdown(port: number, hostOverride?: string): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(buildLocalUrl(port, '/api/system/shutdown', hostOverride), {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface JsonRequestResult {
  body: Record<string, unknown> | null;
  value: unknown;
  response: Response;
}

async function requestJson(port: number, endpoint: string, options: CliOptions = {}): Promise<JsonRequestResult> {
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 4000;
  const fetchOptions: RequestInit = {
    ...(options.method ? { method: options.method } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestUrl = buildLocalUrl(port, endpoint);
    const requestHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...Object.fromEntries(new Headers(options.headers).entries()),
    };
    const desktopAuth = getDesktopLocalAuthHeader(port, requestHeaders);
    if (desktopAuth) {
      requestHeaders.Authorization = desktopAuth;
    }
    const response = await fetch(requestUrl, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: controller.signal,
    });
    const rawBody: unknown = await response.json().catch(() => null);
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? recordOf(rawBody) : null;
    if (response.status === 401 && body?.error === 'UI authentication required') {
      const uiPassword = await resolveUiPasswordForPort(port, options);
      const cookie = await createUiSessionCookie(port, uiPassword, timeoutMs);
      if (cookie) {
        const retryResponse = await fetch(requestUrl, {
          ...fetchOptions,
          headers: {
            ...requestHeaders,
            Cookie: cookie,
          },
          signal: controller.signal,
        });
        const rawRetryBody: unknown = await retryResponse.json().catch(() => null);
        const retryBody = rawRetryBody && typeof rawRetryBody === 'object' && !Array.isArray(rawRetryBody)
          ? recordOf(rawRetryBody)
          : null;
        return { response: retryResponse, body: retryBody, value: rawRetryBody };
      }
    }
    return { response, body, value: rawBody };
  } catch (error) {
    const failure = recordOf(error);
    if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR') {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function isServerHealthReady(port: number, timeoutMs = 1000): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(buildLocalUrl(port, '/health'), {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerHealth(port: number, {
  timeoutMs = 60000,
  intervalMs = 250,
  onTick,
}: {
  intervalMs?: number;
  onTick?: (state: { complete?: boolean; elapsedMs: number; timedOut?: boolean; timeoutMs: number }) => void;
  timeoutMs?: number;
} = {}): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - start;
    if (typeof onTick === 'function') {
      onTick({ elapsedMs, timeoutMs });
    }
    if (await isServerHealthReady(port, Math.min(1000, intervalMs * 2))) {
      if (typeof onTick === 'function') {
        onTick({ elapsedMs: Math.min(Date.now() - start, timeoutMs), timeoutMs, complete: true });
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (typeof onTick === 'function') {
    onTick({ elapsedMs: timeoutMs, timeoutMs, timedOut: true });
  }
  return false;
}


async function fetchTunnelProvidersFromPort(
  port: number,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<unknown[] | null> {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/varin/tunnel/providers'));
    if (!response.ok) return null;
    const body = recordOf(await response.json().catch(() => null));
    return Array.isArray(body.providers) ? body.providers : null;
  } catch {
    return null;
  }
}

export interface SystemInfo {
  pid: number | null;
  runtime: string;
}

async function fetchSystemInfoFromPort(
  port: number,
  fetchImpl: FetchLike = globalThis.fetch,
  hostOverride?: string,
): Promise<SystemInfo | null> {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/system/info', hostOverride), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = recordOf(await response.json().catch(() => null));
    if (typeof body.runtime !== 'string') return null;

    return {
      runtime: body.runtime,
      pid: typeof body.pid === 'number' && Number.isFinite(body.pid) ? body.pid : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


export {
  requestServerShutdown,
  requestJson,
  isServerHealthReady,
  waitForServerHealth,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
};
