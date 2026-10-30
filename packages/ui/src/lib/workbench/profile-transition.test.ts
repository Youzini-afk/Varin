import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  type VarinTransitionSceneContributionDataV1,
} from '@varin/extension-contract';
import {
  QUICK_TRANSITION_COMMIT_GRACE_MS,
  armWorkbenchProfileTransitionPhase,
  beginWorkbenchProfileTransition,
  completeWorkbenchProfileTransition,
  createWorkbenchTransitionSceneController,
  finalizeWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCovered,
  markWorkbenchProfileTransitionOperationPrepared,
  markWorkbenchProfileTransitionTargetPainted,
  registerWorkbenchProfileTransitionSceneHost,
  resetWorkbenchProfileTransitionForTests,
  resolveTransitionDirection,
  revealWorkbenchProfileTransition,
  subscribeWorkbenchProfileTransition,
  waitForWorkbenchProfileTransitionCovered,
  waitForWorkbenchProfileTransitionTargetPainted,
} from './profile-transition';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';

const sceneData = (input: {
  coverQuick?: number;
  coverReduced?: number;
  coverStandard?: number;
  revealQuick?: number;
  revealReduced?: number;
  revealStandard?: number;
} = {}): VarinTransitionSceneContributionDataV1 => ({
  contract: VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  durations: {
    [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
      covering: {
        quick: input.coverQuick ?? 800,
        reduced: input.coverReduced ?? 0,
        standard: input.coverStandard ?? 1_600,
      },
      revealing: {
        quick: input.revealQuick ?? 700,
        reduced: input.revealReduced ?? 0,
        standard: input.revealStandard ?? 1_400,
      },
    },
  },
  scenes: [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE],
});

const scene = (data = sceneData()): WorkbenchTransitionSceneCapture => ({
  contributionId: 'dev.example.motion.transition',
  data,
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: 'dev.example.motion',
  extensionVersion: '1.0.0',
  generation: 1,
  hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
  realmId: 'motion-test',
});

