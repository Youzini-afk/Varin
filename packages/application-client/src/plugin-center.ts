import type { VarinExtensionCatalogSnapshot, VarinExtensionDiscoveryEntry, VarinExtensionPackageSource,
  VarinExtensionReleasePreview, VarinExtensionReleaseInstallRequest, VarinExtensionUpdateCheck } from '@varin/extension-contract';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
export interface PluginCatalogSource { url: string; displayName?: string; enabled: boolean }
export interface PluginCatalogState extends PluginCatalogSource {
  status: 'unloaded' | 'ready' | 'stale' | 'error'; updatedAt?: string; checkedAt?: string; error?: string;
}
export interface PluginDiscoveryEntry { key: string; entry: VarinExtensionDiscoveryEntry; catalogs: string[]; installed?: boolean }
export interface PluginDiscoverySnapshot { hostId: string; hostLabel?: string; sources: PluginCatalogState[]; entries: PluginDiscoveryEntry[] }
export interface PluginInstalledResolution { hostId: string; extensionId?: string }
export interface PluginCenterAPI {
  resolveInstalled(source: VarinExtensionPackageSource, extensionId?: string, signal?: AbortSignal): Promise<PluginInstalledResolution>;
  discovery(signal?: AbortSignal): Promise<PluginDiscoverySnapshot>;
  refreshDiscovery(signal?: AbortSignal): Promise<PluginDiscoverySnapshot>;
  saveSources(sources: PluginCatalogSource[], signal?: AbortSignal): Promise<PluginDiscoverySnapshot>;
  preview(source: VarinExtensionPackageSource, extensionId?: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview>;
  previewUpdate(extensionId: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview>;
  previewArchive(file: Blob, filename: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview>;
  discard(previewId: string): Promise<void>;
  install(request: VarinExtensionReleaseInstallRequest, signal?: AbortSignal): Promise<VarinExtensionCatalogSnapshot>;
  checkUpdates(extensionId?: string, signal?: AbortSignal): Promise<VarinExtensionUpdateCheck[]>;
}
export class PluginCenterError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'PluginCenterError'; }
}
/** Inject the same authenticated Application Host transport as the extension catalog, never a second backend. */
export function createPluginCenterHttpAPI(transport: (path: string, options: RequestInit) => Promise<Response>,
  generation: () => number = getRuntimeEndpointGeneration): PluginCenterAPI {
  const request = async <T>(path: string, method: string, body?: unknown, signal?: AbortSignal, filename?: string): Promise<T> => {
    const owner = generation();
    const assertOwner = () => {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (owner !== generation()) throw new PluginCenterError('host-changed', 'Application Host changed. Review the package on the current Host.');
    };
    assertOwner();
    const response = await transport(`/api/varin/extensions/v1/${path}`, { method, ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json', 'Content-Type': filename ? 'application/octet-stream' : 'application/json', ...(filename ? { 'X-Varin-Archive-Name': encodeURIComponent(filename) } : {}) },
      ...(body === undefined ? {} : { body: filename ? body as Blob : JSON.stringify(body) }) });
    assertOwner();
    const value = await response.json();
    assertOwner();
    if (!response.ok) throw new PluginCenterError(value?.error?.code ?? 'request-failed', value?.error?.message ?? value?.message ?? `Plugin request failed (${response.status})`, response.status);
    return value as T;
  };
  return {
    resolveInstalled: (source, extensionId, signal) => request('discovery/resolve-installed', 'POST', { source, ...(extensionId ? { extensionId } : {}) }, signal),
    discovery: signal => request('discovery', 'GET', undefined, signal),
    refreshDiscovery: signal => request('discovery/refresh', 'POST', {}, signal),
    saveSources: (sources, signal) => request('discovery/sources', 'PUT', { sources }, signal),
    preview: (source, extensionId, signal) => request('releases/preview', 'POST', { source, ...(extensionId ? { extensionId } : {}) }, signal),
    previewUpdate: (extensionId, signal) => request('releases/preview', 'POST', { extensionId }, signal),
    previewArchive: (file, filename, signal) => request('releases/preview-archive', 'POST', file, signal, filename),
    discard: previewId => request('releases/discard', 'POST', { previewId }),
    install: (input, signal) => request('releases/install', 'POST', input, signal),
    checkUpdates: (extensionId, signal) => request('updates', 'POST', extensionId ? { extensionId } : {}, signal),
  };
}
