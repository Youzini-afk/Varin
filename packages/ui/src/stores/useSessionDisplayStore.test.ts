import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('restores tree choices from browser storage independently for each Host', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { addEventListener() {}, localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } });
  vi.resetModules();
  const first = (await import('./useSessionDisplayStore')).useSessionDisplayStore;
  first.getState().setConversationTreeExpansion('local', { groups: { project: false }, sessions: { parent: true } });
  first.getState().setConversationTreeExpansion('host:remote', { sessions: { parent: false } });
  // Flush the normal deferred preference write before recreating the store, as on startup.
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.resetModules();
  const restarted = (await import('./useSessionDisplayStore')).useSessionDisplayStore;
  expect(restarted.getState().conversationTreeByHost).toEqual({
    local: { groups: { project: false }, sessions: { parent: true } },
    'host:remote': { groups: {}, sessions: { parent: false } },
  });
});
