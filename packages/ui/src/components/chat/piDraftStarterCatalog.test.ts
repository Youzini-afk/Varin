import { describe, expect, test } from 'vitest';
import type {
  PiCommandDescriptor,
  PiCommandSource,
  PiResourceCatalogSnapshot,
  PiResourceDescriptor,
} from '@varin/protocol';
import { buildPiDraftStarterCatalog } from './piDraftStarterCatalog';

const descriptor = (
  kind: 'skill',
  name: string,
  scope: 'project' | 'user',
  active = true,
): PiResourceDescriptor => ({
  active,
  description: '',
  filePath: `C:/${scope}/${name}.md`,
  id: `${kind}:${scope}:${name}`,
  kind,
  name,
  sourceInfo: {
    origin: 'top-level',
    path: `C:/${scope}/${name}.md`,
    scope,
    source: scope,
  },
  valid: true,
  writable: true,
});

const catalog = (...resources: PiResourceDescriptor[]): PiResourceCatalogSnapshot => ({
  diagnostics: [],
  projectTrusted: true,
  resources,
});

const command = (name: string, source: PiCommandSource): PiCommandDescriptor => ({
  name,
  source,
  sourceInfo: {
    origin: source === 'extension' ? 'package' : 'top-level',
    path: `C:/commands/${name}`,
    scope: 'user',
    source,
  },
});

describe('Pi draft starter catalog', () => {
  test('keeps Pi command invocations while normalizing skill references', () => {
    const items = buildPiDraftStarterCatalog(
      [
        command('skill:workspace-check', 'skill'),
        command('reload', 'extension'),
      ],
      catalog(descriptor('skill', 'workspace-check', 'project')),
    );

    expect(items).toEqual([
      { invocation: '/skill:workspace-check', name: 'workspace-check', scope: 'project', source: 'skill', type: 'skill' },
      { invocation: '/reload', name: 'reload', scope: 'user', source: 'extension', type: 'command' },
    ]);
  });

  test('uses only active resource ownership and de-duplicates colliding commands', () => {
    const items = buildPiDraftStarterCatalog(
      [
        command('review', 'extension'),
        command('skill:check', 'skill'),
      ],
      catalog(descriptor('skill', 'check', 'project', false)),
    );

    expect(items).toEqual([
      { invocation: '/review', name: 'review', scope: 'user', source: 'extension', type: 'command' },
      { invocation: '/skill:check', name: 'check', scope: 'user', source: 'skill', type: 'skill' },
    ]);
  });
});
