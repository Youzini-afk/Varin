import type { CompanionPackage } from './sequencePackage';

/** Direct pickup dependencies only; do not preload the whole gesture graph. */
export function pickupPreloadDependencies(packages: readonly CompanionPackage[]): Map<string, string[]> {
  const entries = new Map<string, CompanionPackage>();
  for (const asset of packages) {
    const source = asset.gesture?.entrySourceSha256;
    if (source && !entries.has(source)) entries.set(source, asset);
  }
  return new Map(packages.map(asset => {
    const dependencies = new Set<string>();
    const pickup = (entry: CompanionPackage) => {
      dependencies.add(entry.id);
      for (const id of entry.gesture!.grabNext.slice(0, 2)) dependencies.add(id);
    };
    if (asset.gesture?.grabImmediate) {
      dependencies.add(asset.gesture.grabImmediate);
      for (const id of asset.gesture.grabNext.slice(0, 2)) dependencies.add(id);
    } else if (!asset.gesture) {
      for (const frame of asset.frames) {
        const entry = frame.sha256 && entries.get(frame.sha256);
        if (entry) pickup(entry);
      }
    }
    return [asset.id, [...dependencies]];
  }));
}
