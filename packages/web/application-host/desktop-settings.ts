/** Short-lived desktop settings process. Importing this entry does not construct
 * an Application Host, Catalog, KnowledgeStore or network listener. All writes
 * use the existing cross-process settings owner, including its lock/recovery. */
import { nativeMigrationReceipt } from './lib/platform/native-migration-receipt.js';
import { createDesktopFrontendMigrationOwner } from './lib/platform/frontend-migration.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSettingsFileStore } from '@varin/settings-store';
import { readLocalHostMode, writeLocalHostMode, type LocalHostModeContext } from '@varin/application-client/desktop';
import { normalizeLocale } from '@varin/application-client/locale';
import { resolveVarinDataDir } from './lib/platform/data-paths.js';
import { readHostConnections, writeHostConnections } from './lib/connections/hosts.js';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const booleanKeys = new Set(['desktopMinimizeToTrayEnabled', 'desktopKeepAwakeEnabled', 'desktopVibrancy', 'desktopMacMenuBarEnabled', 'desktopCompanionEnabled']);

export function createDesktopSettingsOwner(filePath = path.join(resolveVarinDataDir(), 'settings.json')) {
  const store = createSettingsFileStore({ filePath });
  const installId = async () => {
    await store.update(root => { if (!text(root.desktopInstallId)) root.desktopInstallId = randomUUID(); });
    return text(store.readSync().desktopInstallId);
  };
  return async (method: string, input: unknown = {}, context: LocalHostModeContext = {
    environment: process.env, recoveryUiAvailable: true, startedEnabled: null, runtime: 'stopped',
  }): Promise<unknown> => {
    const args = record(input);
    switch (method) {
      case 'nativeMigrationRead': return record(store.readSync().desktopNativeMigration);
      case 'nativeMigrationComplete': {
        const receipt=nativeMigrationReceipt(input);
        await store.update(root=>{root.desktopNativeMigration=receipt;const frontend=record(root.desktopFrontendMigration);if(frontend.stage==='imported')root.desktopFrontendMigration={...frontend,credentialsComplete:receipt.credentialsComplete};});
        return null;
      }
      case 'frontendMigrationRead': {
        const stage = createDesktopFrontendMigrationOwner(store).read();
        // CEF IPC reorders object keys. Preserve the serialization used by the digest.
        return args.serialized === true && stage ? JSON.stringify(stage) : stage;
      }
      case 'frontendMigrationComplete': return createDesktopFrontendMigrationOwner(store).complete(args);
      case 'snapshot': {
        const root = store.readSync();
        return {
          hosts: readHostConnections(store),
          localHostMode: readLocalHostMode(store, context),
          localClientToken: text(root.desktopLocalClientToken),
          installId: text(root.desktopInstallId),
          locale: normalizeLocale(typeof root.desktopLocale === 'string' ? root.desktopLocale : undefined),
          homeDirectory: process.env.VARIN_WORKSPACE_ROOT?.trim() ? path.resolve(process.env.VARIN_WORKSPACE_ROOT.trim()) : os.homedir(),
          preferences: Object.fromEntries([...booleanKeys].flatMap(key => typeof root[key] === 'boolean' ? [[key, root[key]]] : [])),
          windowState: root.desktopWindowState ?? null,
        };
      }
      case 'desktop_hosts_get': return { ...readHostConnections(store), localOrigin: text(args.localOrigin) || null };
      case 'desktop_hosts_set': {
        await writeHostConnections(store, record(args.input ?? args.config) as Parameters<typeof writeHostConnections>[1]);
        return null;
      }
      case 'desktop_get_lan_address': return Object.values(os.networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address ?? null;
      case 'desktop_install_id_get': return installId();
      case 'desktop_local_client_token_get': return text(store.readSync().desktopLocalClientToken);
      case 'desktop_get_local_host_mode': return readLocalHostMode(store, context);
      case 'desktop_set_local_host_mode': return writeLocalHostMode(store, args as unknown as Parameters<typeof writeLocalHostMode>[1], context);
      case 'desktop_set_locale': {
        if (typeof args.locale !== 'string') throw new Error('Locale is required');
        const locale = normalizeLocale(args.locale);
        await store.update(root => { root.desktopLocale = locale; });
        return locale;
      }
      case 'setPreference': {
        if (typeof args.key !== 'string' || !booleanKeys.has(args.key) || typeof args.enabled !== 'boolean') throw new Error('Invalid desktop preference');
        await store.update(root => { root[args.key as string] = args.enabled; });
        return args.enabled;
      }
      case 'saveWindowState': {
        const state = record(args.state);
        if (!['x', 'y', 'width', 'height'].every(key => typeof state[key] === 'number' && Number.isFinite(state[key]))
          || Number(state.width) <= 0 || Number(state.height) <= 0) throw new Error('Invalid window geometry');
        await store.update(root => { root.desktopWindowState = { x: state.x, y: state.y, width: state.width, height: state.height,
          maximized: state.maximized === true, fullscreen: state.fullscreen === true }; });
        return null;
      }
      default: throw new Error('Unknown desktop settings operation');
    }
  };
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    const request = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (request.version !== 1 || typeof request.method !== 'string') throw new Error('Incompatible desktop settings request');
    const context = record(request.context);
    const owner = createDesktopSettingsOwner();
    const result = await owner(request.method, request.args, {
      environment: process.env,
      recoveryUiAvailable: context.recoveryUiAvailable !== false,
      startedEnabled: typeof context.startedEnabled === 'boolean' ? context.startedEnabled : null,
      runtime: context.runtime === 'embedded' || context.runtime === 'external' ? context.runtime : 'stopped',
    });
    process.stdout.write(JSON.stringify({ version: 1, ok: true, result }) + '\n');
  } catch {
    // The input may contain passwords or bearer tokens. Do not echo it or a
    // parser's diagnostic text to either stdout or a shared application log.
    process.stdout.write(JSON.stringify({ version: 1, ok: false, error: 'Desktop settings could not be read or changed; the previous data was retained' }) + '\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
