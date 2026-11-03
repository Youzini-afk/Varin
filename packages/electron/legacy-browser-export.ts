import { BrowserWindow, session } from 'electron';
const inertHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Varin private migration</title></head><body></body></html>';
const storageOrigin = (input: string): string | null => {
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !['tauri.localhost', 'varin-ui.localhost', 'varin-companion.localhost'].includes(url.hostname) ? url.origin : null;
  } catch { return null; }
};
export function legacyBrowserOrigins(cookies: Record<string, unknown>[], frontend: readonly (readonly [string, string])[]): string[] {
  const origins = new Set<string>();
  const add = (value: string) => { const origin = storageOrigin(value); if (origin) origins.add(origin); };
  for (const cookie of cookies) if (typeof cookie.domain === 'string') {
    const domain = cookie.domain.replace(/^\./, '');
    for (const scheme of ['https', 'http']) add(`${scheme}://${domain}`);
    if (typeof cookie.sourcePort === 'number' && cookie.sourcePort > 0)
      add(`${cookie.sourceScheme === 'Secure' ? 'https' : 'http'}://${domain}:${cookie.sourcePort}`);
    const partition = cookie.partitionKey as { topLevelSite?: unknown } | undefined;
    if (typeof partition?.topLevelSite === 'string') add(partition.topLevelSite);
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
      if (key === 'url' && typeof field === 'string') add(field);
      else if (field && typeof field === 'object') visit(field);
    }
  };
  for (const [key, serialized] of frontend) if (key === 'varin.ui.v1' || key.startsWith('varin.editor-workbench:')) {
    try { visit(JSON.parse(serialized)); } catch { /* Invalid UI state has its own migration owner. */ }
  }
  return [...origins].sort();
}
/** The original persistent BrowserUse session, never the Web-render session.
 * HTTP(S) is intercepted with inert local bytes before any origin is visited.
 * No website code or network request discovers its stored state. */
export async function openLegacyBrowserExport() {
  const profile = session.fromPartition('persist:varin-browser');
  const installed: string[] = [];
  let window: BrowserWindow | undefined;
  const close = async () => {
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      const closed = new Promise<void>(resolve => window!.once('closed', resolve));
      window.destroy(); await closed;
    }
    for (const scheme of installed.splice(0)) profile.protocol.unhandle(scheme);
  };
  try {
    profile.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== 'about:blank'
      && (details.resourceType !== 'mainFrame' || !/^https?:\/\/[^/]+\/\.varin-migration\.html$/.test(details.url)) }));
    profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    for (const scheme of ['http', 'https']) {
      await profile.protocol.handle(scheme, () => new Response(inertHtml, { headers: {
        'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'",
      } }));
      installed.push(scheme);
    }
    window = new BrowserWindow({ show: false, webPreferences: { session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const reader = window;
    reader.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    reader.webContents.on('will-navigate', event => event.preventDefault());
    await reader.loadURL('about:blank'); reader.webContents.debugger.attach('1.3');
    const request = (method: string, params: Record<string, unknown> = {}) => reader.webContents.debugger.sendCommand(method, params);
    await request('Network.enable'); await request('Network.setBypassServiceWorker', { bypass: true });
    await request('ServiceWorker.stopAllWorkers');
    const response = await request('Storage.getCookies') as { cookies?: unknown };
    if (!Array.isArray(response.cookies) || response.cookies.some(cookie => !cookie || typeof cookie !== 'object' || Array.isArray(cookie)))
      throw new Error('Legacy BrowserUse cookie inventory is invalid');
    const cookies = response.cookies as Record<string, unknown>[];
    return {
      cookies,
      async *origins(origins: readonly string[]) {
        for (const origin of origins) {
          const output: Record<string, unknown> = { origin, localStorage: null, indexedDbDatabases: null, serviceWorkers: 'not-exported', inventory: 'cookies-and-saved-browser-pages' };
          try {
            if (storageOrigin(origin) !== origin) throw new Error('Invalid legacy browser origin');
            await reader.loadURL(`${origin}/.varin-migration.html`);
            const local = await request('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage: true } }) as { entries?: unknown };
            if (!Array.isArray(local.entries) || local.entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string')))
              throw new Error('Legacy site local storage is invalid');
            output.localStorage = local.entries;
            try {
              const databases = await request('IndexedDB.requestDatabaseNames', { securityOrigin: origin }) as { databaseNames?: unknown };
              if (Array.isArray(databases.databaseNames) && databases.databaseNames.every(value => typeof value === 'string')) output.indexedDbDatabases = databases.databaseNames;
            } catch { /* Unknown is distinct from an empty database list. */ }
            try {
              const quota = await request('Storage.getUsageAndQuota', { origin }) as { usageBreakdown?: unknown };
              if (Array.isArray(quota.usageBreakdown)) output.storageUsage = quota.usageBreakdown;
            } catch { /* No invented completeness claim. */ }
          } catch { output.reason = 'origin-storage-unavailable'; }
          yield output;
        }
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
