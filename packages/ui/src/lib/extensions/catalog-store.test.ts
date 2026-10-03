import { beforeEach, expect, test } from 'vitest';
import type { VarinExtensionHostStateSnapshot } from '@varin/extension-contract';

let refreshCount = 0;
const catalogSurfaceRuntime = {
  applyCandidate: async (): Promise<never> => { throw new Error('not used'); },
  refresh: async (): Promise<void> => { refreshCount += 1; },
};

const hostId = '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a';

const snapshot = (): VarinExtensionHostStateSnapshot => ({
  catalog: {
    authoritative: true,
    diagnostics: [],
    extensions: [{
      actual: [],
      capabilityGrants: [],
      desired: { enabled: false, revision: 1, updatedAt: '2026-08-14T00:00:00.000Z' },
      installedAt: '2026-08-14T00:00:00.000Z',
      manifest: {
        engines: { varin: '*' },
        id: 'dev.example.removable',
        schemaVersion: 1,
        version: '1.0.0',
      },
      resolvedVersion: '1.0.0',
      selectedVersion: '1.0.0',
      source: { display: 'Removable', kind: 'local' },
      updatedAt: '2026-08-14T00:00:00.000Z',
    }],
    hostId,
    loadedAt: '2026-08-14T00:00:00.000Z',
    revision: 1,
    schemaVersion: 1,
    storageState: 'ready',
  },
  revision: 1,
  routing: {
    authoritative: true,
    diagnostics: [],
    document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
    hostId,
    storageState: 'missing',
  },
  services: { hostId, providers: [], revision: 0, selections: {} },
  workbench: {
    authoritative: true,
    diagnostics: [],
    document: {
      activeProfileId: 'default',
      layouts: [],
      profileSelections: { users: {} },
      profiles: [{ id: 'default', label: 'Default' }],
      revision: 0,
      schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    hostId,
    storageState: 'missing',
  },
});

const removedCatalog = (): VarinExtensionHostStateSnapshot['catalog'] => ({
  ...snapshot().catalog,
  extensions: [],
  revision: 2,
});

const withRevision = (
  current: VarinExtensionHostStateSnapshot,
  revision: number,
): VarinExtensionHostStateSnapshot => ({
  ...current,
  catalog: { ...current.catalog, revision },
  revision,
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for catalog watcher');
};

beforeEach(async () => {
  const { resetVarinExtensionCatalogForTests } = await import('./catalog-store');
  refreshCount = 0;
  resetVarinExtensionCatalogForTests(catalogSurfaceRuntime);
});

test('rebuilds the authoritative baseline after a failed wait and resumes long-polling', async () => {
  const initial = snapshot();
  const recovered = withRevision(initial, 2);
  const changed = withRevision(recovered, 3);
  let hostStateReads = 0;
  let waitCalls = 0;
  const waitRequests: unknown[] = [];
  let resolveWait: (next: VarinExtensionHostStateSnapshot) => void = () => undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_RUNTIME_APIS__: {
        extensions: {
          hostState: async () => {
            hostStateReads += 1;
            return hostStateReads === 1 ? initial : recovered;
          },
          waitForHostState: async (request: unknown) => {
            waitCalls += 1;
            waitRequests.push(request);
            if (waitCalls === 1) throw new Error('relay disconnected');
            return new Promise<VarinExtensionHostStateSnapshot>((resolve) => {
              resolveWait = resolve;
            });
          },
        },
      },
    },
  });
  const {
    getVarinExtensionCatalogState,
    startVarinExtensionCatalog,
    stopVarinExtensionCatalog,
  } = await import('./catalog-store');

  await startVarinExtensionCatalog();
  await waitUntil(() => hostStateReads === 2 && waitCalls === 2);
  expect(getVarinExtensionCatalogState().snapshot?.revision).toBe(2);
  expect(waitRequests).toEqual([
    { hostId, revision: 1 },
    { hostId, revision: 2 },
  ]);

  resolveWait(changed);
  await waitUntil(() => waitCalls === 3);
  expect(getVarinExtensionCatalogState().snapshot?.revision).toBe(3);
  expect(waitRequests[2]).toEqual({ hostId, revision: 3 });
  stopVarinExtensionCatalog();
});

