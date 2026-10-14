import { expect, test } from 'vitest';
import { isDesktopThreadNavigationTarget } from './desktopThreadNavigation';
test('desktop events cannot open a native Thread on a different Host or relay identity', () => {
  const current = { apiBaseUrl: 'https://host.test/', relayHostId: 'relay:a' };
  expect(isDesktopThreadNavigationTarget({ apiBaseUrl: 'https://host.test', relayHostId: 'relay:a' }, current)).toBe(true);
  expect(isDesktopThreadNavigationTarget({ apiBaseUrl: 'https://host.test', relayHostId: 'relay:b' }, current)).toBe(false);
  expect(isDesktopThreadNavigationTarget({ apiBaseUrl: 'https://other.test', relayHostId: 'relay:a' }, current)).toBe(false);
  expect(isDesktopThreadNavigationTarget({}, current)).toBe(false);
});
