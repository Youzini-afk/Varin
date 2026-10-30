/**
 * Shell-independent state machine for a Workbench Profile transition.
 *
 * A Transition Scene owns pixels and timing. Core owns candidate readiness and the authoritative
 * Profile commit: reverse playback covers the old shell, commit happens only while covered, and
 * forward playback reveals either the new shell or the still-authoritative old shell after failure.
 */

import {
  VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  varinTransitionSceneDuration,
  type VarinTransitionSceneAnimatedPhase,
  type VarinTransitionSceneFrameV1,
} from '@varin/extension-contract';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';

export type WorkbenchProfileTransitionDirection = 'forward' | 'backward';
export type WorkbenchProfileTransitionPhase = 'idle' | 'covering' | 'covered' | 'revealing';
export type WorkbenchProfileTransitionTempo = 'quick' | 'standard';

export interface WorkbenchProfileTransitionState {
  readonly direction: WorkbenchProfileTransitionDirection;
  readonly durationMs: number;
  readonly fromProfileId: string | null;
  readonly id: number;
  readonly phase: WorkbenchProfileTransitionPhase;
  readonly reducedMotion: boolean;
  /**
   * The revealing timeline has finished and the scene still owns every visible pixel of its terminal
   * frame. Core stays in `revealing` until the host reports the scene detached.
   *
   * This is a Core/host signal and deliberately absent from the public Transition Scene frame: a scene
   * sees `covering`, `covered`, `revealing` and nothing else. The alternative — publishing `idle` and then
   * keeping a stale revealing scene mounted so it can be torn down afterwards — is what made the last
   * frame of the transition depend on scheduler ordering, because the teardown then ran against a scene
   * that was still connected and still being composited.
   */
  readonly retiring: boolean;
  readonly scene: WorkbenchTransitionSceneCapture | null;
  readonly tempo: WorkbenchProfileTransitionTempo;
  readonly toProfileId: string | null;
}

export interface WorkbenchTransitionSceneController {
  complete(transitionId: number, phase: VarinTransitionSceneAnimatedPhase): void;
  getSnapshot(): VarinTransitionSceneFrameV1;
  subscribe(listener: () => void): () => void;
}

/**
 * A candidate prepared before the cover closed still counts as quick if its authoritative commit
 * settles within this already-established visible grace. It is not an operation timeout: slower
 * candidates stay safely covered and use the scene's standard reveal duration.
 */
export const QUICK_TRANSITION_COMMIT_GRACE_MS = 340;

const IDLE: WorkbenchProfileTransitionState = {
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
};

type Listener = (state: WorkbenchProfileTransitionState) => void;
type CoveredWaiter = (covered: boolean) => void;
type TargetPaintWaiter = (painted: boolean) => void;

const listeners = new Set<Listener>();
const coveredWaiters = new Set<CoveredWaiter>();
const idleWaiters = new Set<() => void>();
const targetPaintWaiters = new Set<TargetPaintWaiter>();
const sceneHosts = new Set<symbol>();
let state: WorkbenchProfileTransitionState = IDLE;
let nextTransitionId = 1;
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
let phaseArmed = false;
let operationPreparedBeforeCover = false;
let coveredAt = 0;
let targetPainted = false;

const clearPhaseTimer = (): void => {
  if (phaseTimer === null) return;
  clearTimeout(phaseTimer);
  phaseTimer = null;
};

const publish = (next: WorkbenchProfileTransitionState): void => {
  state = next;
  listeners.forEach((listener) => listener(state));
};

const resolveCoveredWaiters = (covered: boolean): void => {
  for (const resolve of coveredWaiters) resolve(covered);
  coveredWaiters.clear();
};

const resolveIdleWaiters = (): void => {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
};

const resolveTargetPaintWaiters = (painted: boolean): void => {
  for (const resolve of targetPaintWaiters) resolve(painted);
  targetPaintWaiters.clear();
};

const armPhaseCompletion = (durationMs: number, advance: () => void): void => {
  clearPhaseTimer();
  phaseTimer = setTimeout(advance, durationMs);
};

