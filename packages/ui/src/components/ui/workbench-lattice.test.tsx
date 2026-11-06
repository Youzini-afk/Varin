import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@varin/extension-builtins';
import {
  VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  parseVarinTransitionSceneContributionData,
  varinTransitionSceneDuration,
  type VarinTransitionSceneFrameV1,
} from '@varin/extension-contract';
import {
  LATTICE_HOLD_NOTICE_MS,
  LATTICE_MAX_CELLS,
  latticePhaseMs,
  planLattice,
} from './workbench-lattice';
import { WorkbenchLatticeScene } from './WorkbenchLatticeScene';

describe('lattice cover contract', () => {
  it.each([[390, 700], [1440, 900], [3440, 1440]])('covers a %i by %i viewport with bounded work', (width, height) => {
    const plan = planLattice(width, height, { x: 0, y: 0 });
    expect(plan.cols * plan.cellPx).toBeGreaterThanOrEqual(width);
    expect(plan.rows * plan.cellPx).toBeGreaterThanOrEqual(height);
    expect(plan.cols * plan.rows).toBeLessThanOrEqual(LATTICE_MAX_CELLS);
  });

  it('the built-in extension declares the lattice timeline plus clock headroom', () => {
    const contribution = VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.contributions?.[0];
    expect(contribution?.kind).toBe('transition-scene');
    const data = parseVarinTransitionSceneContributionData(contribution?.data);
    for (const phase of ['covering', 'revealing'] as const) {
      for (const reducedMotion of [false, true]) {
        for (const tempo of ['quick', 'standard'] as const) {
          const declared = varinTransitionSceneDuration(data, {
            phase,
            reducedMotion,
            scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
            tempo,
          });
          expect(declared).toBeGreaterThan(latticePhaseMs(phase, reducedMotion));
        }
      }
    }
  });
});

describe('WorkbenchLatticeScene', () => {
  let root: Root;
  let container: HTMLElement;
  let doc: Document;
  let animated: Array<{ element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }>;
  let finishAll: () => Promise<void>;

  beforeEach(() => {
    const { window, document } = parseHTML('<html><body></body></html>');
    doc = document;
    vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Element', window.Element); vi.stubGlobal('HTMLElement', window.HTMLElement);
    Object.assign(window, { innerWidth: 440, innerHeight: 220 });
    animated = [];
    const finishers: Array<() => void> = [];
    finishAll = async () => {
      await act(async () => {
        finishers.splice(0).forEach(finish => finish());
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    window.HTMLElement.prototype.animate = function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const record = { element: this, keyframes, options, cancelled: false };
      animated.push(record);
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      finishers.push(finish);
      return { finished, cancel: () => { record.cancelled = true; } } as unknown as Animation;
    } as unknown as typeof HTMLElement.prototype.animate;
    // The switcher sits in the title bar, over the first two cells of the top row.
    const switcher = document.createElement('button');
    switcher.setAttribute('data-varin-workbench-switcher', '');
    switcher.getBoundingClientRect = () => ({ left: 4, top: 8, width: 80, height: 28, right: 84, bottom: 36, x: 4, y: 8, toJSON: () => ({}) });
    document.body.append(switcher);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const frame = (phase: VarinTransitionSceneFrameV1['phase'], overrides: Partial<VarinTransitionSceneFrameV1> = {}): VarinTransitionSceneFrameV1 => ({
    contractVersion: VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
    direction: 'forward',
    fromProfileId: 'agent',
    phase,
    reducedMotion: false,
    scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: 'quick',
    toProfileId: 'ide',
    transitionId: 1,
    ...overrides,
  });
  const scene = (value: VarinTransitionSceneFrameV1, onPhaseComplete: (phase: string) => void) => (
    <WorkbenchLatticeScene frame={value} status="正在切换到 IDE" onPhaseComplete={onPhaseComplete} />
  );
  const lattice = () => container.querySelector<HTMLElement>('.wb-lattice')!;

  it('completes cover before holding and releases its animations after reveal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering'), complete)));
    expect(animated.length).toBeGreaterThan(0);
    expect(complete).not.toHaveBeenCalled();
    const animationCount = animated.length;
    await act(async () => root.render(scene(frame('covering'), complete)));
    expect(animated).toHaveLength(animationCount);

    await finishAll();
    expect(complete).toHaveBeenCalledWith('covering');
    expect(lattice().dataset.state).toBe('closed');
    // Finished waves are dropped so the closed cells stop being compositor layers.
    expect(animated.every(entry => entry.cancelled)).toBe(true);

    await act(async () => root.render(scene(frame('covered'), complete)));
    expect(lattice().dataset.state).toBe('closed');
    expect(lattice().dataset.holding).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(LATTICE_HOLD_NOTICE_MS); });
    expect(lattice().dataset.holding).toBe('true');

    animated.length = 0;
    await act(async () => root.render(scene(frame('revealing'), complete)));
    expect(lattice().dataset.holding).toBeUndefined();
    expect(lattice().dataset.state).toBe('clear');
    expect(animated.length).toBeGreaterThan(0);
    await finishAll();
    expect(complete.mock.calls).toEqual([['covering'], ['revealing']]);
    expect(animated.every(entry => entry.cancelled)).toBe(true);
  });

  it('starts closed when it mounts while the cover is held', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covered'), complete)));
    expect(lattice().dataset.state).toBe('closed');
    expect(animated).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses opacity rather than movement under reduced motion', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering', { reducedMotion: true }), complete)));
    expect(animated.length).toBeGreaterThan(0);
    for (const animation of animated) {
      expect(animation.keyframes.every(keyframe => keyframe.transform === undefined)).toBe(true);
      expect(animation.keyframes.map(keyframe => keyframe.opacity)).toEqual([0, 1]);
    }
    await finishAll();
    expect(complete).toHaveBeenCalledWith('covering');
  });

  it('cannot report completion after its scene is removed', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering'), complete)));
    await act(async () => root.render(null));
    await finishAll();
    expect(complete).not.toHaveBeenCalled();
    expect(animated.every(entry => entry.cancelled)).toBe(true);
  });

  it('covers and uncovers at once when motion is off', async () => {
    doc.documentElement.dataset.motion = 'off';
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering'), complete)));
    expect(lattice().dataset.state).toBe('closed');
    expect(complete).toHaveBeenCalledWith('covering');
    await act(async () => root.render(scene(frame('revealing'), complete)));
    expect(lattice().dataset.state).toBe('clear');
    expect(complete).toHaveBeenLastCalledWith('revealing');
    expect(animated).toHaveLength(0);
  });
});
