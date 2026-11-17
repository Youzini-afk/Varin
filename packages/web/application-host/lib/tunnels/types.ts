import os from 'os';
import path from 'path';
import { isIP } from 'node:net';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';
export const TUNNEL_PROVIDER_REVERSE_PROXY = 'reverse-proxy';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';
export const TUNNEL_MODE_REVERSE_PROXY = 'reverse-proxy';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';
const TUNNEL_INTENT_PRIVATE_NETWORK = 'private-network';

export type TunnelProviderId = typeof TUNNEL_PROVIDER_CLOUDFLARE | typeof TUNNEL_PROVIDER_NGROK | typeof TUNNEL_PROVIDER_REVERSE_PROXY;
export type TunnelMode = typeof TUNNEL_MODE_QUICK | typeof TUNNEL_MODE_MANAGED_REMOTE | typeof TUNNEL_MODE_MANAGED_LOCAL | typeof TUNNEL_MODE_REVERSE_PROXY;
export type TunnelIntent =
  | typeof TUNNEL_INTENT_EPHEMERAL_PUBLIC
  | typeof TUNNEL_INTENT_PERSISTENT_PUBLIC
  | typeof TUNNEL_INTENT_PRIVATE_NETWORK;

export interface TunnelStartRequest {
  configPath: string | null | undefined;
  hostname: string;
  intent: TunnelIntent | undefined;
  mode: TunnelMode;
  provider: TunnelProviderId;
  token: string;
  reverseProxy?: ReverseProxyConfiguration | undefined;
}

export interface ReverseProxyConfiguration {
  publicOrigin: string;
  backend: { host: string; port: number };
}

// A configured URL is not evidence that HTTPS reaches this Host. Legacy
// providers do not report verification, represented by null in the service.
export type TunnelEndpointVerification = 'unverified' | 'verified';

export interface TunnelModeDescriptor {
  intent: TunnelIntent;
  key: TunnelMode;
  label?: string | undefined;
  requires?: string[] | undefined;
  stability?: string | undefined;
  supports?: string[] | undefined;
}

export interface TunnelProviderCapabilities {
  defaults?: { mode?: TunnelMode | undefined; optionDefaults?: Record<string, unknown> | undefined } | undefined;
  modes: TunnelModeDescriptor[];
  provider: TunnelProviderId;
}

export interface TunnelController {
  getEndpointVerification?(): TunnelEndpointVerification;
  getEffectiveConfigPath?(): string | null;
  getPublicUrl?(): string | null;
  getResolvedHostname?(): string | null;
  mode?: TunnelMode | undefined;
  provider?: TunnelProviderId | undefined;
  stop?(): unknown;
}

export interface TunnelAvailability extends Record<string, unknown> {
  available: boolean;
  message?: string | undefined;
}

export interface TunnelStartContext extends Record<string, unknown> {
  activePort: number | null;
  originUrl?: string | undefined;
}

export interface TunnelProvider {
  capabilities: TunnelProviderCapabilities;
  checkAvailability(): Promise<TunnelAvailability>;
  diagnose?(request?: Record<string, unknown>): Promise<unknown>;
  getMetadata?(controller: TunnelController | null): unknown;
  id: TunnelProviderId;
  resolvePublicUrl(controller: TunnelController | null): string | null;
  start(request: TunnelStartRequest, context: TunnelStartContext): Promise<TunnelController>;
  stop(controller: TunnelController): unknown;
}

const SUPPORTED_TUNNEL_INTENTS = new Set([
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
]);

const SUPPORTED_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_REVERSE_PROXY,
]);

export class TunnelServiceError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.details = details;
  }
}

const SUPPORTED_TUNNEL_PROVIDERS = new Set([
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_REVERSE_PROXY,
]);

const getPathApiForPlatform = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path);