describe('workbench profile transition state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkbenchProfileTransitionForTests();
  });

  afterEach(() => {
    resetWorkbenchProfileTransitionForTests();
    vi.useRealTimers();
  });

  test('starts idle', () => {
    expect(getWorkbenchProfileTransitionSnapshot()).toEqual({
      direction: 'forward',
      durationMs: 0,
      fromProfileId: null,
      id: 0,
      phase: 'idle',
      reducedMotion: false,
      retiring: false,
      scene: null,
      tempo: 'standard',
      toProfileId: null,
    });
  });

  test('starts quick reverse playback and publishes it to current subscribers', () => {
    const phases: string[] = [];
    subscribeWorkbenchProfileTransition((state) => phases.push(state.phase));
    const selectedScene = scene();
    const id = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      scene: selectedScene,
      toProfileId: 'varin.ide',
    });

    expect(phases).toEqual(['idle', 'covering']);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      fromProfileId: 'default',
      durationMs: 800,
      id,
      phase: 'covering',
      scene: selectedScene,
      tempo: 'quick',
      toProfileId: 'varin.ide',
    });
  });

  test('does not cross the commit boundary until reverse playback is fully covered', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    let resolved: boolean | undefined;
    const covered = waitForWorkbenchProfileTransitionCovered(id).then((value) => {
      resolved = value;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  });

  test('a candidate prepared during covering keeps the quick reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'quick' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('keeps the cover closed until the authoritative target Shell has painted', async () => {
    const id = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      toProfileId: 'varin.ide',
    });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    let settled: boolean | undefined;
    const painted = waitForWorkbenchProfileTransitionTargetPainted(id).then((value) => {
      settled = value;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBeUndefined();
    markWorkbenchProfileTransitionTargetPainted(id, 'default');
    await Promise.resolve();
    expect(settled).toBeUndefined();

    markWorkbenchProfileTransitionTargetPainted(id, 'varin.ide');
    await expect(painted).resolves.toBe(true);
  });

  test('a candidate that reaches the boundary after covering uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    markWorkbenchProfileTransitionOperationPrepared(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('a prepared candidate that remains covered past the quick grace uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    vi.advanceTimersByTime(QUICK_TRANSITION_COMMIT_GRACE_MS + 1);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('declared scene durations advance phases without a renderer completion signal', async () => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    const covered = waitForWorkbenchProfileTransitionCovered(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(800);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');

    const revealed = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(1_400);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a declared duration does not run before the scene mount reports ready', () => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    vi.advanceTimersByTime(8_000);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(799);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    vi.advanceTimersByTime(1);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  });

  test('reduced motion uses the scene declared reduced duration', async () => {
    const id = beginWorkbenchProfileTransition({
      reducedMotion: true,
      scene: scene(sceneData({ coverReduced: 25, revealReduced: 40 })),
      toProfileId: 'varin.ide',
    });
    expect(getWorkbenchProfileTransitionSnapshot().durationMs).toBe(25);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(25);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot().durationMs).toBe(40);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(40);
    await revealed;
  });

  test('Core fallback is explicit and advances asynchronously without inventing a duration', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ durationMs: 0, scene: null });
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(0);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
    const revealed = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(0);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a scene controller publishes frames and rejects stale phase completion', () => {
    const firstId = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      scene: scene(),
      toProfileId: 'varin.ide',
    });
    const controller = createWorkbenchTransitionSceneController(firstId);
    expect(controller.getSnapshot()).toMatchObject({
      contractVersion: 1,
      fromProfileId: 'default',
      phase: 'covering',
      toProfileId: 'varin.ide',
      transitionId: firstId,
    });
    controller.complete(firstId + 1, 'covering');
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    controller.complete(firstId, 'covering');
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(firstId, 'covering');
    controller.complete(firstId, 'covering');
    expect(controller.getSnapshot().phase).toBe('covered');

    const secondId = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'default' });
    controller.complete(firstId, 'revealing');
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ id: secondId, phase: 'covering' });
  });

  test('a newer selection releases a superseded cover waiter', async () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    const first = waitForWorkbenchProfileTransitionCovered(firstId);
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

    await expect(first).resolves.toBe(false);
    expect(getWorkbenchProfileTransitionSnapshot().toProfileId).toBe('default');
  });

  test('reading a scene frame cannot consume its subscribers phase notifications', () => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'default' });
    const controller = createWorkbenchTransitionSceneController(id);
    // The overlay reads the frame before the mounted scene's store listener runs.
    subscribeWorkbenchProfileTransition(() => controller.getSnapshot());
    const first = vi.fn();
    const second = vi.fn();
    controller.subscribe(first);
    controller.subscribe(second);
    first.mockClear(); second.mockClear();

    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    void revealWorkbenchProfileTransition(id);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe('revealing');
  });

  test('a newer selection releases a superseded target-paint waiter', async () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    armWorkbenchProfileTransitionPhase(firstId, 'covering');
    markWorkbenchProfileTransitionCovered(firstId);
    const first = waitForWorkbenchProfileTransitionTargetPainted(firstId);
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

    await expect(first).resolves.toBe(false);
  });

  test('a late animation event cannot advance a newer transition', () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'varin.ide' });
    const secondId = beginWorkbenchProfileTransition({ toProfileId: 'default' });

    markWorkbenchProfileTransitionCovered(firstId);
    completeWorkbenchProfileTransition(firstId);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      id: secondId,
      phase: 'covering',
      toProfileId: 'default',
    });
  });
});

describe('sweep direction', () => {
  const profiles = ['default', 'varin.ide'];

  test('moving later in the profile order sweeps forward', () => {
    expect(resolveTransitionDirection(profiles, 'default', 'varin.ide')).toBe('forward');
  });

  test('moving earlier reverses the sweep', () => {
    expect(resolveTransitionDirection(profiles, 'varin.ide', 'default')).toBe('backward');
  });

  test('an unknown origin or target does not guess', () => {
    expect(resolveTransitionDirection(profiles, null, 'varin.ide')).toBe('forward');
    expect(resolveTransitionDirection(profiles, 'gone', 'varin.ide')).toBe('forward');
    expect(resolveTransitionDirection(profiles, 'default', 'unknown')).toBe('forward');
  });
});

