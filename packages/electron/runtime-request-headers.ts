const isReservedRuntimeRequestHeaderName = (name: unknown): boolean => {
  return String(name || '').trim().toLowerCase() === 'authorization';
};

export const sanitizeRuntimeRequestHeaders = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const next: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (isReservedRuntimeRequestHeaderName(name)) continue;
    next[name] = value;
  }
  return next;
};

/** Native Host authentication calls declare their configured HTTPS target.
 * Never use this for browser requests, whose actual Origin must be retained.
 * Redirects could carry pairing secrets or custom access credentials elsewhere.
 */
export const nativeHostRequestInit = (url: string | URL, init: RequestInit = {}): RequestInit => {
  const target = new URL(url);
  const headers = new Headers(init.headers);
  if (target.protocol === 'https:') headers.set('Origin', target.origin);
  return { ...init, headers, redirect: 'error' };
};