export function isPathWithinDirectory(candidatePath: unknown, directoryPath: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof candidatePath !== 'string' || typeof directoryPath !== 'string') {
    return false;
  }

  const pathApi = getPathApiForPlatform(platform);
  const resolvedCandidate = pathApi.resolve(candidatePath);
  const resolvedDirectory = pathApi.resolve(directoryPath);
  const comparableCandidate = platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const comparableDirectory = platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  const directoryPrefix = comparableDirectory.endsWith(pathApi.sep)
    ? comparableDirectory
    : `${comparableDirectory}${pathApi.sep}`;

  return comparableCandidate === comparableDirectory || comparableCandidate.startsWith(directoryPrefix);
}

export function resolveTunnelConfigPath(value: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  const pathApi = getPathApiForPlatform(platform);
  let resolved;
  if (value === '~') {
    resolved = home;
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    resolved = pathApi.join(home, value.slice(2));
  } else {
    resolved = pathApi.resolve(value);
  }

  if (!isPathWithinDirectory(resolved, home, platform)) {
    throw new TunnelServiceError(
      'validation_error',
      `Config path must be within the home directory (${home}). Got: ${resolved}`
    );
  }
  return resolved;
}

export function normalizeTunnelProvider(value: unknown): TunnelProviderId {
  if (typeof value !== 'string') {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  const provider = value.trim().toLowerCase();
  if (!provider || !SUPPORTED_TUNNEL_PROVIDERS.has(provider)) {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  return provider as TunnelProviderId;
}

export function normalizeTunnelMode(value: unknown): TunnelMode {
  if (typeof value !== 'string') {
    return TUNNEL_MODE_QUICK;
  }
  const mode = value.trim().toLowerCase();
  if (!mode) {
    return TUNNEL_MODE_QUICK;
  }
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_MODE_QUICK;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
    return TUNNEL_MODE_MANAGED_REMOTE;
  }
  if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_MODE_MANAGED_LOCAL;
  }
  if (mode === TUNNEL_MODE_REVERSE_PROXY) {
    return TUNNEL_MODE_REVERSE_PROXY;
  }
  return TUNNEL_MODE_QUICK;
}

function normalizeTunnelIntent(value: unknown): TunnelIntent | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent as TunnelIntent;
}

function modeIntentFallback(mode: TunnelMode): TunnelIntent | undefined {
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL || mode === TUNNEL_MODE_REVERSE_PROXY) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  return undefined;
}

function normalizeTunnelModeForRequest(value: unknown): TunnelMode {
  if (value === undefined || value === null || value === '') return TUNNEL_MODE_QUICK;
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isSupportedTunnelMode(mode)) return mode;
  throw new TunnelServiceError('mode_unsupported', 'Unsupported tunnel mode');
}

export function normalizeReverseProxyConfiguration(value: unknown): ReverseProxyConfiguration {
  const config = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  let origin: URL;
  try {
    const input = typeof config.publicOrigin === 'string' ? config.publicOrigin.trim() : '';
    origin = new URL(input);
    if (!/^https:\/\/[^/?#]+\/?$/i.test(input) || /[\\\s]/.test(input)
      || origin.protocol !== 'https:' || origin.username || origin.password
      || origin.pathname !== '/' || input.includes('?') || input.includes('#')) throw new Error();
  } catch {
    // Do not echo invalid URLs: they can contain credentials or pairing data.
    throw new TunnelServiceError('validation_error', 'Reverse proxy publicOrigin must be an HTTPS origin without credentials, path, query, or fragment');
  }
  const backend = config.backend && typeof config.backend === 'object' && !Array.isArray(config.backend)
    ? config.backend as Record<string, unknown> : {};
  const host = backend.host === undefined ? '127.0.0.1'
    : typeof backend.host === 'string' ? backend.host.trim() : '';
  if (!host || (!isIP(host) && !/^[a-z\d_](?:[a-z\d_.-]*[a-z\d_])?$/i.test(host))) {
    throw new TunnelServiceError('validation_error', 'Reverse proxy backend host must be a hostname or IP address');
  }
  const port = backend.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelServiceError('validation_error', 'Reverse proxy backend port must be an integer from 1 to 65535');
  }
  return { publicOrigin: origin.origin, backend: { host, port } };
}

