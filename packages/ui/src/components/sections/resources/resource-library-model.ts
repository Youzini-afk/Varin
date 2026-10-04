import type {
  PiResourceDescriptor,
  PiResourceDiagnostic,
  PiResourceKind,
} from '@varin/protocol';

export const createPiResourceStarter = (kind: PiResourceKind, rawName: string): string => {
  const name = rawName.trim().replace(/\.md$/i, '');

  return [
    '---',
    `name: ${JSON.stringify(name || 'skill-name')}`,
    'description: Describe when Pi should use this skill',
    '---',
    '',
    `# ${name || 'Skill'}`,
    '',
    'Explain the workflow, constraints, and any bundled resources Pi should use.',
    '',
  ].join('\n');
};

export type PiResourceNameError = 'empty' | 'reserved' | 'separator';

export const validatePiResourceName = (name: string): PiResourceNameError | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed === '.' || trimmed === '..') return 'reserved';
  if (trimmed.includes('\0') || /[\\/]/.test(trimmed)) return 'separator';
  return null;
};

export const sortPiResources = (
  resources: readonly PiResourceDescriptor[],
): PiResourceDescriptor[] => [...resources].sort((left, right) => (
  Number(right.active) - Number(left.active)
  || Number(right.valid) - Number(left.valid)
  || left.name.localeCompare(right.name)
  || left.filePath.localeCompare(right.filePath)
));

export const filterPiResources = (
  resources: readonly PiResourceDescriptor[],
  query: string,
): PiResourceDescriptor[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...resources];
  return resources.filter((resource) => [
    resource.name,
    resource.description,
    resource.filePath,
    resource.sourceInfo.source,
    resource.sourceInfo.scope,
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
};

export const diagnosticsForPiResource = (
  diagnostics: readonly PiResourceDiagnostic[],
  resource: PiResourceDescriptor,
): PiResourceDiagnostic[] => diagnostics.filter((diagnostic) => (
  diagnostic.path === resource.filePath
  || diagnostic.collision?.winnerPath === resource.filePath
  || diagnostic.collision?.loserPath === resource.filePath
  || diagnostic.collision?.name === resource.name
));
