import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAuthoredPanelConsumer } from './authored-surface-consumer.test-support';
import { SurfaceExtensionRuntime } from '../../../../extension-surface/src/index';
import type { VarinExtensionCatalogSnapshot, VarinExtensionHostStateSnapshot, VarinExtensionManifest } from '@varin/extension-contract';
import type { JsonObject } from '@varin/extension-contract';
import type { SurfaceContribution } from '@varin/extension-surface';
import {
  createWorkbenchCompositionHost,
  getWorkbenchCompositionInspectorSnapshot,
  type WorkbenchCompositionHostOptions,
} from './workbench-composition-host';

type StubElement = HTMLElement & {
  children: StubElement[];
  __setParent?(next: StubElement): void;
};

const createDocumentStub = (): Document => {
  const documentStub = {} as Document;
  documentStub.createElement = (() => createContainer(documentStub)) as Document['createElement'];
  return documentStub;
};

const createContainer = (ownerDocument = createDocumentStub()): StubElement => {
  const children: StubElement[] = [];
  let parent: StubElement | null = null;
  const element = {
    dataset: {},
    className: '',
    textContent: '',
    ownerDocument,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    get children() { return children; },
    appendChild(child: StubElement) {
      child.remove();
      children.push(child);
      child.__setParent?.(element as StubElement);
      return child;
    },
    remove() {
      if (!parent) return;
      const index = parent.children.indexOf(element as StubElement);
      if (index >= 0) parent.children.splice(index, 1);
      parent = null;
    },
    __setParent(next: StubElement) { parent = next; },
  } as unknown as StubElement & { __setParent(next: StubElement): void };
  return element;
};

const childOwner = (generation = 1) => ({
  desiredRevision: generation,
  entrypointId: 'main',
  extensionId: 'dev.example.child',
  extensionVersion: '1.0.0',
  generation,
  hostId: 'host-1',
  realmId: 'child-realm',
});

const shellOwner = {
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: 'dev.example.shell',
  extensionVersion: '1.0.0',
  generation: 1,
  hostId: 'host-1',
  realmId: 'shell-realm',
};

const makeContribution = (
  id: string,
  generation = 1,
  onMount?: (context: { owner: SurfaceContribution['owner']; props: JsonObject }) => void,
  onDispose?: () => void,
): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {},
    id,
    kind: 'view',
    replacement: { target: 'workbench.test' },
    supports: ['web'],
  },
  implementation: {
    mount: (container: HTMLElement, context: { owner: SurfaceContribution['owner']; props: JsonObject }) => {
      onMount?.(context);
      container.textContent = `mounted:${id}:${generation}`;
      return () => {
        container.textContent = '';
        onDispose?.();
      };
    },
  },
  owner: childOwner(generation),
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const optionHarness = (overrides: Partial<WorkbenchCompositionHostOptions> = {}) => {
  const listeners = new Set<() => void>();
  const errors: unknown[] = [];
  const options: WorkbenchCompositionHostOptions = {
    shellContributionId: 'dev.example.shell.entry',
    owner: shellOwner,
    allowedReplacementTargets: new Set(['workbench.test']),
    allowedSlots: new Set(['workbench.test.views']),
    activate: async () => undefined,
    resolveReplacement: () => undefined,
    resolveSlotCandidates: () => [],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError: (error) => { errors.push(error); },
    ...overrides,
  };
  return {
    options,
    errors,
    emit: () => { for (const listener of listeners) listener(); },
    listenerCount: () => listeners.size,
  };
};

test('replacement mounts with the child owner and removes its DOM on dispose', async () => {
  let receivedOwner: SurfaceContribution['owner'] | undefined;
  const contribution = makeContribution('dev.example.replace', 1, (context) => {
    receivedOwner = context.owner;
  });
  const harness = optionHarness({
    resolveReplacement: () => ({ contribution, props: {} }),
  });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  const child = await host.mountReplacement({ container, target: 'workbench.test' });
  expect(container.children).toHaveLength(1);
  expect(container.children[0]?.textContent).toBe('mounted:dev.example.replace:1');
  expect(receivedOwner).toEqual(contribution.owner);
  expect(getWorkbenchCompositionInspectorSnapshot().entries).toHaveLength(1);
  expect(getWorkbenchCompositionInspectorSnapshot().entries[0]).toEqual({
    contributionId: contribution.descriptor.id,
    extensionId: contribution.owner.extensionId,
    generation: contribution.owner.generation,
    host: 'replacement',
    hostId: 'workbench.test',
    shellContributionId: 'dev.example.shell.entry',
  });
  await child.dispose();
  expect(container.children).toHaveLength(0);
  expect(getWorkbenchCompositionInspectorSnapshot().entries).toEqual([]);
  expect(harness.listenerCount()).toBe(0);
});