/** The single place the transaction ends, so every route to idle resets the same bookkeeping. */
const settleIdle = (): void => {
  publish(IDLE);
  operationPreparedBeforeCover = false;
  coveredAt = 0;
  targetPainted = false;
  resolveTargetPaintWaiters(false);
  resolveIdleWaiters();
};

const phaseDuration = (
  scene: WorkbenchTransitionSceneCapture | null,
  phase: VarinTransitionSceneAnimatedPhase,
  tempo: WorkbenchProfileTransitionTempo,
  reducedMotion: boolean,
): number => scene
  ? varinTransitionSceneDuration(scene.data, {
      phase,
      reducedMotion,
      scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
      tempo,
    })
  : 0;

/** Unknown profile ordering falls forward instead of pretending to know extension-defined layout. */
export const resolveTransitionDirection = (
  profileIds: readonly string[],
  fromProfileId: string | null,
  toProfileId: string,
): WorkbenchProfileTransitionDirection => {
  if (!fromProfileId) return 'forward';
  const from = profileIds.indexOf(fromProfileId);
  const to = profileIds.indexOf(toProfileId);
  if (from < 0 || to < 0) return 'forward';
  return to >= from ? 'forward' : 'backward';
};

export const beginWorkbenchProfileTransition = (input: {
  direction?: WorkbenchProfileTransitionDirection;
  fromProfileId?: string | null;
  reducedMotion?: boolean;
  scene?: WorkbenchTransitionSceneCapture | null;
  toProfileId: string;
}): number => {
  clearPhaseTimer();
  // A newer user choice supersedes promises owned by a transition that can no longer become authoritative.
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  resolveTargetPaintWaiters(false);
  operationPreparedBeforeCover = false;
  phaseArmed = false;
  coveredAt = 0;
  targetPainted = false;
  const id = nextTransitionId;
  nextTransitionId += 1;
  const scene = input.scene ?? null;
  const reducedMotion = input.reducedMotion ?? false;
  const durationMs = phaseDuration(scene, 'covering', 'quick', reducedMotion);
  publish({
    direction: input.direction ?? 'forward',
    durationMs,
    fromProfileId: input.fromProfileId ?? null,
    id,
    phase: 'covering',
    reducedMotion,
    retiring: false,
    scene,
    tempo: 'quick',
    toProfileId: input.toProfileId,
  });
  return id;
};

/**
 * Starts the selected scene's declared-duration clock only after its mounted pixels have committed.
 * This prevents an async mount or a busy main thread from consuming the cover budget before a scene
 * was visible. Repeated readiness signals for the same phase are no-ops.
 */
export const armWorkbenchProfileTransitionPhase = (
  id: number,
  phase: VarinTransitionSceneAnimatedPhase,
): void => {
  // A retiring transaction is still reported as `revealing`, and its clock has already run. Re-arming it
  // would start a second timeline over the terminal frame the scene is being retired against.
  if (state.id !== id || state.phase !== phase || phaseArmed || state.retiring) return;
  phaseArmed = true;
  armPhaseCompletion(state.durationMs, () => {
    if (phase === 'covering') markWorkbenchProfileTransitionCovered(id);
    else completeWorkbenchProfileTransition(id);
  });
};

/** Records that candidate preparation reached the authoritative commit boundary. */
export const markWorkbenchProfileTransitionOperationPrepared = (id: number): void => {
  if (state.id === id && state.phase === 'covering') operationPreparedBeforeCover = true;
};

/** Called by the scene (or its declared-duration clock) after the cover is fully opaque. */
export const markWorkbenchProfileTransitionCovered = (id: number): void => {
  if (state.id !== id || state.phase !== 'covering' || !phaseArmed) return;
  clearPhaseTimer();
  phaseArmed = false;
  coveredAt = Date.now();
  publish({
    ...state,
    durationMs: 0,
    phase: 'covered',
    tempo: operationPreparedBeforeCover ? 'quick' : 'standard',
  });
  resolveCoveredWaiters(true);
};