/**
 * Retirement: the step between "the reveal animation stopped" and "the transaction is over".
 *
 * The scene's terminal frame is still the only thing on screen when the reveal ends, so publishing idle
 * there and then keeping the finished scene mounted so it could be torn down afterwards made the last
 * frame of the transition depend on scheduler ordering. The teardown ran against a scene that was still
 * connected and still being composited, which is how the cube came back and how the cover flashed.
 */
describe('scene retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkbenchProfileTransitionForTests();
  });
  afterEach(() => {
    resetWorkbenchProfileTransitionForTests();
    vi.useRealTimers();
  });

  /** Declared cover is quick (800ms); nothing here reaches the commit boundary early, so reveal is standard. */
  const COVER_MS = 800;
  const REVEAL_MS = 1_400;

  const reachRevealEnd = (): number => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(COVER_MS);
    void revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(REVEAL_MS);
    return id;
  };

  test('a finished reveal holds its frame instead of going idle', () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = reachRevealEnd();

    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      id,
      phase: 'revealing',
      retiring: true,
    });
    release();
  });

  test('idle arrives only once the scene reports itself detached', () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = reachRevealEnd();
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('revealing');

    finalizeWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'idle', retiring: false });
    release();
  });

  test('callers awaiting the reveal resolve at detachment, not at the last animation frame', async () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(COVER_MS);

    let settled = false;
    const reveal = revealWorkbenchProfileTransition(id).then(() => {
      settled = true;
    });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(REVEAL_MS);
    await Promise.resolve();
    expect(settled).toBe(false);

    finalizeWorkbenchProfileTransition(id);
    await reveal;
    expect(settled).toBe(true);
    release();
  });

  test('the retiring publish does not hand the scene a new frame', () => {
    // The one moment nothing about the scene may be re-evaluated is the moment it is being retired against
    // its terminal frame. Retirement is Core/host bookkeeping and changes no frame field.
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    const controller = createWorkbenchTransitionSceneController(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(COVER_MS);
    void revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');

    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    const before = controller.getSnapshot();
    expect(before.phase).toBe('revealing');
    // Subscribing publishes the current frame once. What matters is that retirement adds nothing after it.
    const settled = notifications;

    vi.advanceTimersByTime(REVEAL_MS);
    expect(getWorkbenchProfileTransitionSnapshot().retiring).toBe(true);
    expect(notifications).toBe(settled);
    expect(controller.getSnapshot()).toBe(before);
    release();
  });

  test('a scene phase clock cannot restart the reveal it just finished', () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = reachRevealEnd();

    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(5_000);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ id, retiring: true });
    release();
  });

  test('a new transition cancels a retirement the previous one never completed', () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const staleId = reachRevealEnd();

    const freshId = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'default' });
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      id: freshId,
      phase: 'covering',
      retiring: false,
    });

    // The stale host reports its detachment late. It must not end the transaction that replaced it.
    finalizeWorkbenchProfileTransition(staleId);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ id: freshId, phase: 'covering' });
    release();
  });

  test('a host that leaves mid-retirement does not strand the transaction', () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    reachRevealEnd();
    expect(getWorkbenchProfileTransitionSnapshot().retiring).toBe(true);

    release();
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('with no host mounted a finished reveal is simply the end', async () => {
    // Headless callers, tests, and any surface that never mounted the overlay have no scene DOM to retire,
    // so waiting for a detachment report would be waiting for something that cannot happen.
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'varin.ide' });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(COVER_MS);
    const reveal = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(REVEAL_MS);

    await reveal;
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'idle', retiring: false });
  });

  test('reduced motion retires through the same steps on a zero-length timeline', async () => {
    const release = registerWorkbenchProfileTransitionSceneHost();
    const id = beginWorkbenchProfileTransition({
      reducedMotion: true,
      scene: scene(),
      toProfileId: 'varin.ide',
    });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(0);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');

    const reveal = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(0);
    expect(getWorkbenchProfileTransitionSnapshot().retiring).toBe(true);

    finalizeWorkbenchProfileTransition(id);
    await reveal;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
    release();
  });
});
