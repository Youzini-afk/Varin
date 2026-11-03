/** One-shot old-engine exporter. bootstrap.mjs selects this before main.ts, so
 * no Host, Catalog, automatic update, relay or UI effects can start. */
import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import { acquireDesktopSessionLease, verifyInheritedDesktopSessionLease, type DesktopSessionRecord } from '@varin/web/server/lib/platform/desktop-session-lease.js';
import { resolveVarinDataDir } from '@varin/web/server/lib/platform/data-paths.js';
import { legacyCredentials, exportLegacyPrivateState, openLegacyPrivateChannel } from './legacy-private-export.js';
import { LEGACY_FRONTEND_ORIGIN, readLegacyFrontendEntries, stageLegacyFrontendEntries, stageLegacyCompanionAssets } from './frontend-migration-export.js';
app.setName('Varin');
if (process.env.VARIN_ELECTRON_DEV === '1' || !app.isPackaged)
  app.setPath('userData', path.join(app.getPath('appData'), 'Varin Dev'));
protocol.registerSchemesAsPrivileged([{ scheme: 'varin-ui', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let ownLease: ReturnType<typeof acquireDesktopSessionLease> | undefined;
let channel: Awaited<ReturnType<typeof openLegacyPrivateChannel>> | undefined;
try {
  if (process.argv.includes('--varin-export-private-state')) {
    channel=await openLegacyPrivateChannel(process.stdin,bytes=>new Promise<void>((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve())));
    verifyInheritedDesktopSessionLease(resolveVarinDataDir(),channel.lease as DesktopSessionRecord);
  } else ownLease=acquireDesktopSessionLease(resolveVarinDataDir(),'migration');
} catch { process.stderr.write('[frontend-migration] Exclusive desktop ownership was not confirmed.\n');app.exit(3); }
process.once('exit',()=>ownLease?.release());
if (!app.requestSingleInstanceLock()) {
  process.stderr.write('[frontend-migration] Close the existing Varin desktop before exporting its UI state.\n');
  app.exit(2);
}
else {
  let window: BrowserWindow | undefined;
  try {
    await app.whenReady();
    await protocol.handle('varin-ui', request => {
      const url = new URL(request.url);
      if (url.href !== `${LEGACY_FRONTEND_ORIGIN}/.frontend-migration.html`)
        return new Response('', { status: 404 });
      return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Varin migration</title></head><body></body></html>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; frame-src 'none'; object-src 'none'" } });
    });
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadURL(`${LEGACY_FRONTEND_ORIGIN}/.frontend-migration.html`);
    const entries = await readLegacyFrontendEntries(window.webContents);
    const receipt = await stageLegacyFrontendEntries(entries, app.getVersion());
    const companions = await stageLegacyCompanionAssets(app.getPath('userData'));
    if (channel) {
      await exportLegacyPrivateState({ channel, sourceVersion: app.getVersion(),
        credentials: legacyCredentials(entries), uiReceipt: { ...receipt, companions } });
    } else {
      // Summary only. Raw native storage never reaches the ordinary CLI output.
      process.stdout.write(JSON.stringify({ ...receipt, companions }) + '\n');
    }
    window.destroy();
    app.exit(channel ? 0 : companions.rejected.length ? 1 : 0);
  }
  catch {
    if (window && !window.isDestroyed())
      window.destroy();
    process.stderr.write('[frontend-migration] Export did not complete; original data was retained.\n');
    app.exit(1);
  }
}
