import { describe, expect, test } from 'vitest';
import type { PackageDescriptor } from '@varin/protocol';
import {
  installedPluginSettingsPackages,
  pluginSettingsPackageIdentity,
} from './plugin-settings-store';

const entry = (input: Partial<PackageDescriptor> & Pick<PackageDescriptor, 'scope' | 'source'>): PackageDescriptor => ({
  enabled: true,
  installed: true,
  name: input.source,
  structured: false,
  ...input,
});

describe('Plugin Settings installed catalog', () => {
  test('includes every installed package and excludes configured missing packages', () => {
    const packages = installedPluginSettingsPackages([
      entry({ name: 'pi-subagents', scope: 'global', source: 'npm:pi-subagents' }),
      entry({ name: 'unknown-local', scope: 'project', source: '../unknown-local' }),
      entry({ installed: false, name: 'configured-missing', scope: 'global', source: 'npm:missing' }),
    ]);

    expect(packages.map((candidate) => candidate.name)).toEqual(['pi-subagents', 'unknown-local']);
  });

  test('uses scope and exact source as stable identity', () => {
    expect(pluginSettingsPackageIdentity(entry({ scope: 'project', source: 'npm:example@2' })))
      .toBe('project:npm:example@2');
  });
});
