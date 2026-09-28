import type { EgressHostConfiguration } from './egress.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate a UI write without silently discarding a malformed security choice. */
export function normalizeOutboundNetwork(value: unknown): RecordValue {
  if (!record(value) || !['auto', 'direct', 'proxy'].includes(String(value.mode))) {
    throw new Error('Outbound network mode must be auto, direct, or proxy');
  }
  const mode = value.mode as 'auto' | 'direct' | 'proxy';
  if (value.proxyUrl !== undefined && typeof value.proxyUrl !== 'string') throw new Error('Proxy URL must be a string');
  if (value.noProxy !== undefined && typeof value.noProxy !== 'string') throw new Error('NO_PROXY must be a string');
  if (value.credentialRef !== undefined && typeof value.credentialRef !== 'string') throw new Error('Proxy credential binding must be a string');
  const proxyUrl = typeof value.proxyUrl === 'string' ? value.proxyUrl.trim() : '';
  if (mode === 'proxy') {
    let url: URL;
    try { url = new URL(proxyUrl); } catch { throw new Error('A valid proxy URL is required'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Proxy URL must be an HTTP(S) origin without credentials or path');
    }
  }
  return { mode, proxyUrl, noProxy: typeof value.noProxy === 'string' ? value.noProxy.trim() : '',
    ...(typeof value.credentialRef === 'string' ? { credentialRef: value.credentialRef } : {}) };
}

/** Fixed secret reference in the executing Host's Pi auth.json owner. */
export const OUTBOUND_PROXY_CREDENTIAL_REF = 'varin-host-egress-proxy';

export function outboundProxyBinding(document: RecordValue): { credentialRef: string; proxyOrigin: string } | null {
  if (document.outboundNetwork === undefined) return null;
  const setting = normalizeOutboundNetwork(document.outboundNetwork);
  if (setting.mode !== 'proxy' || typeof setting.credentialRef !== 'string' || !setting.credentialRef) return null;
  return { credentialRef: setting.credentialRef, proxyOrigin: new URL(setting.proxyUrl as string).origin };
}

export function encodeOutboundProxyAuth(credentialRef: string, proxyOrigin: string, username: string, password: string): string {
  return Buffer.from(JSON.stringify({ credentialRef, proxyOrigin, username, password }), 'utf8').toString('base64');
}

export function readOutboundProxyAuth(auth: RecordValue, credentialRef: string, proxyOrigin: string): { username: string; password: string } | undefined {
  const entry = auth[OUTBOUND_PROXY_CREDENTIAL_REF];
  if (entry === undefined) return undefined;
  if (!record(entry) || entry.type !== 'api_key' || typeof entry.key !== 'string') {
    throw new Error('Proxy credential reference is malformed');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(entry.key, 'base64').toString('utf8')); }
  catch { throw new Error('Proxy credential reference is malformed'); }
  if (!record(decoded) || typeof decoded.username !== 'string' || typeof decoded.password !== 'string'
    || typeof decoded.credentialRef !== 'string' || typeof decoded.proxyOrigin !== 'string') {
    throw new Error('Proxy credential reference is malformed');
  }
  if (decoded.credentialRef !== credentialRef || decoded.proxyOrigin !== proxyOrigin) return undefined;
  return { username: decoded.username, password: decoded.password };
}

/** Preserve malformed external edits as a fail-closed state for the egress runtime. */
export function readEgressHostConfiguration(document: RecordValue, auth: RecordValue = {}): EgressHostConfiguration | undefined {
  if (document.outboundNetwork === undefined) return undefined;
  try {
    const setting = normalizeOutboundNetwork(document.outboundNetwork);
    const proxyAuth = setting.mode === 'proxy' && setting.credentialRef
      ? readOutboundProxyAuth(auth, setting.credentialRef as string, new URL(setting.proxyUrl as string).origin)
      : undefined;
    return {
      mode: setting.mode as EgressHostConfiguration['mode'],
      proxyUrl: setting.proxyUrl as string,
      noProxy: setting.noProxy as string,
      ...(proxyAuth ? { proxyAuth } : {}),
    };
  } catch (error) {
    return { mode: 'proxy', invalid: error instanceof Error ? error.message : 'invalid Host egress configuration' };
  }
}
