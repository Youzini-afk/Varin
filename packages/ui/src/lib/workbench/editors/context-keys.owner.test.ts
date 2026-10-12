import { afterEach, describe, expect, it } from 'vitest';
import { SurfaceExtensionRuntime } from '@varin/extension-surface';
import type { SurfaceContextWriter } from '@varin/extension-surface';
import { startWorkbenchMountSession } from '@/lib/extensions/workbench-mount';
import type { WorkbenchMountImplementation } from '@/lib/extensions/workbench-mount';
import { createWorkbenchCompositionHost } from '@/lib/extensions/workbench-composition-host';
import { createAuthoredPanelTestContainer } from '@/lib/extensions/authored-surface-consumer.test-support';
import {
  batchWorkbenchContextKeyUpdates,
  clearWorkbenchContextKeys,
  createOwnerScopedContextWriter,
  getWorkbenchContextKey,
  getWorkbenchContextKeyStore,
  previewWorkbenchContextKeyUpdates,
  setWorkbenchContextKey,
  subscribeWorkbenchContextKey,
} from './context-keys';

const owner = (entrypointId: string, generation: number) => ({
  entrypointId,
  extensionId: 'dev.example.context',
  generation,
  realmId: 'window-1',
});

afterEach(() => clearWorkbenchContextKeys());

describe('owner-scoped context layers', () => {
  it('keeps candidate values private and fences the prior generation after commit', () => {
    const first = createOwnerScopedContextWriter(owner('main', 1));
    expect(first.writer.set('mode', 'v1')).toBe(true);
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBeUndefined();
    first.commit();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v1');

    const second = createOwnerScopedContextWriter(owner('main', 2));
    expect(second.writer.set('mode', 'v2')).toBe(true);
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v1');
    second.commit();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v2');
    expect(first.writer.set('mode', 'stale')).toBe(false);

    first.dispose();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v2');
    second.dispose();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBeUndefined();
  });

  it('discarding a failed candidate preserves the active owner layer', () => {
    const active = createOwnerScopedContextWriter(owner('main', 1));
    active.writer.set('ready', true);
    active.commit();

    const failed = createOwnerScopedContextWriter(owner('main', 2));
    failed.writer.set('ready', false);
    failed.dispose();
    expect(getWorkbenchContextKey('dev.example.context.ready')).toBe(true);
    active.dispose();
  });

  it('keeps sibling entrypoint layers independent and restores the remaining value', () => {
    const main = createOwnerScopedContextWriter(owner('main', 1));
    const secondary = createOwnerScopedContextWriter(owner('secondary', 1));
    main.writer.set('shared', 'main');
    secondary.writer.set('shared', 'secondary');
    main.writer.set('mainOnly', true);
    secondary.writer.set('secondaryOnly', true);
    main.commit();
    secondary.commit();

    main.dispose();
    expect(getWorkbenchContextKey('dev.example.context.shared')).toBe('secondary');
    expect(getWorkbenchContextKey('dev.example.context.mainOnly')).toBeUndefined();
    expect(getWorkbenchContextKey('dev.example.context.secondaryOnly')).toBe(true);
    secondary.dispose();
  });

  it('publishes when-driven contributions only for the committed active owner', async () => {
    const runtime = new SurfaceExtensionRuntime({
      surface: 'web',
      contextProvider: {
        batch: batchWorkbenchContextKeyUpdates,
        createWriter: createOwnerScopedContextWriter,
        previewContext: previewWorkbenchContextKeyUpdates,
        getContext: getWorkbenchContextKeyStore,
        subscribe: (watchedKeys, listener) => {
          const disposers = watchedKeys.map((key) => subscribeWorkbenchContextKey(key, listener));
          return () => { for (const dispose of disposers) dispose(); };
        },
      },
    });
    const runtimeOwner = {
      ...owner('main', 1),
      desiredRevision: 1,
      extensionVersion: '1.0.0',
      hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
    };
    await runtime.activate({ owner: runtimeOwner }, (context) => {
      context.context.set('ready', true);
      context.contribute({
        contractVersion: 1,
        data: {},
        id: 'dev.example.context.view',
        kind: 'view',
        supports: ['web'],
        when: { key: 'dev.example.context.ready', op: 'equals', value: true },
      }, 'visible');
    });
    expect(runtime.getSnapshot().visibleContributions.map((item) => item.implementation)).toEqual(['visible']);
    await runtime.deactivate({ ...runtimeOwner, desiredRevision: 2, generation: 2 });
    expect(runtime.getSnapshot().visibleContributions).toEqual([]);
    expect(getWorkbenchContextKey('dev.example.context.ready')).toBeUndefined();
  });

  it('mounts and disposes a real contribution session across false, true, false visibility', async () => {
    const runtime = new SurfaceExtensionRuntime({
      surface: 'web',
      contextProvider: {
        batch: batchWorkbenchContextKeyUpdates,
        createWriter: createOwnerScopedContextWriter,
        previewContext: previewWorkbenchContextKeyUpdates,
        getContext: getWorkbenchContextKeyStore,
        subscribe: (watchedKeys, listener) => {
          const disposers = watchedKeys.map((key) => subscribeWorkbenchContextKey(key, listener));
          return () => { for (const dispose of disposers) dispose(); };
        },
      },
    });
    const runtimeOwner = {
      ...owner('main', 1),
      desiredRevision: 1,
      extensionVersion: '1.0.0',
      hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
    };
    let writer: SurfaceContextWriter | undefined;
    let mounts = 0;
    let disposals = 0;
    let session: ReturnType<typeof startWorkbenchMountSession> | null = null;
    let reconciliation = Promise.resolve();
    const reconcile = (): void => {
      reconciliation = reconciliation.then(async () => {
        const contribution = runtime.getSnapshot().visibleContributions[0];
        if (contribution && !session) {
          session = startWorkbenchMountSession({
            container: {} as HTMLElement,
            contributionId: contribution.descriptor.id,
            implementation: contribution.implementation as WorkbenchMountImplementation<Record<string, never>>,
            onError: (error) => { throw error; },
            owner: contribution.owner,
            props: {},
          });
          await session.mounted;
        } else if (!contribution && session) {
          const retiring = session;
          session = null;
          await retiring.dispose('condition became false');
        }
      });
    };
    const unsubscribe = runtime.subscribe(reconcile);
    await runtime.activate({ owner: runtimeOwner }, (context) => {
      writer = context.context;
      context.contribute({
        contractVersion: 1,
        data: {},
        id: 'dev.example.context.conditional-mount',
        kind: 'view',
        supports: ['web'],
        when: { key: 'dev.example.context.ready', op: 'equals', value: true },
      }, {
        mount: () => {
          mounts += 1;
          return () => { disposals += 1; };
        },
      });
    });
    await reconciliation;
    expect(mounts).toBe(0);
    expect(writer?.set('ready', true)).toBe(true);
    await reconciliation;
    expect(mounts).toBe(1);
    expect(writer?.delete('ready')).toBe(true);
    await reconciliation;
    expect(disposals).toBe(1);
    unsubscribe();
    await runtime.deactivate({ ...runtimeOwner, desiredRevision: 2, generation: 2 });
  });
});