test('recovers when the initial authoritative Host-state read fails', async () => {
  const initial = snapshot();
  let hostStateReads = 0;
  let waitCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_RUNTIME_APIS__: {
        extensions: {
          hostState: async () => {
            hostStateReads += 1;
            if (hostStateReads === 1) throw new Error('host starting');
            return initial;
          },
          waitForHostState: () => {
            waitCalls += 1;
            return new Promise(() => undefined);
          },
        },
      },
    },
  });
  const {
    getVarinExtensionCatalogState,
    startVarinExtensionCatalog,
    stopVarinExtensionCatalog,
  } = await import('./catalog-store');

  await startVarinExtensionCatalog();
  expect(hostStateReads).toBe(2);
  expect(waitCalls).toBe(1);
  expect(getVarinExtensionCatalogState().snapshot?.catalog.hostId).toBe(hostId);
  expect(getVarinExtensionCatalogState().error).toBeNull();
  stopVarinExtensionCatalog();
});

test('stop cancels the wait and rejects a late completion from the old owner', async () => {
  const oldSnapshot = snapshot();
  const newHostId = '8d9b2b76-faf2-45d5-908a-88c0d66bfb6e';
  const newSnapshot = {
    ...oldSnapshot,
    catalog: { ...oldSnapshot.catalog, hostId: newHostId },
    routing: { ...oldSnapshot.routing, hostId: newHostId },
    services: { ...oldSnapshot.services, hostId: newHostId },
    workbench: { ...oldSnapshot.workbench, hostId: newHostId },
  };
  const waitResolvers: Array<(next: VarinExtensionHostStateSnapshot) => void> = [];
  let oldWaitCalls = 0;
  let newHostStateReads = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_RUNTIME_APIS__: {
        extensions: {
          hostState: async () => {
            newHostStateReads += 1;
            return newHostStateReads === 1 ? oldSnapshot : newSnapshot;
          },
          waitForHostState: async () => {
            oldWaitCalls += 1;
            return new Promise<VarinExtensionHostStateSnapshot>((resolve) => {
              waitResolvers.push(resolve);
            });
          },
        },
      },
    },
  });
  const {
    getVarinExtensionCatalogState,
    startVarinExtensionCatalog,
    stopVarinExtensionCatalog,
  } = await import('./catalog-store');

  await startVarinExtensionCatalog();
  await waitUntil(() => oldWaitCalls === 1);
  stopVarinExtensionCatalog();
  await startVarinExtensionCatalog();
  expect(getVarinExtensionCatalogState().snapshot?.catalog.hostId).toBe(newHostId);

  waitResolvers[0]?.({ ...oldSnapshot, revision: 99, catalog: { ...oldSnapshot.catalog, revision: 99 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(getVarinExtensionCatalogState().snapshot?.catalog.hostId).toBe(newHostId);
  stopVarinExtensionCatalog();
});

for (const deleteData of [false, true] as const) {
  test(`remove sends deleteData=${deleteData} explicitly`, async () => {
    const requests: unknown[] = [];
    const current = snapshot();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __VARIN_RUNTIME_APIS__: {
          extensions: {
            hostState: async () => current,
            removeExtension: async (request: unknown) => {
              requests.push(request);
              return removedCatalog();
            },
            waitForHostState: () => new Promise(() => undefined),
          },
        },
      },
    });
    const { removeVarinExtension } = await import('./catalog-store');
    await removeVarinExtension('dev.example.removable', deleteData);
    expect(requests).toEqual([{
      deleteData,
      expectedRevision: 1,
      extensionId: 'dev.example.removable',
    }]);
    expect(refreshCount).toBe(1);
  });
}

test('setEnabled only mutates catalog desired state', async () => {
  const current = snapshot();
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_RUNTIME_APIS__: {
        extensions: {
          hostState: async () => current,
          setEnabled: async (extensionId: string, enabled: boolean, expectedRevision: number) => {
            calls.push([extensionId, enabled, expectedRevision]);
            return {
              ...current.catalog,
              extensions: current.catalog.extensions.map((entry) => (
                entry.manifest.id === extensionId
                  ? { ...entry, desired: { ...entry.desired, enabled, revision: entry.desired.revision + 1 } }
                  : entry
              )),
              revision: current.catalog.revision + 1,
            };
          },
          waitForHostState: () => new Promise(() => undefined),
        },
      },
    },
  });
  const { setVarinExtensionEnabled } = await import('./catalog-store');
  await setVarinExtensionEnabled('varin.builtin.agent-workspace', false);
  expect(calls).toEqual([['varin.builtin.agent-workspace', false, 1]]);
  expect(refreshCount).toBe(0);
});

test('exposes catalog watch generation so in-flight shell candidates can abort', async () => {
  const {
    getVarinExtensionCatalogWatchGeneration,
    resetVarinExtensionCatalogForTests,
  } = await import('./catalog-store');
  const before = getVarinExtensionCatalogWatchGeneration();
  resetVarinExtensionCatalogForTests();
  expect(getVarinExtensionCatalogWatchGeneration()).toBeGreaterThan(before);
});
