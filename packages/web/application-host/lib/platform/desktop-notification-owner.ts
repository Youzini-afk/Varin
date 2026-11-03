/** Desktop-owned remote notification observations. No local Host, Catalog, or
 * business store is initialized to observe an existing remote Host. */
import { NotificationListener, type DesktopNotificationDetail, type NotificationTransport } from './notification-listener.js';
import { isKnownLocalDesktopUrl } from './desktop-connections.js';

export interface DesktopNotificationTarget {
  windowLabel: string;
  runtimeConfig: { apiBaseUrl: string; clientToken: string; requestHeaders: Record<string, string>; relayHostId: string };
}
interface Entry { target: DesktopNotificationTarget; signature: string; listener: NotificationListener; active: boolean }
export function normalizeNotificationTargets(raw: unknown): Map<string, DesktopNotificationTarget> {
  if (!Array.isArray(raw)) throw new Error('Invalid desktop notification targets');
  const targets = new Map<string, DesktopNotificationTarget>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop notification target');
    const target = value as Record<string, unknown>;
    const config = target.runtimeConfig as Record<string, unknown> | undefined;
    if (typeof target.windowLabel !== 'string' || !target.windowLabel || !config || typeof config !== 'object' || Array.isArray(config)
      || typeof config.apiBaseUrl !== 'string' || !config.requestHeaders || typeof config.requestHeaders !== 'object' || Array.isArray(config.requestHeaders)
      || Object.values(config.requestHeaders).some(value => typeof value !== 'string')
      || (config.clientToken != null && typeof config.clientToken !== 'string') || (config.relayHostId != null && typeof config.relayHostId !== 'string')) throw new Error('Invalid desktop notification target configuration');
    const relayHostId = typeof config.relayHostId === 'string' ? config.relayHostId : '';
    // Relay-only runtimes may have no direct HTTP origin. Preserve the identity
    // without rejecting other targets in the same native state update, and
    // never invent an HTTP endpoint for the encrypted relay credential.
    let apiBaseUrl = '';
    if (config.apiBaseUrl || !relayHostId) {
      const url = new URL(config.apiBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid desktop notification endpoint');
      url.hash = ''; apiBaseUrl = url.toString().replace(/\/+$/, '');
    }
    const key = JSON.stringify([apiBaseUrl, relayHostId]);
    if (!targets.has(key)) targets.set(key, { windowLabel: target.windowLabel, runtimeConfig: { apiBaseUrl, relayHostId,
      clientToken: typeof config.clientToken === 'string' ? config.clientToken : '', requestHeaders: { ...config.requestHeaders as Record<string, string> } } });
  }
  return targets;
}
export function createDesktopNotificationOwner(options: {
  transport: NotificationTransport;
  getLocalOrigin(): string | null;
  onNotification(target: DesktopNotificationTarget, notification: DesktopNotificationDetail): void;
}) {
  const entries = new Map<string, Entry>();
  let desired = new Map<string, DesktopNotificationTarget>();
  let serial: Promise<void> = Promise.resolve();
  let disposed = false;
  let failure: unknown;
  const signature = (target: DesktopNotificationTarget) => JSON.stringify({ ...target.runtimeConfig, requestHeaders: Object.entries(target.runtimeConfig.requestHeaders).sort(([a], [b]) => a.localeCompare(b)) });
  const reconcile = async () => {
    if (failure) throw failure;
    const removed: Entry[] = [];
    for (const [key, entry] of entries) {
      const target = desired.get(key);
      if (!target || entry.signature !== signature(target)) { entry.active = false; entries.delete(key); removed.push(entry); }
      else entry.target = target;
    }
    try { await Promise.all(removed.map(entry => entry.listener.stop())); }
    catch (error) { failure = error; throw error; }
    if (disposed) return;
    for (const [key, target] of desired) {
      if (entries.has(key)) continue;
      // Local notifications already arrive through the Host's private callback.
      // A relay is not an ordinary HTTP Host. Its encrypted renderer transport
      // retains notification delivery; never send its bearer to a guessed route.
      if (isKnownLocalDesktopUrl(target.runtimeConfig.apiBaseUrl, options.getLocalOrigin()) || target.runtimeConfig.relayHostId) continue;
      const entry: Entry = { target, signature: signature(target), active: true, listener: new NotificationListener({
        serverUrl: target.runtimeConfig.apiBaseUrl, clientToken: target.runtimeConfig.clientToken, requestHeaders: target.runtimeConfig.requestHeaders,
        transport: options.transport,
        logger: { info() {}, warn() {}, error() {} },
        onNotification(notification) { if (entry.active && !disposed) options.onNotification(entry.target, notification); },
      }) };
      entries.set(key, entry);
      void entry.listener.start().catch(() => {});
    }
  };
  return {
    setTargets(raw: unknown): Promise<void> {
      if (disposed) return Promise.reject(new Error('Desktop notification owner is shutting down'));
      desired = normalizeNotificationTargets(raw);
      return serial = serial.then(reconcile);
    },
    async dispose(): Promise<void> {
      disposed = true; desired.clear();
      await serial; await reconcile();
    },
  };
}
