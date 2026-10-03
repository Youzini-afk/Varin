import { expect, test } from 'vitest';
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
    get children() { return children; },
    appendChild(child: StubElement) {
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
