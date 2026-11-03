import { createSettingsFileStore } from '@varin/settings-store';
import { createDesktopFrontendMigrationOwner } from '@varin/web/server/lib/platform/frontend-migration.js';
import { resolveVarinDataDir } from '@varin/web/server/lib/platform/data-paths.js';
import path from 'node:path';
import { CompanionAssets } from '@varin/web/server/lib/companion/assets.js';
export const FRONTEND_EXPORT_ARGUMENT = '--varin-export-frontend-state';
export const LEGACY_FRONTEND_ORIGIN = 'varin-ui://app';
interface LegacyDocument {
  getURL(): string;
  debugger: {
    isAttached(): boolean;
    attach(version: string): void;
    detach(): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}
/** Native DOMStorage inspection, never a renderer IPC export or direct profile
 * database read. Reusable by the separately secured native credential handoff. */
export async function readLegacyFrontendEntries(document: LegacyDocument): Promise<[
  string,
  string
][]> {
  const url = new URL(document.getURL());
  if (url.protocol !== 'varin-ui:' || url.hostname !== 'app' || url.port || url.username || url.password)
    throw new Error('Frontend export requires the original application origin');
  if (document.debugger.isAttached())
    throw new Error('Frontend export cannot share an active debugger session');
  document.debugger.attach('1.3');
  try {
    const response = await document.debugger.sendCommand('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: LEGACY_FRONTEND_ORIGIN, isLocalStorage: true } }) as {
      entries?: unknown;
    };
    if (!Array.isArray(response.entries) || response.entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || entry.some(v => typeof v !== 'string')))
      throw new Error('Legacy frontend storage response is invalid');
    return response.entries as [
      string,
      string
    ][];
  }
  finally {
    document.debugger.detach();
  }
}
export async function stageLegacyFrontendEntries(entries: readonly (readonly [
  string,
  string
])[], version: string) { const store = createSettingsFileStore({ filePath: path.join(resolveVarinDataDir(), 'settings.json') }); return createDesktopFrontendMigrationOwner(store).stage(entries, version); }
/** userData is supplied by the old Electron process, never guessed from a new
 * shell or accepted from renderer input. Both roots must be migration-locked. */
export async function stageLegacyCompanionAssets(userData: string) {
  const dataDirectory = resolveVarinDataDir();
  const store = createSettingsFileStore({ filePath: path.join(dataDirectory, 'settings.json') });
  const assets = new CompanionAssets({
    root: path.join(dataDirectory, 'companions'), catalog: { schemaVersion: 1, packs: [] },
    fetch: async () => { throw new Error('Migration does not download artwork'); }, changed: () => { }
  });
  let receipt:Awaited<ReturnType<typeof assets.importInstalled>>;
  try { await assets.initialize();receipt=await assets.importInstalled(path.join(userData,'companions')); }
  catch {receipt={imported:[],retained:[],rejected:['legacy-cache'],failures:[{id:'legacy-cache',reason:'source-cache-unavailable'}]};}
  await store.update(root => { root.desktopCompanionAssetsMigration = { schema: 1, stage: receipt.rejected.length ? 'partial' : 'imported', ...receipt, completedAt: new Date().toISOString() }; });
  return receipt;
}