it('previews replacement and withdrawal with the original layer precedence without publishing anything', () => {
  setWorkbenchContextKey('dev.example.context.shared', 'base');
  const main = createOwnerScopedContextWriter(owner('main', 1));
  main.writer.set('shared', 'main'); main.writer.set('removed', true); main.commit();
  const secondary = createOwnerScopedContextWriter(owner('secondary', 1));
  secondary.writer.set('shared', 'secondary'); secondary.commit();
  const next = createOwnerScopedContextWriter(owner('main', 2));
  next.writer.set('shared', 'candidate');
  let notifications = 0;
  const unsubscribe = subscribeWorkbenchContextKey('dev.example.context.shared', () => { notifications += 1; });
  const preview = previewWorkbenchContextKeyUpdates({ commit: [next], dispose: [] });
  expect(preview.get('dev.example.context.shared')).toBe('candidate');
  expect(preview.has('dev.example.context.removed')).toBe(false);
  expect(getWorkbenchContextKey('dev.example.context.shared')).toBe('secondary');
  expect(getWorkbenchContextKey('dev.example.context.removed')).toBe(true);
  expect(previewWorkbenchContextKeyUpdates({ commit: [], dispose: [secondary] }).get('dev.example.context.shared')).toBe('main');
  expect(previewWorkbenchContextKeyUpdates({ commit: [], dispose: [secondary, main] }).get('dev.example.context.shared')).toBe('base');
  expect(notifications).toBe(0);
  next.dispose();
  expect(notifications).toBe(0);
  unsubscribe(); secondary.dispose(); main.dispose();
});