test('replacement follows owner generation changes and disposes the previous child', async () => {
  let current: SurfaceContribution | undefined;
  let disposed = 0;
  const first = makeContribution('dev.example.replace', 1, undefined, () => { disposed += 1; });
  const second = makeContribution('dev.example.replace', 2, undefined, () => { disposed += 1; });
  const harness = optionHarness({
    resolveReplacement: () => current ? { contribution: current, props: {} } : undefined,
  });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  const child = await host.mountReplacement({ container, target: 'workbench.test' });
  expect(container.children).toHaveLength(0);
  current = first;
  harness.emit();
  await tick();
  expect(container.children[0]?.textContent).toBe('mounted:dev.example.replace:1');
  current = second;
  harness.emit();
  await tick();
  expect(disposed).toBe(1);
  expect(container.children[0]?.textContent).toBe('mounted:dev.example.replace:2');
  await child.dispose();
  expect(disposed).toBe(2);
});

test('Shell host disposal automatically cleans slot children and subscriptions', async () => {
  let disposed = 0;
  const contributions = [
    makeContribution('dev.example.slot1', 1, undefined, () => { disposed += 1; }),
    makeContribution('dev.example.slot2', 1, undefined, () => { disposed += 1; }),
  ];
  const harness = optionHarness({ resolveSlotCandidates: () => contributions });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  await host.mountSlot({ container, slot: 'workbench.test.views', props: { value: 'ok' } });
  expect(container.children).toHaveLength(2);
  expect(harness.listenerCount()).toBe(1);
  await host.dispose('shell removed');
  expect(disposed).toBe(2);
  expect(container.children).toHaveLength(0);
  expect(harness.listenerCount()).toBe(0);
});

test('composition rejects undeclared seams and non-JSON props', async () => {
  const harness = optionHarness();
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  await expect(host.mountReplacement({ container, target: 'workbench.undeclared' })).rejects.toThrow(/did not declare/);
  await expect(host.mountReplacement({
    container,
    target: 'workbench.test',
    props: { callback: (() => undefined) as never },
  })).rejects.toThrow(/JSON-safe/);
});

test('initial child mount failure rejects and releases the host point', async () => {
  const contribution = makeContribution('dev.example.failed');
  contribution.implementation = {
    mount: () => { throw new Error('child failed'); },
  };
  const harness = optionHarness({
    resolveReplacement: () => ({ contribution, props: {} }),
  });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  await expect(host.mountReplacement({ container, target: 'workbench.test' })).rejects.toThrow('child failed');
  expect(container.children).toHaveLength(0);
  expect(harness.listenerCount()).toBe(0);
  expect(harness.errors).toHaveLength(1);
});


