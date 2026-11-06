import type { VarinApplicationSurface, VarinExtensionManifest } from '@varin/extension-contract';
import type { SurfaceRegistrySnapshot } from '@varin/extension-surface';
import type { SettingsPageRegistration, SettingsRuntimeContext } from '../settings/page-types';

export interface PluginConfigurationPage {
  id: string;
  title: string;
  primary: boolean;
  titleKey?: SettingsPageRegistration['meta']['titleKey'];
  slug?: string;
  unavailable?: 'disabled' | 'surface' | 'lifecycle';
  supports: VarinApplicationSurface[];
}

/** Declarations explain missing entrypoints; only a live owned registration permits navigation. */
export function pluginConfigurationPages(
  manifest: VarinExtensionManifest,
  enabled: boolean,
  surface: VarinApplicationSurface,
  snapshot: SurfaceRegistrySnapshot,
  registrations: readonly SettingsPageRegistration[],
  runtimeContext: SettingsRuntimeContext,
): PluginConfigurationPage[] {
  const owned = snapshot.contributions.filter(item => item.owner.extensionId === manifest.id && item.descriptor.kind === 'settings-page');
  const declarations = new Map((manifest.contributions ?? []).filter(item => item.kind === 'settings-page').map(item => [item.id, item]));
  for (const item of owned) declarations.set(item.descriptor.id, item.descriptor);
  return [...declarations.values()].map(descriptor => {
    const live = owned.some(item => item.descriptor.id === descriptor.id)
      ? registrations.find(page => page.contributionId === descriptor.id) : undefined;
    const available = live && (!live.meta.isAvailable || live.meta.isAvailable(runtimeContext));
    const entrypoints = manifest.entrypoints?.surfaces;
    const supports = entrypoints?.length ? descriptor.supports.filter(surface => entrypoints.some(entry =>
      (!descriptor.entrypoint || descriptor.entrypoint === entry.id) && entry.supports.includes(surface))) : descriptor.supports;
    return {
      id: descriptor.id,
      title: live?.meta.title ?? (typeof descriptor.data.title === 'string' ? descriptor.data.title : descriptor.id),
      primary: descriptor.data.primary === true,
      ...(live?.meta.titleKey ? { titleKey: live.meta.titleKey } : {}),
      supports,
      ...(available ? { slug: live.meta.slug } : {
        unavailable: supports.length > 0 && !supports.includes(surface) ? 'surface' as const
          : !enabled ? 'disabled' as const : 'lifecycle' as const,
      }),
    };
  }).sort((a, b) => Number(b.primary) - Number(a.primary));
}
