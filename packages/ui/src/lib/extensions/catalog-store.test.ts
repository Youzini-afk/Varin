import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
afterEach(() => vi.unstubAllGlobals());

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));
import type {
  VarinExtensionHostStateSnapshot,
  VarinExtensionServiceRoutingRuleRemoveRequest,
  VarinExtensionServiceRoutingRuleUpdateRequest,
} from '@varin/extension-contract';

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
  services: { hostId, providers: [], revision: 0 },
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

test('routing mutations preserve ordered and unavailable members through refresh and reload, separating empty from automatic', async () => {
  let current = snapshot();
  const updates: VarinExtensionServiceRoutingRuleUpdateRequest[] = [];
  const removals: VarinExtensionServiceRoutingRuleRemoveRequest[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_RUNTIME_APIS__: {
        extensions: {
          hostState: async () => structuredClone(current),
          waitForHostState: () => new Promise(() => undefined),
          upsertServiceRoutingRule: async (request: VarinExtensionServiceRoutingRuleUpdateRequest) => {
            expect(request.expectedRevision).toBe(current.routing.document.revision);
            updates.push(request);
            current = { ...current, revision: current.revision + 1, routing: {
              ...current.routing, storageState: 'ready', document: {
                ...current.routing.document, revision: current.routing.document.revision + 1, rules: [request.rule],
              },
            } };
            return current.routing;
          },
          removeServiceRoutingRule: async (request: VarinExtensionServiceRoutingRuleRemoveRequest) => {
            expect(request.expectedRevision).toBe(current.routing.document.revision);
            removals.push(request);
            current = { ...current, revision: current.revision + 1, routing: {
              ...current.routing, document: { ...current.routing.document, revision: current.routing.document.revision + 1, rules: [] },
            } };
            return current.routing;
          },
        },
      },
    },
  });
  const {
    getVarinExtensionCatalogState, resetVarinExtensionCatalogForTests,
    setVarinExtensionServiceRoute, startVarinExtensionCatalog, stopVarinExtensionCatalog,
  } = await import('./catalog-store');
  const serviceId = 'review.context';
  const scope = { workspaceId: '/workspace' };
  const a = `a:host:${serviceId}@1`;
  const missing = `not-installed:host:${serviceId}@1`;
  const choice = [missing, a];
  const saving = setVarinExtensionServiceRoute(serviceId, 1, scope, choice);
  choice.push('unselected:host:review.context@1');
  await saving;
  expect(updates[0].rule).toEqual({ allowFallback: false, providerKeys: [missing, a], scope, serviceId, version: 1 });
  resetVarinExtensionCatalogForTests(catalogSurfaceRuntime);
  await startVarinExtensionCatalog();
  expect(getVarinExtensionCatalogState().snapshot?.routing.document.rules[0].providerKeys).toEqual([missing, a]);
  await expect(setVarinExtensionServiceRoute(serviceId, 1, scope, [a, a])).rejects.toThrow('must not repeat');
  expect(updates).toHaveLength(1);
  await setVarinExtensionServiceRoute(serviceId, 1, scope, []);
  expect(updates[1]).toMatchObject({ expectedRevision: 1, rule: { providerKeys: [] } });
  expect(getVarinExtensionCatalogState().snapshot?.routing.document.rules[0].providerKeys).toEqual([]);
  expect(removals).toEqual([]);
  await setVarinExtensionServiceRoute(serviceId, 1, scope, null);
  expect(removals).toEqual([{ expectedRevision: 2, scope, serviceId, version: 1 }]);
  expect(getVarinExtensionCatalogState().snapshot?.routing.document.rules).toEqual([]);
  await setVarinExtensionServiceRoute(serviceId, 1, scope, [a]);
  expect(updates[2]).toMatchObject({ expectedRevision: 3, rule: { providerKeys: [a] } });
  expect(updates[2].rule).not.toHaveProperty('providerKey');
  stopVarinExtensionCatalog();
});

test('driver routing captures scope and the original Host before queue dispatch, never writing the choice to a replacement Host', async () => {
  let current = snapshot();
  const writes: VarinExtensionServiceRoutingRuleUpdateRequest[] = [];
  const api = { hostState: async () => current, waitForHostState: () => new Promise(() => undefined),
    upsertServiceRoutingRule: async (request: VarinExtensionServiceRoutingRuleUpdateRequest) => {
      writes.push(request); current.routing.document.rules = [request.rule]; return current.routing;
    } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_RUNTIME_APIS__: { extensions: api } } });
  const { setVarinExtensionServiceRoute, startVarinExtensionCatalog, stopVarinExtensionCatalog } = await import('./catalog-store');
  await startVarinExtensionCatalog();
  const scope = { workspaceId: 'native-workspace-original' };
  const first = setVarinExtensionServiceRoute('varin.agent.driver', 1, scope, ['varin.builtin.agent-driver'], hostId);
  scope.workspaceId = 'mutated-navigation-folder';
  await first;
  expect(writes[0]!.rule.scope).toEqual({ workspaceId: 'native-workspace-original' });
  const pending = setVarinExtensionServiceRoute('varin.agent.driver', 1, scope, ['third-party:host:varin.agent.driver@1'], hostId);
  current = { ...current, catalog: { ...current.catalog, hostId: 'replacement-host' } };
  await expect(pending).rejects.toThrow('Host changed');
  expect(writes).toHaveLength(1);
  const queued = setVarinExtensionServiceRoute('varin.agent.driver', 1, scope, ['varin.builtin.agent-driver'], hostId);
  (window as unknown as { __VARIN_RUNTIME_APIS__: { extensions: unknown } }).__VARIN_RUNTIME_APIS__.extensions = { ...api };
  await expect(queued).rejects.toThrow('Runtime changed');
  expect(writes).toHaveLength(1);
  stopVarinExtensionCatalog();
});