const transactionalContextRuntime = () => new SurfaceExtensionRuntime({
  surface: 'web', contextProvider: {
    batch: batchWorkbenchContextKeyUpdates, createWriter: createOwnerScopedContextWriter,
    getContext: getWorkbenchContextKeyStore, previewContext: previewWorkbenchContextKeyUpdates,
    subscribe: (keys, listener) => {
      const disposers = keys.map((key) => subscribeWorkbenchContextKey(key, listener));
      return () => { for (const dispose of disposers) dispose(); };
    },
  },
});
const runtimeOwner = (extensionId: string, generation: number) => ({
  ...owner('main', generation), extensionId, desiredRevision: generation, extensionVersion: '1.0.0',
  hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
});
const contextWorkbench = async (runtime: SurfaceExtensionRuntime) => {
  const container = createAuthoredPanelTestContainer();
  const errors: unknown[] = [];
  const host = createWorkbenchCompositionHost({
    shellContributionId: 'dev.example.shell', owner: runtimeOwner('dev.example.shell', 1),
    allowedReplacementTargets: new Set(), allowedSlots: new Set(['workbench.context']),
    activate: async () => undefined, resolveReplacement: () => undefined,
    resolveSlotCandidates: (slot, _kind, preview) => (preview?.visibleContributions ?? runtime.getSnapshot().visibleContributions)
      .filter((item) => item.descriptor.placement?.slot === slot),
    subscribe: runtime.subscribe, registerContributionConsumer: runtime.registerContributionConsumer,
    onError: (error) => { errors.push(error); },
  });
  await host.mountSlot({ container, slot: 'workbench.context' });
  return { container, errors, host };
};

it('prepares mounts against candidate-owned context and preserves old mounts and resources on failure', async () => {
  const runtime = transactionalContextRuntime();
  const { container, host } = await contextWorkbench(runtime);
  const events: string[] = [];
  const descriptor = (value: string) => ({ id: 'dev.example.context.panel', kind: 'panel' as const, contractVersion: 1,
    supports: ['web' as const], data: {}, placement: { slot: 'workbench.context' },
    when: { op: 'equals' as const, key: 'dev.example.context.view', value } });
  await runtime.activate({ owner: runtimeOwner('dev.example.context', 1) }, (context) => {
    context.context.set('view', 'old');
    context.onDispose(() => { events.push('old-resources-disposed'); });
    context.contribute(descriptor('old'), { mount: (target: HTMLElement) => {
      target.textContent = 'old'; events.push('old-mounted');
      return () => { events.push('old-mount-disposed'); };
    } });
  });
  const oldMount = container.children[0];
  let externalCommit = false;
  await expect(runtime.activateWithCommit({ owner: runtimeOwner('dev.example.context', 2) }, (context) => {
    context.context.set('view', 'new');
    context.contribute(descriptor('new'), { mount: () => { events.push('new-mount-attempt'); throw new Error('new-mount-failed'); } });
  }, () => { externalCommit = true; })).rejects.toThrow('new-mount-failed');
  expect(externalCommit).toBe(false);
  expect(getWorkbenchContextKey('dev.example.context.view')).toBe('old');
  expect(container.children.filter((child) => !child.hidden)).toEqual([oldMount]);
  expect(events).toEqual(['old-mounted', 'new-mount-attempt']);
  expect(runtime.getSnapshot().actual[0]?.generation).toBe(1);
  expect(runtime.getSnapshot().actual[0]?.diagnostics[0]?.code).toBe('candidate_activation_failed');
  await host.dispose(); await runtime.deactivate(runtimeOwner('dev.example.context', 3));
});

it('withdraws mounts depending on a different owner context before retiring that owner resources', async () => {
  const runtime = transactionalContextRuntime();
  const { container, host } = await contextWorkbench(runtime);
  const events: string[] = [];
  await runtime.activate({ owner: runtimeOwner('dev.example.dependent', 1) }, (context) => {
    context.contribute({ id: 'dev.example.dependent.panel', kind: 'panel', contractVersion: 1,
      supports: ['web'], data: {}, placement: { slot: 'workbench.context' },
      when: { op: 'equals', key: 'dev.example.context.ready', value: true },
    }, { mount: (target: HTMLElement) => {
      events.push('dependent-mounted'); target.textContent = 'ready';
      return () => { events.push('dependent-unmounted'); };
    } });
  });
  expect(container.children).toHaveLength(0);
  await runtime.activate({ owner: runtimeOwner('dev.example.context', 1) }, (context) => {
    context.context.set('ready', true);
    context.onDispose(() => { events.push('owner-resources-disposed'); });
  });
  expect(container.children.filter((child) => !child.hidden)).toHaveLength(1);
  expect(events).toEqual(['dependent-mounted']);
  await runtime.deactivate(runtimeOwner('dev.example.context', 2));
  expect(getWorkbenchContextKey('dev.example.context.ready')).toBeUndefined();
  expect(container.children).toHaveLength(0);
  expect(events).toEqual(['dependent-mounted', 'dependent-unmounted', 'owner-resources-disposed']);
  await host.dispose(); await runtime.deactivate(runtimeOwner('dev.example.dependent', 2));
});
