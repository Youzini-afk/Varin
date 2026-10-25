// Where the private relay lives. Varin ships no relay of its own and no default
// endpoint: an operator points the server at one with VARIN_RELAY_URL, and
// without it the relay transport is unavailable. The running host and the
// `varin connect-url` CLI both resolve it here, so a pairing link always names
// the relay the host dials.

export const RELAY_URL_ENV = 'VARIN_RELAY_URL';

export type RelayEndpoint =
  | { state: 'configured'; url: string }
  | { state: 'missing' }
  | { state: 'invalid' };

export type RelayUnavailableCode = 'relay_unconfigured' | 'relay_invalid_url';

export const isValidRelayUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
};

export const resolveRelayEndpoint = (env: Record<string, string | undefined> = process.env): RelayEndpoint => {
  const raw = env[RELAY_URL_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return { state: 'missing' };
  return isValidRelayUrl(raw) ? { state: 'configured', url: raw.trim() } : { state: 'invalid' };
};

const unavailableDetails = (endpoint: Exclude<RelayEndpoint, { state: 'configured' }>) => (
  endpoint.state === 'missing'
    ? { code: 'relay_unconfigured' as const, message: `The relay is not configured. Set ${RELAY_URL_ENV} on the server to a ws:// or wss:// relay endpoint.` }
    : { code: 'relay_invalid_url' as const, message: `${RELAY_URL_ENV} is not a ws:// or wss:// URL, so the relay is unavailable.` }
);

export const relayUnavailableMessage = (endpoint: Exclude<RelayEndpoint, { state: 'configured' }>): string => (
  unavailableDetails(endpoint).message
);

/** Thrown when something asks for the relay and no usable endpoint is configured. */
export class RelayUnavailableError extends Error {
  readonly code: RelayUnavailableCode;

  constructor(endpoint: Exclude<RelayEndpoint, { state: 'configured' }>) {
    const { code, message } = unavailableDetails(endpoint);
    super(message);
    this.name = 'RelayUnavailableError';
    this.code = code;
  }
}

export const isRelayUnavailableError = (error: unknown): error is RelayUnavailableError => (
  error instanceof Error
  && (error as { code?: unknown }).code !== undefined
  && ((error as { code?: unknown }).code === 'relay_unconfigured' || (error as { code?: unknown }).code === 'relay_invalid_url')
);
