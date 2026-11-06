import { parsePluginInstallLink, type PluginDiscoverySnapshot, type PluginInstallIntent, type PluginInstalledResolution } from '@varin/application-client';
import { type VarinExtensionDiscoveryEntry, type VarinExtensionPackageSource } from '@varin/extension-contract';

/** installed is the Host's exact private-source comparison, never a renderer display-name guess. */
export function installedPluginListing(snapshot: PluginDiscoverySnapshot | null, extensionId: string): VarinExtensionDiscoveryEntry | undefined {
  return snapshot?.entries.find(listing => listing.installed === true && listing.entry.id === extensionId)?.entry;
}
export async function routePluginInstallIntent(intent: PluginInstallIntent, options: {
  resolveInstalled(source: VarinExtensionPackageSource, extensionId?: string): Promise<PluginInstalledResolution>;
  isCurrent(result: PluginInstalledResolution): boolean;
  manage(extensionId: string): void;
  preview(source: VarinExtensionPackageSource, extensionId?: string): void;
}): Promise<void> {
  const result = await options.resolveInstalled(intent.source, intent.extensionId);
  if (!options.isCurrent(result)) return;
  if (result.extensionId) options.manage(result.extensionId);
  else options.preview(intent.source, intent.extensionId);
}
export function directPluginInstallInput(value: string, kind: VarinExtensionPackageSource['kind']): { intent?: PluginInstallIntent; source: VarinExtensionPackageSource } {
  const normalized = value.trim();
  const intent = parsePluginInstallLink(normalized);
  if (intent) return { intent, source: intent.source };
  if (/^varin:\/\//i.test(normalized)) throw new Error('Invalid plugin install link');
  return { source: { display: normalized, kind, specifier: normalized } };
}
