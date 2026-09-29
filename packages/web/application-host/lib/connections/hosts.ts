import type { DesktopHost, DesktopHostRelay, DesktopHostsConfigInput } from '@varin/application-client';
import type { createSettingsFileStore } from '@varin/settings-store';

type SettingsStore = ReturnType<typeof createSettingsFileStore>;
export interface HostConnectionsConfig {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const httpUrl = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) ? raw.split('#')[0] : undefined; }
  catch { return undefined; }
};

export const normalizeConnectionHost = (value: unknown): DesktopHost => {
  const input = record(value);
  const id = text(input.id);
  if (!id || id === 'local') throw new Error('A non-local connection id is required');
  const relayInput = record(input.relay);
  const relayUrl = text(relayInput.relayUrl);
  const serverId = text(relayInput.serverId);
  const jwk = record(relayInput.hostEncPubJwk);
  const relay = relayUrl && serverId && typeof jwk.kty === 'string' && typeof jwk.crv === 'string' && typeof jwk.x === 'string'
    && ['ws:', 'wss:'].includes(new URL(relayUrl).protocol)
    ? { relayUrl, serverId, hostEncPubJwk: jwk as DesktopHostRelay['hostEncPubJwk'] } : undefined;
  const directUrl = httpUrl(input.url);
  if (!directUrl && !relay) throw new Error(`Connection ${id} has no valid transport`);
  const url = directUrl ?? `relay://${relay!.serverId}`;
  const requestHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(input.requestHeaders))) {
    const name = key.trim();
    if (!name || name.toLowerCase() === 'authorization' || typeof value !== 'string'
      || /[\r\n:]/u.test(name) || /[\r\n]/u.test(value)) continue;
    if (value.trim()) requestHeaders[name] = value.trim();
  }
  return { id, url, label: text(input.label) || url,
    ...(directUrl ? { apiUrl: httpUrl(input.apiUrl) ?? directUrl } : {}),
    ...(text(input.clientToken) ? { clientToken: text(input.clientToken) } : {}),
    ...(Object.keys(requestHeaders).length ? { requestHeaders } : {}), ...(relay ? { relay } : {}) };
};

/** The same settings authority serves Host connections and shell startup selection. */
export const readHostConnections = (store: SettingsStore): HostConnectionsConfig => {
  const root = store.readSync();
  if (root.desktopHosts !== undefined && !Array.isArray(root.desktopHosts)) throw new Error('Invalid Host connections');
  return { hosts: (root.desktopHosts ?? []).map(normalizeConnectionHost),
    defaultHostId: text(root.desktopDefaultHostId) || null,
    initialHostChoiceCompleted: root.desktopInitialHostChoiceCompleted === true };
};

export const writeHostConnections = async (store: SettingsStore, input: DesktopHostsConfigInput): Promise<void> => {
  if (!Array.isArray(input.hosts)) throw new Error('Host connections must be an array');
  const hosts = input.hosts.map(normalizeConnectionHost);
  if (new Set(hosts.map((host) => host.id)).size !== hosts.length) throw new Error('Duplicate Host connection id');
  await store.update((root) => {
    root.desktopHosts = hosts;
    root.desktopDefaultHostId = text(input.defaultHostId) || null;
    if (typeof input.initialHostChoiceCompleted === 'boolean') root.desktopInitialHostChoiceCompleted = input.initialHostChoiceCompleted;
    if (input.localClientToken !== undefined) {
      if (text(input.localClientToken)) root.desktopLocalClientToken = text(input.localClientToken);
      else delete root.desktopLocalClientToken;
    }
  });
};