export function normalizeOptionalPath(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTunnelConfigPath(trimmed);
}

export function isSupportedTunnelMode(mode: unknown): mode is TunnelMode {
  return typeof mode === 'string' && SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(
  input: Record<string, unknown> = {},
  defaults: Record<string, unknown> = {},
): TunnelStartRequest {
  const providerInput = input.provider ?? defaults.provider;
  if (providerInput !== undefined && providerInput !== null && providerInput !== '') {
    const candidate = typeof providerInput === 'string' ? providerInput.trim().toLowerCase() : '';
    if (!SUPPORTED_TUNNEL_PROVIDERS.has(candidate)) {
      throw new TunnelServiceError('provider_unsupported', 'Unsupported tunnel provider');
    }
  }
  const provider = normalizeTunnelProvider(providerInput);
  const mode = normalizeTunnelModeForRequest(input.mode ?? defaults.mode
    ?? (provider === TUNNEL_PROVIDER_REVERSE_PROXY ? TUNNEL_MODE_REVERSE_PROXY : undefined));
  const explicitIntent = normalizeTunnelIntent(input.intent ?? defaults.intent);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(configPathValue);

  const tokenValue = input.token ?? defaults.token;
  const token = typeof tokenValue === 'string'
    ? tokenValue.trim()
    : '';

  const hostnameValue = input.hostname ?? defaults.hostname;
  const hostname = typeof hostnameValue === 'string'
    ? hostnameValue.trim().toLowerCase()
    : '';

  return {
    provider,
    mode,
    intent,
    configPath,
    token,
    hostname,
    ...(provider === TUNNEL_PROVIDER_REVERSE_PROXY
      ? { reverseProxy: normalizeReverseProxyConfiguration(input.reverseProxy ?? defaults.reverseProxy) }
      : {}),
  };
}

export function validateTunnelStartRequest(
  request: TunnelStartRequest,
  capabilities: TunnelProviderCapabilities,
): void {
  if (!request || typeof request !== 'object') {
    throw new TunnelServiceError('validation_error', 'Tunnel start request must be an object');
  }

  if (!request.provider) {
    throw new TunnelServiceError('validation_error', 'Tunnel provider is required');
  }

  if (!isSupportedTunnelMode(request.mode)) {
    throw new TunnelServiceError('mode_unsupported', `Unsupported tunnel mode: ${request.mode}`);
  }

  if (!capabilities || capabilities.provider !== request.provider) {
    throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
  }

  if (!Array.isArray(capabilities.modes)) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not declare tunnel modes`);
  }

  const modeDescriptor = capabilities.modes.find((entry) => entry?.key === request.mode);
  if (!modeDescriptor) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not support mode '${request.mode}'`);
  }

  if (typeof request.intent === 'string' && request.intent.length > 0) {
    if (!SUPPORTED_TUNNEL_INTENTS.has(request.intent)) {
      throw new TunnelServiceError('validation_error', `Unsupported tunnel intent: ${request.intent}`);
    }
    if (modeDescriptor.intent !== request.intent) {
      throw new TunnelServiceError(
        'validation_error',
        `Tunnel intent '${request.intent}' does not match mode '${request.mode}' (expected '${modeDescriptor.intent}')`
      );
    }
  }

  const requiredFields = Array.isArray(modeDescriptor.requires) ? modeDescriptor.requires : [];

  if (requiredFields.includes('token')) {
    if (!request.token) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel token is required');
    }
  }

  if (requiredFields.includes('hostname')) {
    if (!request.hostname) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel hostname is required');
    }
  }

  if (requiredFields.includes('configPath')) {
    if (request.configPath === undefined || request.configPath === null || request.configPath === '') {
      throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires a configPath`);
    }
  }
}
