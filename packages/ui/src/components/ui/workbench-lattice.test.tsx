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
  LATTICE_MIN_CELL_PX,
  LATTICE_SPREAD_MS,
  latticeDeclaredDurationMs,
  latticeOrigin,
  latticePhaseMs,
  planLattice,
} from './workbench-lattice';
import { WorkbenchLatticeScene } from './WorkbenchLatticeScene';

describe('lattice geometry', () => {
  it('keeps the design cell on an ordinary window and grows it on a large one', () => {
    expect(planLattice(1440, 900, { x: 0, y: 0 }).cellPx).toBe(LATTICE_MIN_CELL_PX);
    const large = planLattice(3440, 1440, { x: 0, y: 0 });
    expect(large.cellPx).toBeGreaterThan(LATTICE_MIN_CELL_PX);
    expect(large.cols * large.rows).toBeLessThanOrEqual(LATTICE_MAX_CELLS);
    // The grid reaches every edge; the last row and column may overhang.
    expect(large.cols * large.cellPx).toBeGreaterThanOrEqual(3440);
    expect(large.rows * large.cellPx).toBeGreaterThanOrEqual(1440);
  });

  it('orders cells by distance from the origin, nearest 0 and farthest 1', () => {
    const plan = planLattice(440, 220, { x: 22, y: 22 });
    expect(plan.cols).toBe(10);
    expect(plan.rows).toBe(5);
    expect(plan.reach[0]).toBe(0);
    expect(plan.reach[plan.reach.length - 1]).toBeCloseTo(1);
    expect(Math.max(...plan.reach)).toBeCloseTo(1);
  });

  it('starts at the switcher, else a recent press, else the top centre', () => {
    const bounds = { left: 0, top: 0, width: 800, height: 600 };
    expect(latticeOrigin(bounds, { left: 100, top: 8, width: 80, height: 28 }, { x: 5, y: 5 })).toEqual({ x: 140, y: 22 });
    expect(latticeOrigin(bounds, null, { x: 300, y: 900 })).toEqual({ x: 300, y: 600 });
    expect(latticeOrigin(bounds, { left: 0, top: 0, width: 0, height: 0 }, null)).toEqual({ x: 400, y: 0 });
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
          expect(declared).toBe(latticeDeclaredDurationMs(phase, reducedMotion));
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
  const cells = () => [...container.querySelectorAll('.wb-lattice-field > i')];
  const delayOf = (cell: Element) => animated.filter(entry => entry.element === cell).at(-1)!.options.delay as number;

  it('grows from the switcher, holds closed, and opens outward from it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering'), complete)));
    expect(lattice().dataset.state).toBe('open');
    expect(cells()).toHaveLength(50);
    expect(animated).toHaveLength(50);
    // The cell under the switcher starts first; the far corner last, the full spread later.
    expect(delayOf(cells()[0]!)).toBeLessThan(LATTICE_SPREAD_MS * 0.1);
    expect(delayOf(cells()[49]!)).toBeCloseTo(LATTICE_SPREAD_MS);
    expect(String(animated[0]!.keyframes[0]!.transform)).toBe('scale(0)');
    expect(complete).not.toHaveBeenCalled();

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
    expect(animated).toHaveLength(50);
    expect(String(animated[0]!.keyframes[1]!.transform)).toBe('scale(0)');
    expect(delayOf(cells()[0]!)).toBeLessThan(delayOf(cells()[49]!));
    await finishAll();
    expect(complete).toHaveBeenLastCalledWith('revealing');
  });

  it('closes back toward the switcher when returning to an earlier Profile', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('revealing', { direction: 'backward' }), complete)));
    // Mounted after the cover, so there was no cover wave; the reveal starts from closed.
    expect(animated).toHaveLength(50);
    expect(delayOf(cells()[0]!)).toBeGreaterThan(delayOf(cells()[49]!));
  });

  it('starts closed when it mounts while the cover is held', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covered'), complete)));
    expect(lattice().dataset.state).toBe('closed');
    expect(cells().length).toBeGreaterThan(0);
    expect(animated).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('plays each phase once however often it re-renders', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering'), complete)));
    await act(async () => root.render(scene(frame('covering'), vi.fn())));
    expect(animated).toHaveLength(50);
  });

  it('fades one sheet under reduced motion', async () => {
    const complete = vi.fn();
    await act(async () => root.render(scene(frame('covering', { reducedMotion: true }), complete)));
    expect(lattice().dataset.mode).toBe('reduced');
    expect(animated).toHaveLength(1);
    expect(animated[0]!.element.className).toBe('wb-lattice-sheet');
    expect(animated[0]!.keyframes.map(keyframe => keyframe.opacity)).toEqual([0, 1]);
    expect(animated[0]!.options.duration).toBeLessThanOrEqual(160);
    await finishAll();
    expect(complete).toHaveBeenCalledWith('covering');
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
