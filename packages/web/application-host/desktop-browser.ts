#!/usr/bin/env node
/** On-demand local browser coordination for a remote-only client. This entry
 * must not import index.ts or initialize a Host, Catalog, Knowledge or listener. */
import path from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { createDesktopPlatformOwner } from './lib/platform/desktop-platform.js';
import { createNativeNetworkOwner, type DesktopNetworkOwner } from './lib/platform/native-network-owner.js';
import { createNativeShellCompanionOwner } from './lib/companion/native-shell-owner.js';
import { pathToFileURL } from 'node:url';
import { resolveNodeRuntime } from '@varin/protocol/node/runtime';
import { createDesktopHostStdio } from './desktop-host-stdio.js';
import { resolveVarinDataDir } from './lib/platform/data-paths.js';
import { createDesktopHostSession, type DesktopNativePort, type ManagedDesktopBrowserOwner, type ManagedDesktopCompanionOwner } from './lib/platform/desktop-host-session.js';

export async function runManagedDesktopBrowser(dependencies: {
  createNetworkOwner?(port: DesktopNativePort): DesktopNetworkOwner;
  createCompanionOwner?(port: DesktopNativePort): ManagedDesktopCompanionOwner;
  createBrowserOwner?(port: DesktopNativePort): ManagedDesktopBrowserOwner;
} = {}): Promise<void> {
  if (process.versions.electron || process.versions.bun) throw new Error('The managed desktop browser requires the packaged Node runtime');
  const stdio = createDesktopHostStdio();
  process.title = 'Varin Browser';
  process.env.VARIN_NODE_PATH = resolveNodeRuntime().executable;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const dataDir = resolveVarinDataDir();
  const { createNativeShellBrowserOwner } = await import('./lib/browser/native-shell-owner.js');
  const settings = createSettingsFileStore({ filePath: path.join(dataDir, 'settings.json') });
  const session = createDesktopHostSession({
    createNetworkOwner: dependencies.createNetworkOwner ?? (port => createNativeNetworkOwner({ port })),
    createPlatformOwner: (network, getLocalOrigin, nativePort, onInstalledAppsUpdated) => createDesktopPlatformOwner({ fetch: network.fetch, settings, getLocalOrigin, nativePort, dataDirectory: dataDir, onInstalledAppsUpdated }),
    createCompanionOwner: dependencies.createCompanionOwner ?? (port => createNativeShellCompanionOwner({ port, dataDirectory: dataDir, frontendDirectory: process.env.VARIN_DIST_DIR || path.resolve(import.meta.dirname, '../dist') })),
    mode: 'browser', serverOptions: {},
    createBrowserOwner: dependencies.createBrowserOwner ?? (port => createNativeShellBrowserOwner({ port, scratchDirectory: path.join(dataDir, 'browser-transfers') })),
    send: stdio.send, exit: stdio.exit,
  });
  await stdio.run(session);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runManagedDesktopBrowser().catch(error => { console.error('[desktop-browser] Bootstrap failed:', error instanceof Error ? error.name : 'UnknownError'); process.exit(1); });
}
