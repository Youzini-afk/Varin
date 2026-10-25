import { documentMotionLevel, type MotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, EASE_OUT } from '@/lib/motion/tokens';
import { createLatticeCanvas, type LatticeCanvas } from './workbench-lattice-canvas';
import {
  LATTICE_CLOSED_SCALE,
  LATTICE_COVER_CELL_MS,
  LATTICE_REDUCED_MS,
  LATTICE_REVEAL_CELL_MS,
  WORKBENCH_SWITCHER_ATTRIBUTE,
  latticeDelayMs,
  latticeOrigin,
  latticePhaseMs,
  planLattice,
  type LatticePlan,
  type LatticePoint,
} from './workbench-lattice';

/**
 * The lattice's surfaces and playback (§3.11), driven one phase at a time.
 *
 * Full motion batches the same cells in one WebGL surface. DOM Web Animations retain the authored
 * effect when WebGL is unavailable/lost. Reduced and off still use the original sheet. A completed
 * wave retains its exact terminal picture while Core commits or retires the scene.
 */

export type LatticeMode = 'full' | 'reduced' | 'off';
type LatticeState = 'open' | 'closed' | 'clear';

/**
 * The transaction's captured preference decides the declared durations, so a reduced capture never
 * plays the full waves; the live level can only make it quieter.
 */
export const latticeMode = (reducedMotion: boolean, level: MotionLevel = documentMotionLevel()): LatticeMode => {
  if (level === 'off') return 'off';
  return reducedMotion || level === 'reduced' ? 'reduced' : 'full';
};
type Running = Pick<Animation, 'cancel' | 'finished'>;

const cubic = (points: readonly number[]): string => `cubic-bezier(${points.join(', ')})`;
const CLOSED = `scale(${LATTICE_CLOSED_SCALE})`;

