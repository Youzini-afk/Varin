import { expect, test, vi } from 'vitest';
import type { SurfaceContribution, SurfaceOwnerIdentity } from '@varin/extension-surface';
import { startWorkbenchMountSession } from './workbench-mount';

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const {
  triggerVisibleSurfaceContributions,
  workbenchContributionInstanceKey,
} = await import('./workbench-registry');
type WorkbenchMountFailurePhase = Parameters<
  Parameters<typeof startWorkbenchMountSession>[0]['onError']
>[1];

const owner = (generation = 1): SurfaceOwnerIdentity => ({
  desiredRevision: generation,
  entrypointId: 'main',
  extensionId: 'dev.example.mount',
  extensionVersion: '1.0.0',
  generation,
  hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
  realmId: 'mount-test',
});

test('framework-neutral mounts receive props and dispose exactly once after abort', async () => {
  const container = { textContent: '' } as HTMLElement;
  let disposerCalls = 0;
  const signalsAtDispose: AbortSignal[] = [];
  const session = startWorkbenchMountSession({
    container,
    contributionId: 'dev.example.mount.panel',
    implementation: {
      mount: (element, context) => {
        element.textContent = String(context.props.label);
        return () => {
          disposerCalls += 1;
          signalsAtDispose.push(context.signal);
          element.textContent = '';
        };
      },
    },
    onError: (error) => { throw error; },
    owner: owner(),
    props: { label: 'visible mount' },
  });

  await session.mounted;
  expect(container.textContent).toBe('visible mount');
  await Promise.all([session.dispose('disabled'), session.dispose('unmounted')]);
  expect(disposerCalls).toBe(1);
  expect(signalsAtDispose[0]?.aborted).toBe(true);
  expect(container.textContent).toBe('');
});

test('mount sessions forward the Shell composition context supplied by the host', async () => {
  const workbench = {
    mountReplacement: async () => ({ dispose: async () => undefined }),
    mountSlot: async () => ({ dispose: async () => undefined }),
  };
  let received: unknown;
  const session = startWorkbenchMountSession({
    container: {} as HTMLElement,
    contributionId: 'dev.example.mount.shell',
    implementation: {
      mount: (_container, context) => {
        received = (context as typeof context & { workbench?: unknown }).workbench;
      },
    },
    context: { workbench },
    onError: (error) => { throw error; },
    owner: owner(),
    props: { target: 'workbench.shell' },
  });
  await session.mounted;
  expect(received).toBe(workbench);
  await session.dispose();
});

test('prop changes can abort and remount a contribution with current props', async () => {
  const container = { textContent: '' } as HTMLElement;
  const signals: AbortSignal[] = [];
  const implementation = {
    mount: (element: HTMLElement, context: { props: Readonly<{ label: string }>; signal: AbortSignal }) => {
      signals.push(context.signal);
      element.textContent = context.props.label;
      return () => undefined;
    },
  };
  const first = startWorkbenchMountSession({
    container,
    contributionId: 'dev.example.mount.panel',
    implementation,
    onError: (error) => { throw error; },
    owner: owner(),
    props: { label: 'first' },
  });
  await first.mounted;
  await first.dispose('props changed');
  const second = startWorkbenchMountSession({
    container,
    contributionId: 'dev.example.mount.panel',
    implementation,
    onError: (error) => { throw error; },
    owner: owner(),
    props: { label: 'second' },
  });
  await second.mounted;

  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  expect(container.textContent).toBe('second');
  await second.dispose();
});

test('an async mount that finishes after unmount is still disposed once', async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let disposerCalls = 0;
  const mountSignals: AbortSignal[] = [];
  const session = startWorkbenchMountSession({
    container: {} as HTMLElement,
    contributionId: 'dev.example.mount.async',
    implementation: {
      mount: async (_container, context) => {
        mountSignals.push(context.signal);
        await waiting;
        return () => { disposerCalls += 1; };
      },
    },
    onError: (error) => { throw error; },
    owner: owner(),
    props: {},
  });
  await Promise.resolve();
  const disposal = session.dispose('owner replaced');
  expect(mountSignals[0]?.aborted).toBe(true);
  release?.();
  await disposal;
  await session.dispose();
  expect(disposerCalls).toBe(1);
});

test('the mount host accepts the existing isolated iframe implementation shape', async () => {
  let mountedContainer: HTMLElement | null = null;
  let disposed = false;
  const isolatedImplementation = {
    kind: 'isolated-iframe',
    mount: (container: HTMLElement) => {
      mountedContainer = container;
      return () => { disposed = true; };
    },
  };
  const container = {} as HTMLElement;
  const session = startWorkbenchMountSession({
    container,
    contributionId: 'dev.example.mount.isolated',
    implementation: isolatedImplementation,
    onError: (error) => { throw error; },
    owner: owner(),
    props: { ignored: true },
  });
  await session.mounted;
  expect(mountedContainer).toBe(container);
  await session.dispose();
  expect(disposed).toBe(true);
});

test('mount and disposer failures remain attributed to their lifecycle phase', async () => {
  const failures: Array<{ message: string; phase: WorkbenchMountFailurePhase }> = [];
  const failedMount = startWorkbenchMountSession({
    container: {} as HTMLElement,
    contributionId: 'dev.example.mount.failure',
    implementation: { mount: () => { throw new Error('mount failed'); } },
    onError: (error, phase) => failures.push({ message: String(error), phase }),
    owner: owner(),
    props: {},
  });
  await failedMount.mounted;

  const failedDisposer = startWorkbenchMountSession({
    container: {} as HTMLElement,
    contributionId: 'dev.example.mount.dispose-failure',
    implementation: { mount: () => () => { throw new Error('dispose failed'); } },
    onError: (error, phase) => failures.push({ message: String(error), phase }),
    owner: owner(),
    props: {},
  });
  await failedDisposer.mounted;
  await failedDisposer.dispose();

  expect(failures).toEqual([
    { message: 'Error: mount failed', phase: 'mount' },
    { message: 'Error: dispose failed', phase: 'dispose' },
  ]);
});

test('render boundaries reset for a different contribution or owner generation', () => {
  const contribution = (id: string, generation: number): SurfaceContribution => ({
    descriptor: {
      contractVersion: 1,
      data: {},
      id,
      kind: 'panel',
      supports: ['web'],
    },
    implementation: {},
    owner: owner(generation),
  });
  expect(workbenchContributionInstanceKey(contribution('dev.example.mount.first', 1)))
    .not.toBe(workbenchContributionInstanceKey(contribution('dev.example.mount.second', 1)));
  expect(workbenchContributionInstanceKey(contribution('dev.example.mount.first', 1)))
    .not.toBe(workbenchContributionInstanceKey(contribution('dev.example.mount.first', 2)));
});

test('the rendered-visibility seam triggers only declarative contribution owners', async () => {
  const contribution = (id: string, implementation: unknown): SurfaceContribution => ({
    descriptor: {
      contractVersion: 1,
      data: {},
      entrypoint: 'dev.example.mount.manifest',
      id,
      kind: 'panel',
      placement: { slot: 'test.slot' },
      supports: ['web'],
    },
    implementation,
    owner: owner(),
  });
  const triggered: string[] = [];
  await triggerVisibleSurfaceContributions([
    contribution('dev.example.mount.lazy', { kind: 'declarative' }),
    contribution('dev.example.mount.active', { render: () => null }),
  ], {
    trigger: async (visible) => { triggered.push(visible.descriptor.id); },
  });
  expect(triggered).toEqual(['dev.example.mount.lazy']);
});
