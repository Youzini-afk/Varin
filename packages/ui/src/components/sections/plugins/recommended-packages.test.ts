import { describe, expect, test } from 'vitest';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@varin/protocol';
import { RECOMMENDED_PACKAGES } from './recommended-packages';

describe('recommended Pi packages', () => {
  test('includes every maintained context integration with its installable source', () => {
    const sourceByName = Object.fromEntries(RECOMMENDED_PACKAGES.map((entry) => [entry.name, entry.source]));

    expect(sourceByName['pi-subagents']).toBe('npm:pi-subagents');
    expect(sourceByName['pi-background-tasks']).toBe('npm:pi-background-tasks');
    expect(RECOMMENDED_PACKAGES.find((entry) => entry.name === 'pi-background-tasks')?.workbench).toBe('fleet');
    expect(sourceByName['context-mode']).toBe('npm:context-mode');
    expect(sourceByName['@cortexkit/aft-pi']).toBe('npm:@cortexkit/aft-pi');
    expect(sourceByName['pi-lens']).toBe('npm:pi-lens');
    expect(sourceByName['pi-hermes-memory']).toBe('npm:pi-hermes-memory');
    expect(sourceByName['pi-rtk-optimizer']).toBe('npm:pi-rtk-optimizer');
  });

  test('keeps foundational integrations out of the recommended catalog', () => {
    for (const integration of FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations) {
      expect(RECOMMENDED_PACKAGES.some((item) => item.name === integration.packageName)).toBe(false);
    }
  });

  test('does not render duplicate package identities or install sources', () => {
    const names = RECOMMENDED_PACKAGES.map((entry) => entry.name);
    const sources = RECOMMENDED_PACKAGES.map((entry) => entry.source);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
