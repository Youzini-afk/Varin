import type { VarinExtensionCatalogEntry } from '@varin/extension-contract';
import type { VarinBuiltinExtensionDefinition } from '@varin/extension-builtins';

/** Exercise shipped declarations instead of maintaining a second shell manifest. */
export const builtinWorkbenchEntry = (
  definition: VarinBuiltinExtensionDefinition,
  enabled = true,
): VarinExtensionCatalogEntry => ({
  manifest: structuredClone(definition.manifest),
  source: { display: definition.manifest.displayName ?? definition.manifest.id, kind: 'builtin' },
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: definition.manifest.version,
  selectedVersion: definition.manifest.version,
});