test('a generated ordinary module follows the real loader watch and rolls back failed mounts with its resources', async () => {
  const root = new URL('../../../../../examples/extensions/agent-authored-panel/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('varin.extension.json', root), 'utf8')) as VarinExtensionManifest;
  const source = readFileSync(new URL('surface.cjs', root), 'utf8');
  const hash = (value: string) => `sha256-${createHash('sha256').update(value).digest('hex')}`;
  const firstIntegrity = hash('first');
  const failedIntegrity = hash('failed');
  const nextIntegrity = hash('next');
  const modules = new Map([
    [firstIntegrity, source],
    [failedIntegrity, source.replace("const panel = container.ownerDocument", "throw new Error('candidate mount failed'); const panel = container.ownerDocument")],
    [nextIntegrity, source.replace('1.0.0', '2.0.0')],
  ]);
  const applicationHostId = '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a';
  let catalog: VarinExtensionCatalogSnapshot = {
    authoritative: true, diagnostics: [], hostId: applicationHostId, loadedAt: new Date().toISOString(),
    revision: 1, schemaVersion: 1, storageState: 'ready', extensions: [{
      actual: [], capabilityGrants: [], desired: { enabled: false, revision: 1, updatedAt: new Date().toISOString() },
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), integrity: firstIntegrity,
      manifest, resolvedVersion: manifest.version, selectedVersion: manifest.version, source: { kind: 'local', display: 'Fixed authored input' },
    }],
  };
  const state = (): VarinExtensionHostStateSnapshot => ({
    catalog, revision: catalog.revision,
    services: { hostId: applicationHostId, providers: [], revision: catalog.revision, selections: {} },
    routing: { authoritative: true, diagnostics: [], hostId: applicationHostId, storageState: 'missing',
      document: { schemaVersion: 1, revision: 0, rules: [], updatedAt: new Date().toISOString() } },
    workbench: { authoritative: true, diagnostics: [], hostId: applicationHostId, storageState: 'missing',
      document: { schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(), activeProfileId: 'default', layouts: [], profileSelections: { users: {} }, profiles: [{ id: 'default', label: 'Default' }] } },
  });
  const payload = (text: string, integrity: string, path: string) => ({
    artifactIntegrity: integrity, bytesBase64: Buffer.from(text).toString('base64'), contentType: 'text/plain', integrity: hash(text), path,
  });
  const revoked: string[] = [];
  const waiters = new Set<() => void>();
  const reads: string[] = [];
  let abortedWaits = 0;
  let discardedCandidates = 0;
  const publish = () => { for (const wake of [...waiters]) wake(); };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('The loader watch did not reach the expected consumer state');
      await tick();
    }
  };
  const revoke = URL.revokeObjectURL.bind(URL);
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url); revoke(url); });
  const consumer = await createAuthoredPanelConsumer({
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: 'ready', snapshot: catalog }),
      discardPreparedCandidate: async () => { discardedCandidates += 1; },
      hostState: async () => state(),
      invokeService: async () => { throw new Error('No Host service required by this panel'); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => catalog,
      readAsset: async (request) => payload(readFileSync(new URL(request.path.replace(/^package\//, ''), root), 'utf8'), request.integrity, request.path),
      readManagedEntrypoint: async (request) => {
        reads.push(request.integrity);
        return { artifactIntegrity: request.integrity, entrypointId: request.entrypointId,
          module: payload(modules.get(request.integrity)!, request.integrity, 'runtime/surface/panel/module.cjs'), styles: [] };
      },
      reportActualState: async () => undefined,
      selectCandidate: async () => catalog,
      waitForHostState: async (request, signal) => {
        signal?.throwIfAborted();
        if (request.revision !== catalog.revision) return state();
        return new Promise((resolve, reject) => {
          const cleanup = () => { waiters.delete(wake); signal?.removeEventListener('abort', abort); };
          const wake = () => { cleanup(); resolve(state()); };
          const abort = () => { cleanup(); abortedWaits += 1; reject(signal?.reason); };
          waiters.add(wake);
          signal?.addEventListener('abort', abort, { once: true });
        });
      },
  });
  const { container, loader } = consumer;
  const styleCount = () => consumer.styles.filter((style) => style.committed && !style.disposed).length;
  const select = (integrity: string, version: string, enabled = true) => {
    const { candidate, ...entry } = catalog.extensions[0]!;
    void candidate;
    catalog = { ...catalog, revision: catalog.revision + 1, extensions: [{ ...entry, integrity,
      manifest: { ...manifest, version }, selectedVersion: version, resolvedVersion: version,
      desired: { ...entry.desired, enabled, revision: entry.desired.revision + 1 } }] };
    publish();
  };
  try {
    await consumer.start();
    expect(container.children).toHaveLength(0);
    select(firstIntegrity, '1.0.0'); await until(() => container.children.length === 1 && styleCount() === 1);
    expect(container.children).toHaveLength(1);
    const oldMount = container.children[0]!;
    const oldPanel = oldMount.children[0]!;
    expect(oldPanel.children[1]?.textContent).toBe('Agent-authored text counter · 1.0.0');
    expect(styleCount()).toBe(1);
    catalog = { ...catalog, revision: catalog.revision + 1, extensions: [{ ...catalog.extensions[0]!, candidate: {
      applyRequested: true, capabilitiesReviewed: true, capabilityDelta: { added: [], removed: [] }, capabilityGrants: [],
      integrity: failedIntegrity, manifest: { ...manifest, version: '1.1.0' }, preparedAt: new Date().toISOString(),
      resolvedVersion: '1.1.0', source: { kind: 'local', display: 'Requested Host candidate' },
    } }] };
    publish();
    await until(() => loader.getSnapshot().revision === catalog.revision); await tick();
    expect(reads).toEqual([firstIntegrity]);
    expect(discardedCandidates).toBe(0);
    select(failedIntegrity, '1.1.0');
    await until(() => loader.getSnapshot().diagnostics.some((item) => item.message.includes('candidate mount failed')));
    expect(container.children).toEqual([oldMount]);
    expect(oldPanel.dataset.closed).toBeUndefined();
    expect(styleCount()).toBe(1);
    expect(revoked).toHaveLength(1);
    expect(loader.getSnapshot().diagnostics.some((item) => item.message.includes('candidate mount failed'))).toBe(true);
    // Host selection is a separate authority: Surface rollback cannot undo this exact selected version.
    expect(catalog.extensions[0]?.integrity).toBe(failedIntegrity);
    expect(discardedCandidates).toBe(0);
    select(nextIntegrity, '2.0.0'); await until(() => oldPanel.dataset.closed === 'true' && revoked.length === 2);
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).not.toBe(oldMount);
    expect(oldPanel.dataset.closed).toBe('true');
    expect(oldMount.children).toHaveLength(0);
    expect(styleCount()).toBe(1);
    expect(revoked).toHaveLength(2);
    select(nextIntegrity, '2.0.0', false); await until(() => revoked.length === 3);
    expect(container.children).toHaveLength(0);
    expect(styleCount()).toBe(0);
    expect(revoked).toHaveLength(3);
    select(nextIntegrity, '2.0.0'); await until(() => container.children.length === 1 && styleCount() === 1);
    await until(() => waiters.size === 1);
    await consumer.close();
    expect(container.children).toHaveLength(0);
    expect(styleCount()).toBe(0);
    expect(revoked).toHaveLength(4);
    expect(abortedWaits).toBe(1);
    expect(waiters.size).toBe(0);
    const readsAtClose = reads.length;
    select(firstIntegrity, '1.0.0'); await tick();
    expect(reads).toHaveLength(readsAtClose);
  } finally { await consumer.close(); revokeSpy.mockRestore(); }
});

