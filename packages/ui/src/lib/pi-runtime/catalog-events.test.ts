import { describe, expect, test } from 'vitest';
import {
  notifyPiRuntimeCatalogChanged,
  subscribePiRuntimeCatalogChanged,
} from './catalog-events';

describe('Pi runtime catalog events', () => {
  test('invalidates catalogs after successful plugin configuration reloads', () => {
    const reasons: string[] = [];
    const unsubscribe = subscribePiRuntimeCatalogChanged((reason) => reasons.push(reason));
    notifyPiRuntimeCatalogChanged('plugin-config');
    unsubscribe();
    notifyPiRuntimeCatalogChanged('reload');

    expect(reasons).toEqual(['plugin-config']);
  });
});
