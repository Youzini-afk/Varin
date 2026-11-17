import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { ExternalAccessConfigurationView } from '@varin/application-client';
import { normalizeExternalIngress } from '../platform/public-ingress.js';

export const EXTERNAL_ACCESS_SETTINGS_KEY = 'selfHostedExternalAccess';

export type ExternalAccessConfiguration = ExternalAccessConfigurationView & (
  | { provider: 'reverse-proxy' }
  | {
    provider: 'frp';
    frp: {
      server: { address: string; port: number; tls: { caFile: string; serverName: string } };
      proxy: { name: string; remotePort: number };
      tokenEnv: string;
    };
  }
);

export class ExternalAccessConfigurationError extends Error {}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAccessConfigurationError('Expected an external access configuration object');
  }
  return value as Record<string, unknown>;
};

const field = (value: unknown, label: string, maximum = 256): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new ExternalAccessConfigurationError(`Invalid ${label}`);
  }
  return value.trim();
};

const port = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ExternalAccessConfigurationError(`Invalid ${label}: expected a fixed port between 1 and 65535`);
  }
  return value;
};

const host = (value: unknown, label: string): string => {
  const name = field(value, label, 253);
  if (isIP(name) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu.test(name)) {
    return name;
  }
  throw new ExternalAccessConfigurationError(`Invalid ${label}: use a host name or IP address`);
};

export function parseExternalAccessConfiguration(value: unknown, id: string): ExternalAccessConfiguration {
  const input = record(value);
  const backend = record(input.backend);
  const publicOrigin = field(input.publicOrigin, 'HTTPS origin');
  const bindHost = field(backend.host, 'backend IP address');
  const bindPort = port(backend.port, 'backend port');
  let ingress: ReturnType<typeof normalizeExternalIngress>;
  try {
    ingress = normalizeExternalIngress({ origin: publicOrigin, host: bindHost, port: bindPort });
  } catch {
    throw new ExternalAccessConfigurationError('Use an HTTPS origin and a fixed IP address for the guarded backend');
  }
  const base = {
    id: field(id, 'entry id', 128),
    name: input.name === undefined || input.name === '' ? new URL(ingress.origin).hostname : field(input.name, 'entry name', 80),
    publicOrigin: ingress.origin,
    backend: { host: ingress.host, port: ingress.port },
  };
  if (input.provider === 'reverse-proxy') return { ...base, provider: 'reverse-proxy' };
  if (input.provider !== 'frp') throw new ExternalAccessConfigurationError('Unsupported external access provider');
  if (bindHost !== '127.0.0.1' && bindHost !== '::1') {
    throw new ExternalAccessConfigurationError('FRP requires a loopback backend address');
  }
  const frp = record(input.frp);
  const server = record(frp.server);
  const proxy = record(frp.proxy);
  const tls = record(server.tls);
  const tokenEnv = field(frp.tokenEnv, 'FRP token environment variable', 80);
  if (!/^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/u.test(tokenEnv)) {
    throw new ExternalAccessConfigurationError('Use VARIN_FRP_TOKEN or a named VARIN_FRP_TOKEN_* environment variable');
  }
  const caFile = field(tls.caFile, 'FRP CA file', 4096);
  if (!isAbsolute(caFile)) throw new ExternalAccessConfigurationError('FRP CA file must use an absolute path on the Host');
  const proxyName = field(proxy.name, 'FRP proxy name', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(proxyName)) throw new ExternalAccessConfigurationError('Invalid FRP proxy name');
  return {
    ...base, provider: 'frp',
    frp: {
      tokenEnv,
      server: {
        address: host(server.address, 'FRP server address'),
        port: port(server.port, 'FRP server port'),
        tls: { caFile, serverName: host(tls.serverName, 'TLS server name') },
      },
      proxy: { name: proxyName, remotePort: port(proxy.remotePort, 'FRP remote port') },
    },
  };
}

export function readExternalAccessRecord(value: unknown) {
  if (value === undefined) return null;
  const saved = record(value);
  if (!Number.isSafeInteger(saved.revision) || Number(saved.revision) <= 0 || typeof saved.enabled !== 'boolean') {
    throw new ExternalAccessConfigurationError('Saved external access configuration has an invalid revision or enable intent');
  }
  const input = record(saved.configuration);
  return {
    revision: Number(saved.revision),
    enabled: saved.enabled,
    configuration: parseExternalAccessConfiguration(input, field(input.id, 'entry id', 128)),
  };
}

export function externalAccessConfigurationView(configuration: ExternalAccessConfiguration): ExternalAccessConfigurationView {
  const { id, name, provider, publicOrigin, backend } = configuration;
  return { id, name, provider, publicOrigin, backend };
}
