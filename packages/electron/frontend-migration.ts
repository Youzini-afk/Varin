/** One-shot old-engine exporter. bootstrap.mjs selects this before main.ts, so
 * no Host, Catalog, automatic update, relay or UI effects can start. */
import { app, BrowserWindow, protocol } from 'electron';
import { createReadStream, writeFile } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { acquireDesktopSessionLease, verifyInheritedDesktopSessionLease, type DesktopSessionRecord } from '@varin/web/server/lib/platform/desktop-session-lease.js';
import { resolveVarinDataDir } from '@varin/web/server/lib/platform/data-paths.js';
import { legacyCredentials, exportLegacyPrivateState, openLegacyPrivateChannel } from './legacy-private-export.js';
import { LEGACY_FRONTEND_ORIGIN, readLegacyFrontendEntries, stageLegacyFrontendEntries, stageLegacyCompanionAssets } from './frontend-migration-export.js';
app.setName('Varin');
if (process.env.VARIN_ELECTRON_DEV === '1' || !app.isPackaged)
  app.setPath('userData', path.join(app.getPath('appData'), 'Varin Dev'));
protocol.registerSchemesAsPrivileged([{ scheme: 'varin-ui', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
async function runMigration(): Promise<void> {
  let channel: Awaited<ReturnType<typeof openLegacyPrivateChannel>> | undefined;
  try {
    if (process.argv.includes('--varin-export-private-state')) {
      // Electron's Windows GUI main process substitutes an empty process.stdin.
      // Use the original descriptors the desktop guardian assigned to this process.
      const input = createReadStream('', { fd: 0, autoClose: false });
      const write = promisify(writeFile);
      channel = await openLegacyPrivateChannel(input, bytes => write(1, bytes));
      verifyInheritedDesktopSessionLease(resolveVarinDataDir(), channel.lease as DesktopSessionRecord);
    } else {
      const lease = acquireDesktopSessionLease(resolveVarinDataDir(), 'migration');
      process.once('exit', () => lease.release());
    }
  } catch {
    process.stderr.write('[frontend-migration] Exclusive desktop ownership was not confirmed.\n');
    app.exit(3);
    return;
  }
  let window: BrowserWindow | undefined;
  try {
    if (!app.requestSingleInstanceLock()) {
      process.stderr.write('[frontend-migration] Close the existing Varin desktop before exporting its UI state.\n');
      app.exit(2);
      return;
    }
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

// Electron emits ready after its ESM entry finishes evaluating. The scheme is
// registered above before that boundary, and the export continues after it.
void runMigration();