test('accepted restart intent is not reported as failed because the Host disconnects before a refresh', async () => {
  const current = snapshot();
  let reads = 0;
  const requests: Array<{ handoffId: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_RUNTIME_APIS__: { extensions: {
    hostState: async () => { reads += 1; if (reads > 1) throw new Error('Host is restarting'); return current; },
    waitForHostState: () => new Promise(() => undefined),
    requestRestartHandoff: async (request: { handoffId: string }) => { requests.push(request); return { ...current.catalog, revision: 2 }; },
  } } } });
  const { restartVarinExtensionCandidate, getVarinExtensionCatalogState, stopVarinExtensionCatalog } = await import('./catalog-store');
  await restartVarinExtensionCandidate('dev.example.removable', `sha256-${'a'.repeat(64)}`);
  expect(requests).toHaveLength(1);
  expect(requests[0].handoffId).toBeTruthy();
  expect(reads).toBe(1);
  expect(getVarinExtensionCatalogState().error).toBeNull();
  stopVarinExtensionCatalog();
});

test('queued enable rejects an artifact changed after code confirmation instead of enabling the new selection', async () => {
  const { captureExtensionCodeReview } = await import('./code-trust');
  let current = snapshot();
  current.catalog.extensions[0]!.integrity = `sha256-${'a'.repeat(64)}`;
  const review = captureExtensionCodeReview(current, current.catalog.extensions);
  const calls: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_RUNTIME_APIS__: { extensions: {
    hostState: async () => current,
    waitForHostState: () => new Promise(() => undefined),
    setEnabled: async (extensionId: string, enabled: boolean, revision: number) => {
      calls.push([extensionId, enabled, revision]);
      await held;
      current = withRevision(current, 2);
      current.catalog.extensions[0] = { ...current.catalog.extensions[0]!, integrity: `sha256-${'b'.repeat(64)}` };
      return current.catalog;
    },
  } } } });
  const { setVarinExtensionEnabled, getVarinExtensionCatalogState } = await import('./catalog-store');
  const first = setVarinExtensionEnabled('dev.example.removable', false);
  const enabling = setVarinExtensionEnabled('dev.example.removable', true, review);
  const rejected = expect(enabling).rejects.toThrow('Extension code changed after confirmation');
  await waitUntil(() => calls.length === 1);
  release(); await first; await rejected;
  expect(calls).toEqual([['dev.example.removable', false, 1]]);
  expect(getVarinExtensionCatalogState().error).toContain('Review the current version');
});

test('local reload stages reviewed new code without automatically applying it', async () => {
  const current = snapshot();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_RUNTIME_APIS__: { extensions: {
    hostState: async () => current,
    waitForHostState: () => new Promise(() => undefined),
    reloadLocalSource: async () => ({ outcome: 'prepared', candidateIntegrity: 'new-code', snapshot: {
      ...current.catalog, extensions: [{ ...current.catalog.extensions[0], candidate: { integrity: 'new-code', capabilitiesReviewed: true } }],
    } }),
  } } } });
  const { reloadVarinExtensionLocalSource } = await import('./catalog-store');
  // The test runtime's applyCandidate throws if invoked: capability review alone must not apply code.
  await reloadVarinExtensionLocalSource('dev.example.removable');
});

test('an install confirmation for the previous Host cannot run against a new endpoint with a stale catalog on screen', async () => {
  let current = snapshot();
  const installed: unknown[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_RUNTIME_APIS__: { extensions: {
    hostState: async () => current, waitForHostState: () => new Promise(() => undefined),
    install: async (request: unknown) => { installed.push(request); return current.catalog; },
  } } } });
  const { startVarinExtensionCatalog, installVarinExtension } = await import('./catalog-store');
  await startVarinExtensionCatalog();
  current = { ...current, catalog: { ...current.catalog, hostId: '8b17e019-6292-4d60-b3c0-e91952d54d6a' } };
  await expect(installVarinExtension({ kind: 'npm', display: '@example/code@1', specifier: '@example/code@1' }, hostId))
    .rejects.toThrow('Application Host changed after code confirmation');
  expect(installed).toEqual([]);
});


test('applying a profile requires its exact external-code review and sends both owner revisions', async () => {
  // Workbench application loads the real editor lifecycle, including document events.
  vi.stubGlobal('document', parseHTML('<html><body></body></html>').document);
  const current = snapshot();
  current.workbench.document.profiles[0]!.extensionIds = ['dev.example.removable'];
  const applied: unknown[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, __VARIN_RUNTIME_APIS__: { extensions: {
    hostState: async () => current, waitForHostState: () => new Promise(() => undefined),
    applyWorkbenchProfile: async (request: unknown) => { applied.push(request); return current.catalog; },
  } } } });
  const { startVarinExtensionCatalog } = await import('./catalog-store');
  const { captureExtensionCodeReview } = await import('./code-trust');
  const { applyWorkbenchProfile } = await import('./workbench-registry');
  await startVarinExtensionCatalog();
  await expect(applyWorkbenchProfile('default')).rejects.toThrow('Review external extension code');
  const review = captureExtensionCodeReview(current, current.catalog.extensions);
  current.workbench.document.revision += 1;
  await expect(applyWorkbenchProfile('default', review)).rejects.toThrow('Workbench profile changed');
  expect(applied).toEqual([]);
  await applyWorkbenchProfile('default', captureExtensionCodeReview(current, current.catalog.extensions));
  expect(applied).toEqual([{ profileId: 'default', expectedCatalogRevision: 1, expectedWorkbenchRevision: 1 }]);
});
