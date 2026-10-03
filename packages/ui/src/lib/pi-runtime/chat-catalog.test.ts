import { describe, expect, test } from 'vitest';
import type {
  PiCommandDescriptor,
  PiResourceCatalogSnapshot,
  PiResourceDescriptor,
} from '@varin/protocol';
import { buildPiChatCatalog } from './chat-catalog';

const command = (
  name: string,
  source: PiCommandDescriptor['source'] = 'skill',
): PiCommandDescriptor => ({
  description: `Command ${name}`,
  name,
  source,
  sourceInfo: {
    origin: 'package',
    path: `C:/packages/${name}.md`,
    scope: 'user',
    source: 'npm:example',
  },
});

const skill = (
  name: string,
  overrides: Partial<PiResourceDescriptor> = {},
): PiResourceDescriptor => ({
  active: true,
  description: `Resource ${name}`,
  filePath: `C:/project/.pi/skills/${name}/SKILL.md`,
  id: `skill:project:${name}`,
  kind: 'skill',
  name,
  sourceInfo: {
    origin: 'top-level',
    path: `C:/project/.pi/skills/${name}/SKILL.md`,
    scope: 'project',
    source: 'project',
  },
  valid: true,
  writable: true,
  ...overrides,
});

const catalog = (...resources: PiResourceDescriptor[]): PiResourceCatalogSnapshot => ({
  diagnostics: [],
  projectTrusted: true,
  resources,
});

describe('Pi chat catalog', () => {
  test('keeps command invocations authoritative and enriches skills from active resources', () => {
    const commands = [
      command('review', 'prompt'),
      command('skill:workspace-check'),
    ];

    expect(buildPiChatCatalog(commands, catalog(skill('workspace-check')))).toEqual({
      commands,
      skills: [{
        description: 'Resource workspace-check',
        filePath: 'C:/project/.pi/skills/workspace-check/SKILL.md',
        invocation: 'skill:workspace-check',
        name: 'workspace-check',
        scope: 'project',
        source: 'project',
      }],
    });
  });

  test('retains callable skills missing from the resource catalog', () => {
    expect(buildPiChatCatalog(
      [command('skill:package-only')],
      catalog(),
    ).skills).toEqual([{
      description: 'Command skill:package-only',
      filePath: 'C:/packages/skill:package-only.md',
      invocation: 'skill:package-only',
      name: 'package-only',
      scope: 'user',
      source: 'npm:example',
    }]);
  });

  test('does not link inactive or invalid resource entries', () => {
    const inactive = skill('disabled', { active: false });
    const invalid = skill('broken', { valid: false });
    const result = buildPiChatCatalog(
      [command('skill:disabled'), command('skill:broken')],
      catalog(inactive, invalid),
    );

    expect(result.skills.map((entry) => ({ invocation: entry.invocation, filePath: entry.filePath })))
      .toEqual([
        { invocation: 'skill:disabled', filePath: undefined },
        { invocation: 'skill:broken', filePath: undefined },
      ]);
  });

  test('rejects non-native skill aliases and de-duplicates command collisions', () => {
    const result = buildPiChatCatalog(
      [
        command('legacy-skill'),
        command('skill:check'),
        command('skill:check'),
      ],
      catalog(skill('check')),
    );

    expect(result.skills.map((entry) => entry.invocation)).toEqual(['skill:check']);
  });
});
