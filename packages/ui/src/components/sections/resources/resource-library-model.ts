import type {
  NativeResourceDescriptor,
  NativeResourceDiagnostic,
  NativeResourceKind,
} from '@varin/application-client';

export const createResourceStarter = (kind: NativeResourceKind, rawName: string): string => {
  const name = rawName.trim().replace(/\.md$/i, '');

  return [
    '---',
    `name: ${JSON.stringify(name || 'skill-name')}`,
    'description: Describe when the agent should use this skill',
    '---',
    '',
    `# ${name || 'Skill'}`,
    '',
    'Explain the workflow, constraints, and any bundled resources the agent should use.',
    '',
  ].join('\n');
};

export type NativeResourceNameError = 'empty' | 'reserved' | 'separator';

export const validateResourceName = (name: string): NativeResourceNameError | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed === '.' || trimmed === '..') return 'reserved';
  if (trimmed.includes('\0') || /[\\/]/.test(trimmed)) return 'separator';
  return null;
};

export const sortResources = (
  resources: readonly NativeResourceDescriptor[],
): NativeResourceDescriptor[] => [...resources].sort((left, right) => (
  Number(right.active) - Number(left.active)
  || Number(right.valid) - Number(left.valid)
  || left.name.localeCompare(right.name)
  || left.filePath.localeCompare(right.filePath)
));

export const filterResources = (
  resources: readonly NativeResourceDescriptor[],
  query: string,
): NativeResourceDescriptor[] => {
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

export const diagnosticsForResource = (
  diagnostics: readonly NativeResourceDiagnostic[],
  resource: NativeResourceDescriptor,
): NativeResourceDiagnostic[] => diagnostics.filter(diagnostic => (
  diagnostic.path === resource.filePath || diagnostic.resourceId === resource.id
));
