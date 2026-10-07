import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PiMcpConfigSnapshot } from '@varin/protocol';

let runtimeKey = 'runtime-a';
let resolveSnapshot: ((snapshot: PiMcpConfigSnapshot) => void) | null = null;
let deferSnapshot = false;
const nextSnapshot: PiMcpConfigSnapshot = {
  catalog: {
    servers: [{ disabled: false, name: 'docs', sourceIds: ['pi-project'], transport: { kind: 'stdio', command: 'docs' } }],
    sources: [{
      displayPath: '.pi/mcp.json',
      id: 'pi-project',
      order: 6,
      scope: 'project',
      serverNames: ['docs'],
      target: { format: 'jsonc', path: '.pi/mcp.json', root: 'project' },
    }],
    version: 1,
  },
  provider: { bridgeVersion: 1, state: 'active' },
};

vi.doMock('@varin/application-client', () => ({ getRuntimeKey: () => runtimeKey }));
vi.doMock('@/lib/pi-runtime/mcp', () => ({
  getPiMcpConfigSnapshot: async () => {
    if (!deferSnapshot) return nextSnapshot;
    return new Promise<PiMcpConfigSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
  },
}));

const store = await import('./mcp-catalog-store');

describe('MCP catalog selection and dirty guards', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    deferSnapshot = false;
    resolveSnapshot = null;
    store.resetMcpCatalogStoreForTests();
  });

  test('selects the first effective server after the first authoritative load', async () => {
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    expect(store.getMcpCatalogStateForTests().selection).toEqual({ kind: 'server', name: 'docs' });
  });

  test('also selects the first server when the target key was initialized before the snapshot arrived', async () => {
    const pending = store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    expect(store.getMcpCatalogStateForTests().targetKey).toBe('target-a');
    await pending;
    expect(store.getMcpCatalogStateForTests().selection).toEqual({ kind: 'server', name: 'docs' });
  });

  test('blocks selection and ordinary refresh while a native draft is dirty', async () => {
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    store.setMcpCatalogEditorDirty(true);
    expect(store.selectMcpCatalogItem({ kind: 'new' })).toBe(false);
    const revision = store.getMcpCatalogStateForTests().catalogRevision;
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    expect(store.getMcpCatalogStateForTests().catalogRevision).toBe(revision);
  });

  test('keeps the in-flight read valid when the page and sidebar request the same catalog', async () => {
    deferSnapshot = true;
    const pending = store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    resolveSnapshot?.(nextSnapshot);
    await pending;
    expect(store.getMcpCatalogStateForTests().loading).toBe(false);
    expect(store.getMcpCatalogStateForTests().snapshot).toEqual(nextSnapshot);
  });

  test('allows the editor save path to force refresh and select its created server', async () => {
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    store.setMcpCatalogEditorDirty(true);
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a', { force: true });
    expect(store.selectMcpCatalogItem({ kind: 'new' }, { force: true })).toBe(true);
  });

  test('does not let save completion replace a newer user selection', async () => {
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    expect(store.selectMcpCatalogItem({ kind: 'new' })).toBe(true);
    expect(store.selectMcpCatalogItem({ kind: 'settings' })).toBe(true);
    expect(store.selectMcpCatalogItemIfCurrent(
      { kind: 'new' },
      { kind: 'server', name: 'created' },
    )).toBe(false);
    expect(store.getMcpCatalogStateForTests().selection).toEqual({ kind: 'settings' });
  });

  test('does not let a forced refresh replace edits made while it is in flight', async () => {
    await store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a');
    store.setMcpCatalogEditorDirty(false);
    deferSnapshot = true;
    const pending = store.refreshMcpCatalog({ cwd: '/workspace' }, 'target-a', { force: true });
    store.setMcpCatalogEditorDirty(true);
    resolveSnapshot?.(nextSnapshot);
    await pending;
    expect(store.getMcpCatalogStateForTests().editorDirty).toBe(true);
    expect(store.getMcpCatalogStateForTests().loading).toBe(false);
  });
});
