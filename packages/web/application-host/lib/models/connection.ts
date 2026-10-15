/** Validated, credential-free routing options shared by every model operation. */
import type { ModelConnectionOptions, ModelOperation } from '@varin/application-client';
import type { EgressOverride } from '../harness/egress.js';
import { ModelConfigurationError, object } from './configuration.js';

const invalid = (message: string): never => { throw new ModelConfigurationError('model-connection-invalid', message); };
const operations: readonly ModelOperation[] = ['chat', 'embedding', 'rerank', 'decision', 'image-generation', 'image-editing'];
const secretHeader = /(?:^|[-_])(?:authorization|authentication|auth|bearer|cookie|cookies|token|secret|password|credential|credentials|session|signature|(?:api|access|private|subscription|security)[-_]?key)(?:$|[-_])/i;
const transportHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection', 'upgrade', 'trailer', 'te']);

export function validateModelPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/u.test(path)) {
    return invalid('Model paths must start with a single / and cannot contain an origin, query or fragment');
  }
  // Check escaped separators and dot segments too, before URL implementations normalize them.
  let decoded = path;
  for (;;) {
    if (decoded.split('/').some(segment => segment === '.' || segment === '..') || /[\\?#\u0000-\u001f\u007f]/u.test(decoded)) {
      return invalid('Model paths cannot traverse directories or contain a query or fragment');
    }
    if (!decoded.includes('%')) break;
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return invalid('Model path encoding is invalid'); }
    if (next === decoded) break;
    if (next.split('/').length !== decoded.split('/').length) return invalid('Model paths cannot contain escaped separators');
    decoded = next;
  }
}

export function validateModelConnection(value: unknown, supported: readonly ModelOperation[] = operations, credentialHeader?: string): asserts value is ModelConnectionOptions | undefined {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).some(key => !['headers', 'paths', 'proxy'].includes(key))) return invalid('Model connection options are invalid');
  if (value.headers !== undefined) {
    if (!object(value.headers)) return invalid('Model headers must be a string map');
    const seen = new Set<string>();
    for (const [name, content] of Object.entries(value.headers)) {
      const key = name.toLowerCase();
      if (secretHeader.test(name) || key === credentialHeader?.toLowerCase()) return invalid('Sensitive model headers must come from the credential service');
      if (!/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(name) || typeof content !== 'string' || seen.has(key) || transportHeaders.has(key)) return invalid('Model HTTP headers are invalid or conflict with transport headers');
      try { new Headers({ [name]: content }); } catch { return invalid('Model HTTP header values are invalid'); }
      seen.add(key);
    }
  }
  if (value.paths !== undefined) {
    if (!object(value.paths)) return invalid('Model paths must be an operation-to-path map');
    for (const [operation, path] of Object.entries(value.paths)) {
      if (!supported.includes(operation as ModelOperation)) return invalid('The channel does not support a configured model path operation');
      validateModelPath(path);
    }
  }
  if (value.proxy !== undefined) {
    const proxy = value.proxy;
    if (!object(proxy) || !['direct', 'proxy'].includes(String(proxy.mode)) || Object.keys(proxy).some(key => key !== 'mode' && (proxy.mode !== 'proxy' || key !== 'url'))) return invalid('Select a direct connection or an HTTP proxy');
    if (proxy.mode === 'proxy') {
      let url: URL;
      try { if (typeof proxy.url !== 'string') throw new Error(); url = new URL(proxy.url); } catch { return invalid('Enter a complete HTTP proxy URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid('Use an HTTP proxy origin without credentials, path, query or fragment');
    }
  }
}

export function appendModelPath(baseUrl: string, path: string): string {
  validateModelPath(path);
  let base: URL;
  try { base = new URL(baseUrl); } catch { return invalid('Enter a complete model endpoint'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return invalid('Custom model paths require an HTTP endpoint without credentials, query or fragment');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  return base.toString();
}

export function modelEgressOverride(connection: ModelConnectionOptions | undefined): EgressOverride | undefined {
  const proxy = connection?.proxy;
  return proxy?.mode === 'direct' ? { mode: 'direct' } : proxy ? { mode: 'proxy', proxyUrl: proxy.url } : undefined;
}
