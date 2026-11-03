import type { IncomingHttpHeaders } from 'node:http';
import { isPackagedClientOrigin } from './client-origins.js';

export interface SecurityRequest {
  headers: IncomingHttpHeaders;
  socket?: object | undefined;
}

export interface UpgradeSocket {
  destroyed?: boolean | undefined;
  destroy(): void;
  write(value: string | Buffer): unknown;
}

export interface RequestSecurityDependencies {
  readSettingsFromDisk(): Promise<Record<string, unknown>>;
}

export const createRequestSecurityRuntime = (deps: RequestSecurityDependencies) => {
  const { readSettingsFromDisk } = deps;
  const getUiSessionTokenFromRequest = (req: SecurityRequest | null | undefined): string | null => {
    const cookieHeader = req?.headers?.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      return null;
    }
    const segments = cookieHeader.split(';');
    for (const segment of segments) {
      const [rawName, ...rest] = segment.split('=');
      const name = rawName?.trim();
      if (!name) continue;
      if (name !== 'varin_ui_session') continue;
      const value = rest.join('=').trim();
      try {
        return decodeURIComponent(value || '');
      } catch {
        return value || null;
      }
    }
    return null;
  };

  const rejectWebSocketUpgrade = (
    socket: UpgradeSocket | null | undefined,
    statusCode: number,
    reason: unknown,
  ): void => {
    if (!socket || socket.destroyed) {
      return;
    }

    const message = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
    const body = Buffer.from(message, 'utf8');
    const statusText = ({
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
    } as Record<number, string>)[statusCode] || 'Bad Request';

    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n\r\n`
      );
      socket.write(body);
    } catch {
      // The peer may already have closed the upgrade socket.
    }

    try {
      socket.destroy();
    } catch {
      // Destroy is best-effort after the rejection response.
    }
  };

  const getRequestOriginCandidates = async (req: SecurityRequest): Promise<Set<string>> => {
    const origins = new Set<string>();
    const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0]?.trim().toLowerCase() ?? ''
      : '';
    const encrypted = Boolean(
      req.socket
      && 'encrypted' in req.socket
      && req.socket.encrypted === true
    );
    const protocol = forwardedProto || (encrypted ? 'https' : 'http');

    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0]?.trim() ?? ''
      : '';
    const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

    if (host) {
      origins.add(`${protocol}://${host}`);
      const [hostname, port] = host.split(':');
      const normalizedHost = typeof hostname === 'string' ? hostname.toLowerCase() : '';
      const portSuffix = typeof port === 'string' && port.length > 0 ? `:${port}` : '';
      if (normalizedHost === 'localhost') {
        origins.add(`${protocol}://127.0.0.1${portSuffix}`);
        origins.add(`${protocol}://[::1]${portSuffix}`);
      } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
        origins.add(`${protocol}://localhost${portSuffix}`);
      }
    }

    try {
      const settings = await readSettingsFromDisk();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
      // A settings read failure must not grant an additional allowed origin.
    }

    return origins;
  };

  const isRequestOriginAllowed = async (req: SecurityRequest): Promise<boolean> => {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (!originHeader) {
      return false;
    }

    if (isPackagedClientOrigin(originHeader)) {
      return true;
    }

    let normalizedOrigin = '';
    try {
      normalizedOrigin = new URL(originHeader).origin;
    } catch {
      return false;
    }

    const allowedOrigins = await getRequestOriginCandidates(req);
    return allowedOrigins.has(normalizedOrigin);
  };

  return {
    getUiSessionTokenFromRequest,
    rejectWebSocketUpgrade,
    isRequestOriginAllowed,
  };
};
