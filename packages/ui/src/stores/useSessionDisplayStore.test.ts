import { describe, expect, test } from 'vitest';
import { useSessionDisplayStore } from './useSessionDisplayStore';

describe('useSessionDisplayStore project sorting', () => {
  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
  });

  for (const projectSortOrder of ['manual', 'a-z', 'z-a', 'date-added', 'recent'] as const) {
    test(`accepts the ${projectSortOrder} sort order`, () => {
      useSessionDisplayStore.getState().setProjectSortOrder(projectSortOrder);
      expect(useSessionDisplayStore.getState().projectSortOrder).toBe(projectSortOrder);
    });
  }
});
