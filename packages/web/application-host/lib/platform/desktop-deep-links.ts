/** Desktop OS-link policy shared by both shells. No renderer or Host/Catalog
 * owns this entry. Pairing secrets stay in the private desktop coordinator. */
import { randomUUID } from 'node:crypto';
import type { SettingsFileStore } from '@varin/settings-store';
import { normalizeConnectionHost } from '../connections/hosts.js';
import { normalizeHostUrl, type DesktopConnectionFetch } from './desktop-connections.js';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface DesktopDeepLink { type: string; value: string; raw?: string | undefined; branchId?: string | undefined; hostId?: string | undefined; directory?: string | undefined }
export interface DesktopConnectPreview { serverUrl: string; label: string; candidateUrls: string[] }
export type DesktopDeepLinkAction = { type: 'host'; hostId: string } | { type: 'thread'; threadId: string; branchId: string; hostId?: string | undefined; directory: string };
interface PairingCandidate { type: 'lan' | 'relay' | 'tunnel'; url: string; priority: number }
interface PairingPayload { pairingId: string; secret: string; label: string; fingerprint: string; expiresAt: string | null; candidates: PairingCandidate[] }
export function parseDesktopDeepLink(raw: unknown): DesktopDeepLink | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'varin:' || !url.hostname || url.username || url.password || url.port) return null;
    return { type: url.hostname.toLowerCase(), value: decodeURIComponent(url.pathname.split('/').filter(Boolean).join('/')), raw: raw.trim(),
      branchId: url.searchParams.get('branch') || undefined, hostId: url.searchParams.get('host') || undefined, directory: url.searchParams.get('dir') || undefined };
  } catch { return null; }
}
export function parseConnectPairingDeepLinkPayload(raw: unknown): PairingPayload | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'varin:' || url.hostname.toLowerCase() !== 'connect' || url.username || url.password || url.port || url.searchParams.get('v') !== '2') return null;
    const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(url.searchParams.get('p') || '', 'base64url'))));
    const pairingId = typeof payload.pairingId === 'string' ? payload.pairingId.trim() : '';
    const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
    if (payload.v !== 2 || !pairingId || !secret) return null;
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.flatMap<PairingCandidate>(raw => {
      const candidate = object(raw), normalized = normalizeHostUrl(candidate.url), type = candidate.type;
      if (!normalized || !['lan', 'tunnel', 'relay'].includes(String(type))) return [];
      const endpoint = new URL(normalized);
      if (endpoint.username || endpoint.password) return [];
      return [{ type: type as PairingCandidate['type'], url: normalized, priority: typeof candidate.priority === 'number' && Number.isFinite(candidate.priority) ? candidate.priority : 100 }];
    }) : [];
    if (!candidates.length) return null;
    const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt.trim() : '';
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) return null;
    return { pairingId, secret, candidates: candidates.sort((a, b) => a.priority - b.priority), expiresAt: expiresAt || null,
      label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'Varin',
      fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint.trim() : '' };
  } catch { return null; }
}
export function createDesktopDeepLinks(options: {
  settings: Pick<SettingsFileStore, 'readSync' | 'update'>;
  fetch: DesktopConnectionFetch;
  getInstallId(): Promise<string>;
  deviceMetadata(): { devicePlatform?: string; appVersion?: string };
  confirm(preview: DesktopConnectPreview): Promise<boolean>;
}) {
  let disposed = false;
  const network = new Set<AbortController>(), writes = new Set<Promise<unknown>>();
  const request = async (url: string, init: RequestInit, timeoutMs = 8_000) => {
    if (disposed) throw new Error('Desktop link owner is stopped');
    const controller = new AbortController(); network.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetch(url, { ...init, signal: controller.signal });
      const data = object(await response.json().catch(() => null));
      if (disposed) throw new Error('Desktop link owner stopped while connecting');
      return { ok: response.ok, data };
    } finally { clearTimeout(timer); network.delete(controller); }
  };
  return {
    async receive(raw: unknown): Promise<DesktopDeepLinkAction | null> {
      if (disposed) throw new Error('Desktop link owner is stopped');
      const link = parseDesktopDeepLink(raw); if (!link) return null;
      if (link.type === 'host' || link.type === 'thread') {
        const id = link.type === 'host' ? link.value : link.hostId;
        const hosts = options.settings.readSync().desktopHosts;
        if (id && id !== 'local' && (!Array.isArray(hosts) || !hosts.some(host => object(host).id === id))) return null;
        if (link.type === 'host') return id ? { type: 'host', hostId: id } : null;
        return link.value && link.branchId ? { type: 'thread', threadId: link.value, branchId: link.branchId, hostId: link.hostId, directory: link.directory || '' } : null;
      }
      if (link.type !== 'connect') return null;
      const payload = parseConnectPairingDeepLinkPayload(link.raw); if (!payload) return null;
      if (!await options.confirm({ serverUrl: payload.candidates[0]!.url, label: payload.fingerprint ? `${payload.label} (${payload.fingerprint})` : payload.label, candidateUrls: payload.candidates.map(candidate => candidate.url) })) return null;
      if (disposed || payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) return null;
      let serverUrl: string | undefined;
      for (const candidate of payload.candidates) {
        try { if ((await request(`${candidate.url.replace(/\/+$/g, '')}/health`, { method: 'GET' }, 3_500)).ok) { serverUrl = candidate.url.replace(/\/+$/g, ''); break; } }
        catch { if (disposed) return null; /* Try the next explicitly confirmed candidate. */ }
      }
      if (!serverUrl || disposed) return null;
      const redeemed = await request(`${serverUrl}/api/client-auth/pairing/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ pairingId: payload.pairingId, secret: payload.secret, clientLabel: 'Varin Desktop', clientKind: 'desktop', deviceName: 'Varin Desktop', ...options.deviceMetadata(), dedupeKey: `desktop:${await options.getInstallId()}` }) });
      const token = typeof redeemed.data.clientToken === 'string' ? redeemed.data.clientToken.trim() : '';
      if (!redeemed.ok || !token || disposed) return null;
      const normalized = normalizeHostUrl(serverUrl)!;
      let id = '';
      const write = options.settings.update(root => {
        if (disposed) return;
        if (root.desktopHosts !== undefined && !Array.isArray(root.desktopHosts)) throw new Error('Saved desktop hosts are malformed');
        const hosts = (root.desktopHosts ?? []).map(normalizeConnectionHost);
        const previous = hosts.find(host => [host.url, host.apiUrl || host.url].some(url => normalizeHostUrl(url) === normalized));
        id = previous?.id || `host-${randomUUID()}`;
        const host = normalizeConnectionHost({ ...previous, id, url: normalized, apiUrl: normalized, clientToken: token,
          label: payload.label || object(redeemed.data.server).label || previous?.label || normalized });
        root.desktopHosts = previous ? hosts.map(item => item.id === id ? host : item) : [host, ...hosts];
        if (typeof root.desktopDefaultHostId !== 'string' || !root.desktopDefaultHostId.trim()) root.desktopDefaultHostId = id;
        root.desktopInitialHostChoiceCompleted = true;
      });
      writes.add(write); try { await write; } finally { writes.delete(write); }
      return id && !disposed ? { type: 'host', hostId: id } : null;
    },
    async dispose() { disposed = true; for (const controller of network) controller.abort(); await Promise.allSettled([...writes]); },
  };
}