export class LatticeStage {
  private canvas: LatticeCanvas | null;
  private cells: HTMLElement[] = [];
  private plan: LatticePlan | null = null;
  private running: Running[] = [];
  private generation = 0;
  private disposed = false;
  /** Where the last wave started, for a reveal that cannot find the new switcher. */
  origin: LatticePoint | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly field: HTMLElement,
    private readonly sheet: HTMLElement,
    readonly mode: LatticeMode,
  ) {
    root.dataset.mode = mode;
    this.canvas = mode === 'full' ? createLatticeCanvas(field, () => {
      // Running waves resume through tick at their current playhead; resting covers must recover too.
      if (this.disposed || this.running.length) return;
      this.canvas?.dispose(); this.canvas = null; this.plan = null;
      this.layout(this.origin ?? { x: 0, y: 0 });
    }) : null;
    this.setState('open');
  }

  /** Close the lattice from `origin`. Resolves true once it is opaque, false if superseded. */
  cover(origin: LatticePoint): Promise<boolean> {
    this.origin = origin;
    if (this.mode === 'off') return this.settleNow('closed');
    if (this.mode === 'reduced') {
      return this.play([this.fade(0, 1)], 'closed');
    }
    this.layout(origin);
    if (this.canvas) return this.playCanvas('covering', false);
    const reach = this.plan?.reach;
    if (!reach || !this.canAnimate()) return this.settleNow('closed');
    const easing = cubic(EASE_OUT);
    return this.play(this.cells.map((cell, index) => cell.animate(
      [{ transform: 'scale(0)', opacity: 0.35 }, { transform: CLOSED, opacity: 1 }],
      { duration: LATTICE_COVER_CELL_MS, delay: latticeDelayMs(reach[index] ?? 1), easing, fill: 'both' },
    )), 'closed');
  }

  /** Show the closed lattice at once: the cover phase is over, or the scene mounted after it. */
  close(): void {
    if (this.disposed) return;
    this.stop();
    if (this.mode === 'full' && !this.plan) this.layout(this.origin ?? { x: 0, y: 0 });
    this.canvas?.draw(0, 'closed');
    this.setState('closed');
  }

  /**
   * Open the lattice from `origin`: outward when moving forward through the Profiles, closing back
   * toward the switcher when returning. Resolves true once nothing of it is visible.
   */
  reveal(origin: LatticePoint, inward: boolean): Promise<boolean> {
    this.stop();
    if (this.mode === 'off') return this.settleNow('clear');
    if (this.mode === 'reduced') return this.play([this.fade(1, 0)], 'clear');
    this.origin = origin;
    this.layout(origin);
    if (this.canvas) return this.playCanvas('revealing', inward);
    const reach = this.plan?.reach;
    if (!reach || !this.canAnimate()) return this.settleNow('clear');
    const easing = cubic(EASE_EXIT);
    // The resting state goes to `clear` in the same task: each cell's backwards fill holds it closed
    // until its own delay is up, so no cell opens early and none reappears after it finishes.
    this.setState('clear');
    return this.play(this.cells.map((cell, index) => cell.animate(
      [{ transform: CLOSED, opacity: 1 }, { transform: 'scale(0)', opacity: 0.2 }],
      { duration: LATTICE_REVEAL_CELL_MS, delay: latticeDelayMs(reach[index] ?? 1, inward), easing, fill: 'both' },
    )), 'clear');
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.canvas?.dispose();
    this.canvas = null;
  }

  /**
   * Where a wave starts in the root: the switcher on screen, else a recent press, else `fallback`
   * (the previous wave's origin) or the top centre.
   */
  measureOrigin(pointer: LatticePoint | null, fallback: LatticePoint | null = null): LatticePoint {
    const bounds = this.root.getBoundingClientRect();
    const doc = this.root.ownerDocument;
    let anchor: DOMRect | null = null;
    for (const node of doc.querySelectorAll(`[${WORKBENCH_SWITCHER_ATTRIBUTE}]`)) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && !node.closest('[data-varin-workbench-shell-staging]')) {
        anchor = rect;
        break;
      }
    }
    if (!anchor && !pointer && fallback) return fallback;
    const view = doc.defaultView;
    return latticeOrigin({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width || view?.innerWidth || 0,
      height: bounds.height || view?.innerHeight || 0,
    }, anchor, pointer);
  }

  private canAnimate(): boolean {
    return this.cells.length > 0 && typeof this.cells[0]?.animate === 'function';
  }

  private fade(from: number, to: number): Running {
    if (typeof this.sheet.animate !== 'function') {
      return { cancel: () => undefined, finished: Promise.resolve() as unknown as Promise<Animation> };
    }
    return this.sheet.animate([{ opacity: from }, { opacity: to }], {
      duration: LATTICE_REDUCED_MS,
      easing: cubic(EASE_OUT),
      fill: 'both',
    });
  }

  /** Lay the grid out over the root, reusing the cells when the window has not changed size. */
  private layout(origin: LatticePoint): void {
    const bounds = this.root.getBoundingClientRect();
    const width = bounds.width || (typeof window === 'undefined' ? 0 : window.innerWidth);
    const height = bounds.height || (typeof window === 'undefined' ? 0 : window.innerHeight);
    const plan = planLattice(width, height, origin);
    const reuse = this.plan
      && this.plan.cellPx === plan.cellPx
      && this.plan.cols === plan.cols
      && this.plan.rows === plan.rows;
    this.plan = plan;
    if (this.canvas) { this.canvas.layout(plan, width, height); return; }
    if (reuse) return;
    this.field.style.gridTemplateColumns = `repeat(${plan.cols}, ${plan.cellPx}px)`;
    this.field.style.gridAutoRows = `${plan.cellPx}px`;
    const doc = this.field.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const cells: HTMLElement[] = [];
    for (let index = 0; index < plan.reach.length; index += 1) {
      const cell = doc.createElement('i');
      cells.push(cell);
      fragment.append(cell);
    }
    this.field.replaceChildren(fragment);
    this.cells = cells;
  }

  private play(animations: Running[], rest: LatticeState): Promise<boolean> {
    this.running = animations;
    const generation = ++this.generation;
    return Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (this.disposed || generation !== this.generation) return false;
        // Resting state first, then drop the fills: the cells stop being compositor layers without
        // ever showing a frame between the two pictures.
        this.setState(rest);
        this.stop();
        return true;
      },
      () => false,
    );
  }

  private playCanvas(phase: 'covering' | 'revealing', inward: boolean): Promise<boolean> {
    this.canvas!.direction(inward);
    const started = performance.now();
    const duration = latticePhaseMs(phase, false);
    let frame = 0;
    let fallback: Animation[] = [];
    let finish!: (value: Animation) => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<Animation>((resolve, fail) => { finish = resolve; reject = fail; });
    const running: Running = { finished, cancel: () => {
      cancelAnimationFrame(frame); fallback.forEach(a => a.cancel()); reject(new Error('Lattice superseded'));
    } };
    const tick = (now: number) => {
      const elapsed = Math.min(duration, Math.max(0, now - started));
      if (!this.canvas?.draw(elapsed, phase)) {
        // A lost graphics context uses the original DOM renderer at the same playhead.
        this.canvas?.dispose(); this.canvas = null; this.plan = null;
        this.layout(this.origin ?? { x: 0, y: 0 });
        fallback = this.cells.map((cell, index) => {
          const animation = cell.animate(phase === 'covering'
            ? [{ transform: 'scale(0)', opacity: .35 }, { transform: CLOSED, opacity: 1 }]
            : [{ transform: CLOSED, opacity: 1 }, { transform: 'scale(0)', opacity: .2 }], {
            duration: phase === 'covering' ? LATTICE_COVER_CELL_MS : LATTICE_REVEAL_CELL_MS,
            delay: latticeDelayMs(this.plan?.reach[index] ?? 1, inward),
            easing: cubic(phase === 'covering' ? EASE_OUT : EASE_EXIT), fill: 'both',
          });
          animation.currentTime = elapsed; return animation;
        });
        void Promise.all(fallback.map(a => a.finished)).then(() => finish({} as Animation), reject);
        return;
      }
      if (elapsed === duration) finish({} as Animation);
      else frame = requestAnimationFrame(tick);
    };
    const result = this.play([running], phase === 'covering' ? 'closed' : 'clear');
    tick(started);
    return result;
  }

  private settleNow(rest: LatticeState): Promise<boolean> {
    this.stop();
    this.setState(rest);
    return Promise.resolve(!this.disposed);
  }

  private stop(): void {
    this.generation += 1;
    const running = this.running;
    this.running = [];
    for (const animation of running) animation.cancel();
  }

  private setState(state: LatticeState): void {
    this.root.dataset.state = state;
  }
}
