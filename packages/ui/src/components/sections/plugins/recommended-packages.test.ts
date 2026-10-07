import { describe, expect, test } from 'vitest';
import { RECOMMENDED_PACKAGES } from './recommended-packages';

describe('recommended Pi packages', () => {

  test('does not render duplicate package identities or install sources', () => {
    const names = RECOMMENDED_PACKAGES.map((entry) => entry.name);
    const sources = RECOMMENDED_PACKAGES.map((entry) => entry.source);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
