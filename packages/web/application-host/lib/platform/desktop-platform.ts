/** Local desktop coordination without constructing an Application Host. */
import { createDesktopDeepLinks } from './desktop-deep-links.js';
import { readFileSync } from 'node:fs';
import { createDesktopAppsOwner } from './desktop-apps.js';
import type { DesktopNativePort } from './desktop-host-session.js';
import type { SettingsFileStore } from '@varin/settings-store';
import { createDesktopConnections, desktopDeviceMetadata, getOrCreateDesktopInstallId, isKnownLocalDesktopUrl, type DesktopConnectionFetch } from './desktop-connections.js';

export interface DesktopPlatformOwner { invoke(input: unknown): Promise<unknown>; dispose(): Promise<void> }
export function createDesktopPlatformOwner(options: {
  fetch: DesktopConnectionFetch;
  settings: Pick<SettingsFileStore, 'readSync' | 'update'>;
  getLocalOrigin(): string | null;
  appVersion?: string;
  dataDirectory?: string;
  nativePort?: DesktopNativePort;
  onInstalledAppsUpdated?(apps: unknown): void;
}): DesktopPlatformOwner {
  const apps = options.nativePort && options.dataDirectory ? createDesktopAppsOwner({
    dataDirectory: options.dataDirectory,
    async openPath(path) { await options.nativePort!.request('platform.openPath', { path }); },
    async showItemInFolder(path) { await options.nativePort!.request('platform.showItemInFolder', { path }); },
    async fileIcon(path) {
      const result = await options.nativePort!.request('platform.fileIcon', { path });
      if (result !== null && (typeof result !== 'string' || !result.startsWith('data:image/png;base64,'))) throw new Error('Invalid native file icon');
      return result;
    },
    updated: apps => options.onInstalledAppsUpdated?.(apps),
    async launchApp(input) { await options.nativePort!.request('platform.launchApp', input); },
  }) : undefined;
  const deviceMetadata = () => {
      let version = options.appVersion;
      if (!version) {
        const value: unknown = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
        if (value && typeof value === 'object' && 'version' in value && typeof value.version === 'string') version = value.version;
      }
      return desktopDeviceMetadata(process.platform, version);
    };
  const connections = createDesktopConnections({
    fetch: options.fetch,
    getInstallId: () => getOrCreateDesktopInstallId(options.settings),
    deviceMetadata,
    isLocalRuntimeUrl: url => isKnownLocalDesktopUrl(url, options.getLocalOrigin()),
  });
  const links = createDesktopDeepLinks({ settings: options.settings, fetch: options.fetch,
    getInstallId: () => getOrCreateDesktopInstallId(options.settings), deviceMetadata,
    async confirm(preview) { if (!options.nativePort) throw new Error('Native connection confirmation is unavailable'); return await options.nativePort.request('platform.confirmDeepLink', preview) === true; },
  });
  return { async invoke(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid desktop platform request');
    const value = input as { command?: unknown; args?: unknown };
    if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) throw new Error('Invalid desktop platform arguments');
    const args = (value.args ?? {}) as Record<string, unknown>;
    if (value.command === 'native_deep_link') return links.receive(args.url);
    if (value.command === 'desktop_host_probe') {
      const timeoutMs = args.timeoutMs === 10_000 ? 10_000 : 2_000;
      return connections.probeHostWithTimeout(String(args.url || ''), timeoutMs, String(args.clientToken || ''), args.requestHeaders || {}, String(args.expectedServerId || ''));
    }
    if (value.command === 'desktop_remote_password_login') {
      return connections.loginRemoteAndIssueClientToken({ url: args.url, password: args.password, trustDevice: args.trustDevice === true, requestHeaders: args.requestHeaders || {} });
    }
    if (apps && ['desktop_open_in_app', 'desktop_open_file_in_app', 'desktop_filter_installed_apps', 'desktop_fetch_app_icons', 'desktop_get_installed_apps'].includes(String(value.command))) return apps.invoke(input);
    throw new Error('Unknown desktop platform operation');
  }, async dispose() { await Promise.all([apps?.dispose(), links.dispose()]); } };
}
