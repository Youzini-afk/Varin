import {
  resolveVarinWorkbenchLayoutForProfile, VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  type VarinApplicationSurface, type VarinExtensionCatalogEntry, type VarinExtensionCatalogSnapshot,
  type VarinExtensionHostStateSnapshot, type VarinExtensionPublicPackageSource,
} from '@varin/extension-contract';

/** A one-action confirmation, never a durable grant or a sandbox claim. */
export interface ExtensionCodeArtifact {
  extensionId: string;
  version: string;
  integrity?: string;
  source: VarinExtensionPublicPackageSource;
}
export interface ExtensionCodeReview {
  hostId: string;
  catalogRevision: number;
  workbenchRevision: number;
  artifacts: ExtensionCodeArtifact[];
}
export const selectedExtensionCode = (entry: VarinExtensionCatalogEntry): ExtensionCodeArtifact => ({
  extensionId: entry.manifest.id, version: entry.selectedVersion,
  ...(entry.integrity ? { integrity: entry.integrity } : {}),
  source: JSON.parse(JSON.stringify(entry.source)) as VarinExtensionPublicPackageSource,
});
export const captureExtensionCodeReview = (
  snapshot: VarinExtensionHostStateSnapshot, entries: readonly VarinExtensionCatalogEntry[],
): ExtensionCodeReview => ({
  hostId: snapshot.catalog.hostId, catalogRevision: snapshot.catalog.revision,
  workbenchRevision: snapshot.workbench.document.revision, artifacts: entries.map(selectedExtensionCode),
});
export const assertExtensionCodeReview = (catalog: VarinExtensionCatalogSnapshot, review: ExtensionCodeReview): void => {
  if (!catalog.authoritative) throw new Error('Extension catalog is not authoritative. Refresh before reviewing code.');
  if (catalog.hostId !== review.hostId || catalog.revision !== review.catalogRevision
    || review.artifacts.some(expected => {
      const entry = catalog.extensions.find(item => item.manifest.id === expected.extensionId);
      return !entry || JSON.stringify(selectedExtensionCode(entry)) !== JSON.stringify(expected);
    })) throw new Error('Extension code changed after confirmation. Review the current version and source again.');
};
export const profileShellCodeToEnable = (
  snapshot: VarinExtensionHostStateSnapshot, profileId: string, surface: VarinApplicationSurface, workspaceId?: string,
): VarinExtensionCatalogEntry[] => {
  const layout = resolveVarinWorkbenchLayoutForProfile(snapshot.workbench.document, {
    surface, userId: 'default', ...(workspaceId ? { workspaceId } : {}),
  }, profileId);
  const shellId = layout.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell];
  return snapshot.catalog.extensions.filter(entry => entry.source.kind !== 'builtin' && !entry.desired.enabled
    && entry.manifest.contributions?.some(contribution => contribution.id === shellId && contribution.kind === 'shell'));
};
