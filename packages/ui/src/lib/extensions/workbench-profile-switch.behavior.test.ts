import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  defaultVarinWorkbenchProfileDocument, VARIN_WORKBENCH_BOT_PROFILE_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID, VARIN_WORKBENCH_IDE_PROFILE_ID,
  type VarinExtensionHostStateSnapshot, type VarinWorkbenchProfileSelectionRequest,
} from '@varin/extension-contract';
import type { WorkbenchTransitionScenePreparation } from './workbench-transition-scene';
import {
  armWorkbenchProfileTransitionPhase, getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionTargetPainted, resetWorkbenchProfileTransitionForTests,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';
import { selectActiveWorkbenchProfile } from './workbench-shell-transition';

const state = vi.hoisted(() => ({
  snapshot: null as unknown as VarinExtensionHostStateSnapshot,
  runtimeGeneration: 1,
  watchGeneration: 1,
  prepare: vi.fn<() => Promise<WorkbenchTransitionScenePreparation>>(),
  select: vi.fn<(request: VarinWorkbenchProfileSelectionRequest) => Promise<void>>(),
  restore: vi.fn(),
}));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => state.runtimeGeneration }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ prefersReducedMotion: () => false }));
vi.mock('./catalog-store', () => ({
  getVarinExtensionCatalogState: () => ({ snapshot: state.snapshot }),
  getVarinExtensionCatalogWatchGeneration: () => state.watchGeneration,
  refreshVarinExtensionCatalog: async () => {}, setVarinExtensionEnabled: async () => {},
}));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ extensions: { selectWorkbenchProfile: state.select } }) }));
vi.mock('./surface-runtime', () => ({ varinSurfaceRuntime: {
  surface: 'web', getSnapshot: () => ({ actual: [], contributions: [], visibleContributions: [] }),
} }));
vi.mock('./workbench-transition-scene', () => ({ prepareWorkbenchTransitionScene: () => state.prepare() }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: { getState: () => ({ hostKey: 'host', loadCatalog: async () => {} }) } }));
vi.mock('@/lib/workbench/bot-session-location', () => ({ rememberOrdinarySession: () => {}, restoreOrdinarySession: state.restore }));

const prepared = (): WorkbenchTransitionScenePreparation => ({ status: 'missing', scene: null });
let stopScene: () => void;
let started: string[];
beforeEach(() => {
  vi.useFakeTimers();
  resetWorkbenchProfileTransitionForTests();
  vi.clearAllMocks();
  state.runtimeGeneration = 1; state.watchGeneration = 1;
  const document = defaultVarinWorkbenchProfileDocument();
  document.activeProfileId = VARIN_WORKBENCH_BOT_PROFILE_ID;
  // Builtin/no-replacement profiles exercise the actual coordinator and commit gate.
  // Candidate mount/promotion is covered by the separate Shell staging behavior suite.
  document.layouts = [];
  state.snapshot = {
    catalog: { hostId: 'host', extensions: [] }, workbench: { authoritative: true, document },
  } as unknown as VarinExtensionHostStateSnapshot;
  state.prepare.mockResolvedValue(prepared());
  state.select.mockImplementation(async (request) => {
    document.profileSelections.users.default = request.profileId;
    document.revision += 1;
    // Stand in for the selected Shell's completed paint, not for its persisted selection alone.
    markWorkbenchProfileTransitionTargetPainted(getWorkbenchProfileTransitionSnapshot().id, request.profileId);
  });
  started = [];
  stopScene = subscribeWorkbenchProfileTransition((current) => {
    if (current.phase === 'covering') started.push(current.toProfileId!);
    if (current.phase === 'covering' || current.phase === 'revealing') {
      armWorkbenchProfileTransitionPhase(current.id, current.phase);
    }
  });
});
afterEach(() => { stopScene(); resetWorkbenchProfileTransitionForTests(); vi.useRealTimers(); });

