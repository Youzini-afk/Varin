import { afterEach, expect, test, vi } from 'vitest';
import { readPluginCenterView, savePluginCenterView, matchesPluginQuery } from './plugin-center-state';
afterEach(() => vi.unstubAllGlobals());
test('returning from configuration restores only the original Host filters and scroll', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  const view = { tab: 'installed' as const, query: 'mail', category: 'Communication', group: 'external' as const, scroll: 420 };
  savePluginCenterView('host-a', view);
  expect(readPluginCenterView('host-a')).toEqual(view);
  expect(readPluginCenterView('host-b')).toEqual({ tab: 'discover', query: '', category: 'all', group: 'all', scroll: 0 });
});
test('blocked or malformed browser persistence leaves an operable default view', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{invalid', setItem: () => { throw new Error('Blocked'); } });
  expect(readPluginCenterView('host').tab).toBe('discover');
  expect(() => savePluginCenterView('host', readPluginCenterView('host'))).not.toThrow();
});
test('search words can match different locally cached metadata fields', () => {
  expect(matchesPluginQuery('MAIL labs', 'Mail tools', 'Example Labs')).toBe(true);
  expect(matchesPluginQuery('mail missing', 'Mail tools', 'Example Labs')).toBe(false);
});
