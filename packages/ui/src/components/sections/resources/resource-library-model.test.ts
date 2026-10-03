import { describe, expect, test } from 'vitest';
import type { PiResourceDescriptor } from '@varin/protocol';
import {
  createPiResourceStarter,
  diagnosticsForPiResource,
  filterPiResources,
  sortPiResources,
  validatePiResourceName,
} from './resource-library-model';

const descriptor = (overrides: Partial<PiResourceDescriptor>): PiResourceDescriptor => ({
  active: false,
  description: '',
  filePath: `C:/agent/${overrides.name ?? 'resource'}.md`,
  id: overrides.name ?? 'resource',
  kind: 'prompt',
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

describe('Pi resource library model', () => {
  test('creates native prompt and skill markdown starters without restricting names', () => {
    const prompt = createPiResourceStarter('prompt', 'review.md');
    expect(prompt).toContain('# review');
    expect(prompt).toContain('argument-hint: "[target] [focus]"');
    expect(createPiResourceStarter('skill', 'Workspace Check')).toContain('name: "Workspace Check"');
    expect(validatePiResourceName('Workspace Check')).toBeNull();
    expect(validatePiResourceName('../escape')).toBe('separator');
  });

  test('sorts active resources first and searches source metadata', () => {
    const inactive = descriptor({ name: 'alpha' });
    const active = descriptor({ active: true, name: 'zeta' });
    expect(sortPiResources([inactive, active]).map((item) => item.name)).toEqual(['zeta', 'alpha']);
    expect(filterPiResources([inactive, active], 'user')).toHaveLength(2);
    expect(filterPiResources([inactive, active], 'zeta')).toEqual([active]);
  });

  test('matches path and collision diagnostics to a resource', () => {
    const resource = descriptor({ name: 'review' });
    const diagnostics = diagnosticsForPiResource([
      { type: 'warning', message: 'path', path: resource.filePath },
      {
        type: 'collision',
        message: 'collision',
        collision: {
          loserPath: 'C:/other/review.md',
          name: 'review',
          resourceType: 'prompt',
          winnerPath: resource.filePath,
        },
      },
      { type: 'error', message: 'unrelated', path: 'C:/other/file.md' },
    ], resource);
    expect(diagnostics.map((item) => item.message)).toEqual(['path', 'collision']);
  });
});
