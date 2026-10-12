import { isVarinContributionCompatible } from './compatibility.js';
import type { VarinApplicationSurface, VarinExtensionManifest, VarinExtensionStaticContribution } from './types.js';

/** The manifest owner indexes static contributions before their executable owner activates. */
export function varinSurfaceManifestOwnerId(manifest: VarinExtensionManifest): string {
  const occupied = new Set((manifest.entrypoints?.surfaces ?? []).map(entrypoint => entrypoint.id));
  const base = `${manifest.id}.manifest`;
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Canonical declaration shared by the Surface planner and authenticated Host lease admission. */
export function resolveVarinSurfaceManifestOwner(manifest: VarinExtensionManifest, surface: VarinApplicationSurface): {
  entrypointId: string;
  contributions: VarinExtensionStaticContribution[];
} | undefined {
  const entrypoints = (manifest.entrypoints?.surfaces ?? []).filter(entrypoint => entrypoint.supports.includes(surface));
  const grouped = new Set(manifest.updateReadiness?.surfaceEntrypoints ?? []);
  const contributions = (manifest.contributions ?? []).filter(contribution => {
    if (!contribution.supports.includes(surface) || !isVarinContributionCompatible(contribution.kind, contribution.contractVersion)) return false;
    if (!contribution.entrypoint) return true;
    const entrypoint = entrypoints.find(value => value.id === contribution.entrypoint);
    return !!entrypoint && !(entrypoint.mode === 'declarative' && grouped.has(entrypoint.id));
  });
  if (!contributions.length && !entrypoints.some(entrypoint => entrypoint.mode === 'declarative' && !grouped.has(entrypoint.id))) return undefined;
  return { entrypointId: varinSurfaceManifestOwnerId(manifest), contributions };
}
