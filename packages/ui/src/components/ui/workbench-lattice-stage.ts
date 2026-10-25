import { documentMotionLevel, type MotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, EASE_OUT } from '@/lib/motion/tokens';
import {
  LATTICE_CLOSED_SCALE,
  LATTICE_COVER_CELL_MS,
  LATTICE_REDUCED_MS,
  LATTICE_REVEAL_CELL_MS,
  WORKBENCH_SWITCHER_ATTRIBUTE,
  latticeDelayMs,
  latticeOrigin,
  planLattice,
  type LatticePlan,
  type LatticePoint,
} from './workbench-lattice';

/**
 * The lattice's DOM and animations (§3.11), driven by WorkbenchLatticeScene one phase at a time.
 *
 * `full` grows one `<i>` per cell with Web Animations, so the waves run on the compositor even while
 * the Profile commit keeps the main thread busy. `reduced` and `off` use one sheet instead: a 160ms
 * fade, or nothing. The root's `data-state` carries the resting picture (`open`, `closed`, `clear`)
 * so cancelling a finished wave never shows a frame of anything else.
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
    if (this.mode === 'full' && this.cells.length === 0) this.layout(this.origin ?? { x: 0, y: 0 });
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
      if (rect.width > 0 && rect.height > 0) {
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