export const waitForWorkbenchProfileTransitionCovered = (id: number): Promise<boolean> => {
  if (state.id !== id) return Promise.resolve(false);
  if (state.phase === 'covered' || state.phase === 'revealing') return Promise.resolve(true);
  if (state.phase === 'idle') return Promise.resolve(false);
  return new Promise((resolve) => {
    coveredWaiters.add(resolve);
  });
};

/**
 * The profile document being committed does not mean its Shell has reached the compositor. The live
 * Shell host reports this only after the selected contribution committed and crossed a paint boundary;
 * reveal must remain fully covered until then.
 */
export const markWorkbenchProfileTransitionTargetPainted = (
  id: number,
  profileId: string,
): void => {
  if (
    state.id !== id
    || state.phase !== 'covered'
    || state.toProfileId !== profileId
    || targetPainted
  ) return;
  targetPainted = true;
  resolveTargetPaintWaiters(true);
};

export const waitForWorkbenchProfileTransitionTargetPainted = (id: number): Promise<boolean> => {
  if (state.id !== id || state.phase === 'idle' || state.phase === 'revealing') return Promise.resolve(false);
  if (targetPainted) return Promise.resolve(true);
  return new Promise((resolve) => {
    targetPaintWaiters.add(resolve);
  });
};

const waitForWorkbenchProfileTransitionIdle = (): Promise<void> => {
  if (state.phase === 'idle') return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.add(resolve);
  });
};

/** Starts forward playback after commit or failure and waits for the selected scene to finish. */
export const revealWorkbenchProfileTransition = async (id: number): Promise<void> => {
  if (state.id !== id || state.phase === 'idle') return;
  if (state.phase === 'covering') {
    const covered = await waitForWorkbenchProfileTransitionCovered(id);
    if (!covered) return;
  }
  if (state.id !== id) return;
  if (state.phase === 'revealing') return waitForWorkbenchProfileTransitionIdle();
  if (state.phase !== 'covered') return;

  const quick = operationPreparedBeforeCover
    && coveredAt > 0
    && Date.now() - coveredAt <= QUICK_TRANSITION_COMMIT_GRACE_MS;
  const tempo = quick ? 'quick' : 'standard';
  const durationMs = phaseDuration(state.scene, 'revealing', tempo, state.reducedMotion);
  phaseArmed = false;
  publish({ ...state, durationMs, phase: 'revealing', tempo });
  return waitForWorkbenchProfileTransitionIdle();
};

/**
 * Registered for as long as something is actually mounting Transition Scenes.
 *
 * It decides who ends the transaction, and it removes the need for any timed fallback. With a host
 * registered, a finished reveal leaves pixels on screen that only that host can take away, so Core waits
 * for it. With no host — a headless caller, a test, a surface that never mounted the overlay — there is no
 * scene DOM to retire, so a finished reveal is simply the end. Actual host removal also releases
 * unfinished phases: a later mount must not replay an abandoned transaction.
 */
export const registerWorkbenchProfileTransitionSceneHost = (): (() => void) => {
  const token = Symbol('varin.workbench.transition.host');
  sceneHosts.add(token);
  return () => {
    sceneHosts.delete(token);
    if (sceneHosts.size !== 0 || state.phase === 'idle') return;
    const id = state.id;
    // React may unregister/re-register layout effects in the same commit. Only cancel when the
    // host really left, and never let a stale cleanup settle a newly started transition.
    queueMicrotask(() => {
      if (sceneHosts.size !== 0 || state.id !== id || state.phase === 'idle') return;
      clearPhaseTimer();
      phaseArmed = false;
      resolveCoveredWaiters(false);
      settleIdle();
    });
  };
};

/**
 * Called by the scene (or its declared-duration clock) after the authoritative shell is exposed.
 *
 * With a host mounted this ends the animation, not the transaction. The scene's terminal frame is still the
 * only thing on screen, so Core holds `revealing` and marks itself retiring; the host makes its Core-owned
 * wrapper compositor-transparent, detaches the scene in one move, and calls
 * `finalizeWorkbenchProfileTransition` once it is gone.
 */
