#!/usr/bin/env node
/** Managed desktop entry. No database or Application Host is loaded until the
 * private pipe and environment are ready. stdout is exclusively control data. */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createNativeShellCompanionOwner } from './lib/companion/native-shell-owner.js';
import { createSettingsFileStore } from '@varin/settings-store';
import { resolveNodeRuntime } from '@varin/protocol/node/runtime';
import { resolveVarinDataDir } from './lib/platform/data-paths.js';
import { createDesktopHostSession, type ManagedDesktopHostController, type DesktopNativePort, type ManagedDesktopBrowserOwner, type ManagedDesktopCompanionOwner } from './lib/platform/desktop-host-session.js';
import type { StartWebUiServerOptions } from './public-contract.js';
import { createDesktopHostStdio } from './desktop-host-stdio.js';
import { createDesktopPlatformOwner } from './lib/platform/desktop-platform.js';
import { createNativeNetworkOwner, type DesktopNetworkOwner } from './lib/platform/native-network-owner.js';

export async function runManagedDesktopHost(dependencies: {
  start?(options: StartWebUiServerOptions): Promise<ManagedDesktopHostController>;
  createCompanionOwner?(port: DesktopNativePort): ManagedDesktopCompanionOwner;
  createBrowserOwner?(port: DesktopNativePort): ManagedDesktopBrowserOwner;
  createNetworkOwner?(port: DesktopNativePort): DesktopNetworkOwner;
} = {}): Promise<void> {
  if (process.versions.electron || process.versions.bun) throw new Error('The managed desktop Host requires the packaged Node runtime');
  const stdio = createDesktopHostStdio();
  process.title = 'Varin Host';
  process.env.VARIN_NODE_PATH = resolveNodeRuntime().executable;
  delete process.env.ELECTRON_RUN_AS_NODE;
  process.env.VARIN_RUNTIME = 'desktop';
  process.env.VARIN_DESKTOP_NOTIFY = 'true';
  process.env.VARIN_SKIP_API_COMPRESSION ??= 'true';
  process.env.NO_PROXY ||= 'localhost,127.0.0.1';
  process.env.no_proxy ||= 'localhost,127.0.0.1';
  const dataDir = resolveVarinDataDir();
  // Reuse the existing physical root and its cross-process transactional writer.
  process.env.VARIN_DATA_DIR = dataDir;
  const settings = createSettingsFileStore({ filePath: path.join(dataDir, 'settings.json') });
  const persisted = await settings.read();
  const password = typeof persisted.desktopUiPassword === 'string' ? persisted.desktopUiPassword.trim() : '';
  const lanRequested = persisted.desktopLanAccessEnabled === true;
  const lanEnabled = lanRequested && Boolean(password);
  process.env.VARIN_DESKTOP_LAN_ACCESS_ACTIVE = String(lanEnabled);
  if (lanRequested && !password) process.env.VARIN_DESKTOP_LAN_ACCESS_BLOCKED_REASON = 'missing-password';
  else delete process.env.VARIN_DESKTOP_LAN_ACCESS_BLOCKED_REASON;
  if (password) process.env.VARIN_UI_PASSWORD = password;
  else delete process.env.VARIN_UI_PASSWORD;
  const storedPort = persisted.desktopLocalPort;
  const port = typeof storedPort === 'number' && Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65535 ? storedPort : 57123;
  const createBrowserOwner = dependencies.createBrowserOwner ?? ((port: DesktopNativePort) => createNativeShellBrowserOwner({ port, scratchDirectory: path.join(dataDir, 'browser-transfers') }));
  const { createNativeShellBrowserOwner } = await import('./lib/browser/native-shell-owner.js');
  const session = createDesktopHostSession({
    createCompanionOwner: dependencies.createCompanionOwner ?? (port => createNativeShellCompanionOwner({ port, dataDirectory: dataDir, frontendDirectory: process.env.VARIN_DIST_DIR || path.resolve(import.meta.dirname, '../dist') })),
    createBrowserOwner,
    createNetworkOwner: dependencies.createNetworkOwner ?? (port => createNativeNetworkOwner({ port })),
    createPlatformOwner: (network, getLocalOrigin, nativePort, onInstalledAppsUpdated) => createDesktopPlatformOwner({ fetch: network.fetch, settings, getLocalOrigin, nativePort, dataDirectory: dataDir, onInstalledAppsUpdated }),
    async start(options) {
      const start = dependencies.start ?? (await import('./index.js')).startWebUiServer;
      const controller = await start(options);
      try { await settings.update(current => { current.desktopLocalPort = controller.getPort(); }); }
      catch (error) { await controller.stop({ exitProcess: false }); throw error; }
      return controller;
    },
    // Preserve the existing LAN endpoint when possible. Retry only the listener,
    // not the Application Host or its owners; zero lets the OS pick the fallback.
    serverOptions: { port, fallbackPorts: port === 57123 ? [0] : [57123, 0], host: lanEnabled ? '0.0.0.0' : '127.0.0.1', uiPassword: password || null },
    send: stdio.send,
    exit: stdio.exit,
  });
  await stdio.run(session);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runManagedDesktopHost().catch(error => { console.error('[desktop-host] Bootstrap failed:', error instanceof Error ? error.name : 'UnknownError'); process.exit(1); });
}