test('an unrelated slot owner can publish while a candidate mount is pending, without remounting retained children', async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const owner = (id: string, generation: number) => ({ ...childOwner(generation), extensionId: id,
    hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a' });
  const descriptor = (id: string) => ({ id: `${id}.panel`, kind: 'panel' as const, contractVersion: 1,
    supports: ['web' as const], placement: { slot: 'workbench.test.views' }, data: {} });
  const harness = optionHarness({
    registerContributionConsumer: runtime.registerContributionConsumer, subscribe: runtime.subscribe,
    resolveSlotCandidates: (slot, _kind, preview) => (preview?.visibleContributions ?? runtime.getSnapshot().visibleContributions)
      .filter((contribution) => contribution.descriptor.placement?.slot === slot),
  });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  await host.mountSlot({ container, slot: 'workbench.test.views' });
  const disposals: string[] = [];
  const mount = (label: string) => ({ mount: (target: HTMLElement) => {
    target.textContent = label;
    return () => { disposals.push(label); };
  } });
  await runtime.activate({ owner: owner('dev.example.slow', 1) }, (context) => context.contribute(descriptor('dev.example.slow'), mount('old')));
  const retained = container.children[0];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = runtime.activate({ owner: owner('dev.example.slow', 2) }, (context) => context.contribute(descriptor('dev.example.slow'), {
    mount: async (target: HTMLElement) => { entered(); await gate; return mount('new').mount(target); },
  }));
  await started;
  await runtime.activate({ owner: owner('dev.example.fast', 1) }, (context) => context.contribute(descriptor('dev.example.fast'), mount('fast')));
  expect(container.children.filter((child) => !child.hidden).map((child) => child.textContent).sort()).toEqual(['fast', 'old']);
  expect(container.children).toContain(retained);
  expect(disposals).toEqual([]);
  release(); await slow;
  expect(container.children.filter((child) => !child.hidden).map((child) => child.textContent).sort()).toEqual(['fast', 'new']);
  expect(disposals).toEqual(['old']);
  await host.dispose();
  expect(disposals.sort()).toEqual(['fast', 'new', 'old']);
});

test('closing a host point aborts an in-progress mount and disposes its eventual result once', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let disposalCount = 0;
  const contribution = makeContribution('dev.example.async');
  contribution.implementation = {
    mount: async (_container: HTMLElement, context: { signal: AbortSignal }) => {
      entered();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return () => { disposalCount += 1; };
    },
  };
  const harness = optionHarness({ resolveReplacement: () => ({ contribution, props: {} }) });
  const host = createWorkbenchCompositionHost(harness.options);
  const container = createContainer();
  const starting = host.mountReplacement({ container, target: 'workbench.test' });
  const rejected = expect(starting).rejects.toThrow(/closed/);
  await started;
  await host.dispose('Window closed'); await rejected;
  expect(disposalCount).toBe(1);
  expect(container.children).toHaveLength(0);
  expect(harness.listenerCount()).toBe(0);
});