export const completeWorkbenchProfileTransition = (id: number): void => {
  if (state.id !== id || state.phase !== 'revealing' || !phaseArmed || state.retiring) return;
  clearPhaseTimer();
  phaseArmed = false;
  if (sceneHosts.size === 0) {
    settleIdle();
    return;
  }
  publish({ ...state, durationMs: 0, retiring: true });
};

/**
 * Called by the host once the Transition Scene's DOM has left the document.
 *
 * Only now is there nothing left to composite that belongs to this transaction, so only now can the
 * transaction be idle. Callers awaiting the reveal resolve here, which is what keeps a profile commit from
 * reporting success while the outgoing scene is still on screen.
 */
export const finalizeWorkbenchProfileTransition = (id: number): void => {
  // Retiring only. A detachment report that arrives for a superseded transaction, or while one is still
  // covering, must not end it — that is how a stale retirement would tear down a live scene.
  if (state.id !== id || !state.retiring) return;
  clearPhaseTimer();
  phaseArmed = false;
  settleIdle();
};

export const subscribeWorkbenchProfileTransition = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
};

export const getWorkbenchProfileTransitionSnapshot = (): WorkbenchProfileTransitionState => state;

const frameFrom = (current: WorkbenchProfileTransitionState): VarinTransitionSceneFrameV1 => {
  if (current.phase === 'idle' || !current.toProfileId) {
    throw new Error('Cannot create a Transition Scene frame for an idle transition');
  }
  return {
    contractVersion: VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
    direction: current.direction,
    fromProfileId: current.fromProfileId,
    phase: current.phase,
    reducedMotion: current.reducedMotion,
    scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: current.tempo,
    toProfileId: current.toProfileId,
    transitionId: current.id,
  };
};

/**
 * One stable controller is mounted for the complete transaction. It keeps the last valid frame while
 * React unmounts after idle, and validates both transition ID and phase on completion.
 */
export const createWorkbenchTransitionSceneController = (
  id: number,
): WorkbenchTransitionSceneController => {
  if (state.id !== id || state.phase === 'idle') {
    throw new Error(`Workbench transition ${id} is not active`);
  }
  let observedState = state;
  let frame = frameFrom(state);
  /**
   * Publishes that leave every frame field alone must not produce a new frame object.
   *
   * Entering the retiring step is exactly such a publish: it is Core/host bookkeeping over an unchanged
   * terminal frame. Handing a fresh object to `useSyncExternalStore` there would re-render the scene at the
   * one moment nothing about it may be re-evaluated.
   */
  const adopt = (next: WorkbenchProfileTransitionState): boolean => {
    observedState = next;
    const candidate = frameFrom(next);
    const unchanged = (Object.keys(candidate) as Array<keyof VarinTransitionSceneFrameV1>)
      .every((key) => candidate[key] === frame[key]);
    if (unchanged) return false;
    frame = candidate;
    return true;
  };
  const readFrame = (): VarinTransitionSceneFrameV1 => {
    if (state.id === id && state.phase !== 'idle' && state !== observedState) adopt(state);
    return frame;
  };
  return {
    complete: (transitionId, phase) => {
      if (transitionId !== id) return;
      if (phase === 'covering') markWorkbenchProfileTransitionCovered(id);
      else completeWorkbenchProfileTransition(id);
    },
    getSnapshot: readFrame,
    subscribe: (listener) => {
      // Reading the shared snapshot (including from the overlay) must not consume another
      // subscriber's notification. Each observer tracks the last frame it actually received.
      let delivered = readFrame();
      return subscribeWorkbenchProfileTransition((next) => {
        if (next.id !== id || next.phase === 'idle') return;
        const current = readFrame();
        if (current === delivered) return;
        delivered = current;
        listener();
      });
    },
  };
};

/** Test seam: drop all state and timers so one case cannot leak into the next. */
export const resetWorkbenchProfileTransitionForTests = (): void => {
  clearPhaseTimer();
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  resolveTargetPaintWaiters(false);
  sceneHosts.clear();
  state = IDLE;
  nextTransitionId = 1;
  operationPreparedBeforeCover = false;
  phaseArmed = false;
  coveredAt = 0;
  targetPainted = false;
  listeners.clear();
};
