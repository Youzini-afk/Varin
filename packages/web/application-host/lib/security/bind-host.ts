import net from 'node:net';

const stripIpv6Brackets = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const normalizeIpv4MappedAddress = (host: unknown): string => {
  const normalized = stripIpv6Brackets(host);
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match?.[1] ?? normalized;
};

const ALL_NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)*$/;

/** Normalize a Node TCP bind host without resolving it or narrowing valid DNS names. */
export const normalizeBindHost = (host: unknown): string | null => {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
    if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) return null;
    const address = trimmed.slice(1, -1);
    return net.isIP(address) === 6 ? address : null;
  }
  if (net.isIP(trimmed) !== 0) return trimmed;
  if (ALL_NUMERIC_DOTTED_RE.test(trimmed)) return null;
  if (/[\s/:\\@?#]/u.test(trimmed)) return null;

  const hostname = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!hostname || hostname.length > 253 || hostname.split('.').some((label) => !label)) return null;
  return trimmed;
};

const isLoopbackIpv4 = (host: string): boolean => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host: unknown): boolean => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

export const isNetworkExposedBindHost = (host: unknown): boolean => !isLoopbackBindHost(host);

export const getInvalidBindHostErrorMessage = (host: unknown): string =>
  `Invalid Varin bind host: ${JSON.stringify(host)}. Use a hostname or IP address without a URL scheme, port, or path.`;

export const isUnsafeUnauthenticatedLanAllowed = (env: NodeJS.ProcessEnv = process.env, explicitlyAllowed = false): boolean =>
  explicitlyAllowed === true || env?.VARIN_ALLOW_UNAUTHENTICATED_LAN === 'true';

export const getUnauthenticatedLanErrorMessage = (host: unknown): string =>
  `Varin refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password or VARIN_UI_PASSWORD before exposing it over LAN, '
  + 'or set VARIN_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';