test('a late scene preparation cannot replace a newer Bot-to-workbench choice', async () => {
  let finishOld!: (value: WorkbenchTransitionScenePreparation) => void;
  state.prepare.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const older = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  const superseded = expect(older).rejects.toMatchObject({ reason: 'superseded' });
  const newer = selectActiveWorkbenchProfile(VARIN_WORKBENCH_IDE_PROFILE_ID);
  await vi.runAllTimersAsync();
  await newer;
  await superseded;
  expect(state.select.mock.calls.map(([request]) => request.profileId)).toEqual([VARIN_WORKBENCH_IDE_PROFILE_ID]);
  finishOld(prepared());
  await vi.runAllTimersAsync();
  expect(started).toEqual([VARIN_WORKBENCH_IDE_PROFILE_ID]);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});

test('a newer selection cancels the covered candidate before it can commit', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const older = expect(selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, {
    beforeCommit: () => gate,
  })).rejects.toMatchObject({ reason: 'superseded' });
  await vi.runAllTimersAsync();
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  const newer = selectActiveWorkbenchProfile(VARIN_WORKBENCH_IDE_PROFILE_ID);
  release();
  await vi.runAllTimersAsync();
  await Promise.all([older, newer]);
  expect(state.select.mock.calls.map(([request]) => request.profileId)).toEqual([VARIN_WORKBENCH_IDE_PROFILE_ID]);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});

test('a rejected Bot-to-workbench commit reveals the still-authoritative Bot and releases the cover', async () => {
  state.select.mockRejectedValueOnce(new Error('selection conflict'));
  const result = expect(selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID)).rejects.toThrow('selection conflict');
  await vi.runAllTimersAsync();
  await result;
  expect(state.snapshot.workbench.document.activeProfileId).toBe(VARIN_WORKBENCH_BOT_PROFILE_ID);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  expect(state.restore).not.toHaveBeenCalled();
});

test('catalog watch restart on the same Host keeps the switch valid', async () => {
  const result = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, {
    beforeCommit: async () => { state.watchGeneration += 1; },
  });
  await vi.runAllTimersAsync();
  await result;
  expect(state.select).toHaveBeenCalledOnce();
  expect(state.restore).toHaveBeenCalledOnce();
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});

test('repeated requests for the same pending choice share its preparation and scene', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const beforeCommit = () => gate;
  const first = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, { beforeCommit });
  // Observe both outcomes before submitting again, including the old cancellation behavior.
  const firstResult = first.then(() => 'selected', () => 'cancelled');
  await vi.runAllTimersAsync();
  const second = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, { beforeCommit });
  const secondResult = second.then(() => 'selected', () => 'cancelled');
  release();
  await vi.runAllTimersAsync();
  expect(await Promise.all([firstResult, secondResult])).toEqual(['selected', 'selected']);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.select).toHaveBeenCalledOnce();
  expect(state.restore).toHaveBeenCalledOnce();
  expect(started).toEqual([VARIN_WORKBENCH_DEFAULT_PROFILE_ID]);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});

test('a conversation restore failure still reveals the committed workbench', async () => {
  state.restore.mockImplementationOnce(() => { throw new Error('conversation restore failed'); });
  const result = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID)
    .then(() => null, (error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ message: 'conversation restore failed' });
  expect(state.snapshot.workbench.document.profileSelections.users.default).toBe(VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});

test('different conversation navigation to the same profile still supersedes the old intent', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstNavigation = vi.fn();
  const nextNavigation = vi.fn();
  const first = expect(selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, {
    beforeCommit: () => gate, selectOnLeavingBot: firstNavigation,
  })).rejects.toMatchObject({ reason: 'superseded' });
  await vi.runAllTimersAsync();
  const next = selectActiveWorkbenchProfile(VARIN_WORKBENCH_DEFAULT_PROFILE_ID, undefined, {
    selectOnLeavingBot: nextNavigation,
  });
  release();
  await vi.runAllTimersAsync();
  await Promise.all([first, next]);
  expect(firstNavigation).not.toHaveBeenCalled();
  expect(nextNavigation).toHaveBeenCalledOnce();
  expect(state.select).toHaveBeenCalledOnce();
  expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
});
