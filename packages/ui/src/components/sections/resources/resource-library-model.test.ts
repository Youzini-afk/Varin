import { describe, expect, test } from 'vitest';
import type { NativeResourceDescriptor } from '@varin/application-client';
import {
  createResourceStarter,
  diagnosticsForResource,
  filterResources,
  sortResources,
  validateResourceName,
} from './resource-library-model';

const descriptor = (overrides: Partial<NativeResourceDescriptor>): NativeResourceDescriptor => ({
  active: false,
  description: '',
  filePath: `C:/agent/${overrides.name ?? 'resource'}.md`,
  id: overrides.name ?? 'resource',
  kind: 'skill',
  name: overrides.name ?? 'resource',
  sourceInfo: {
    origin: 'top-level',
    path: `C:/agent/${overrides.name ?? 'resource'}.md`,
    scope: 'user',
    source: 'user',
  },
  valid: true,
  writable: true,
  ...overrides,
});

describe('native resource library', () => {
  test('creates native skill markdown starters without restricting names', () => {
    expect(createResourceStarter('skill', 'Workspace Check')).toContain('name: "Workspace Check"');
    expect(validateResourceName('Workspace Check')).toBeNull();
    expect(validateResourceName('../escape')).toBe('separator');
  });

  test('sorts active resources first and searches source metadata', () => {
    const inactive = descriptor({ name: 'alpha' });
    const active = descriptor({ active: true, name: 'zeta' });
    expect(sortResources([inactive, active]).map((item) => item.name)).toEqual(['zeta', 'alpha']);
    expect(filterResources([inactive, active], 'user')).toHaveLength(2);
    expect(filterResources([inactive, active], 'zeta')).toEqual([active]);
  });

  test('matches path and collision diagnostics to a resource', () => {
    const resource = descriptor({ name: 'review' });
    const diagnostics = diagnosticsForResource([
      { kind: 'warning', message: 'path', path: resource.filePath },
      { kind: 'collision', message: 'collision', resourceId: resource.id },
      { kind: 'error', message: 'unrelated', path: 'C:/other/file.md' },
    ], resource);
    expect(diagnostics.map((item) => item.message)).toEqual(['path', 'collision']);
  });
});
