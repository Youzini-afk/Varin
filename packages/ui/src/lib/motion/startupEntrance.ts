import { documentMotionLevel } from './preference';
import { springSettleMs } from './tokens';

/**
 * Startup entrance (docs/design/motion-and-interaction.md §3.13).
 *
 * After a warm start's short splash exit the interface assembles itself: the sidebar, the title bar,
 * the home title, the composer and the rail arrive 40ms apart, and the starter suggestions follow one
 * by one. Parts opt in with `data-startup-part`; styles/motion.css plays them while the root carries
 * `data-startup-entrance`, counting from `--startup-entrance-delay`. Anything that mounts inside that
 * window (starters arrive asynchronously) still arrives in its place; anything later is untouched.
 *
 * At most once per page, and only at full motion: a remounted Shell (a Profile switch, a session
 * switch) never replays it.
 */

export type StartupPart = 'sidebar' | 'header' | 'hero' | 'composer' | 'rail';

export const STARTUP_PART_ORDER: readonly StartupPart[] = ['sidebar', 'header', 'hero', 'composer', 'rail'];
export const STARTUP_STAGE_MS = 40;
/** Starters follow the last part, this far apart; the sixth and later together. */
export const STARTUP_STARTER_STAGGER_MS = 20;
const STARTUP_STARTERS = 6;

export const STARTUP_ENTRANCE_ATTRIBUTE = 'data-startup-entrance';
const DELAY_PROPERTY = '--startup-entrance-delay';

interface EntranceRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly dataset?: DOMStringMap;
  readonly style?: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
}

let played = false;

/** When the last part has settled, counted from the start of the entrance. */
export const startupEntranceMs = (delayMs: number): number => (
  delayMs
  + STARTUP_PART_ORDER.length * STARTUP_STAGE_MS
  + (STARTUP_STARTERS - 1) * STARTUP_STARTER_STAGGER_MS
  + springSettleMs('glide')
);

/**
 * Play the entrance, starting `delayMs` from now (when the splash starts to uncover the interface).
 * Returns whether it plays.
 */
export function playStartupEntrance(
  root: EntranceRoot | null | undefined,
  delayMs: number,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
): boolean {
  if (played || !root?.style || !root.dataset) return false;
  played = true;
  if (documentMotionLevel(root as HTMLElement) !== 'full') return false;
  root.style.setProperty(DELAY_PROPERTY, `${Math.max(0, Math.round(delayMs))}ms`);
  root.setAttribute(STARTUP_ENTRANCE_ATTRIBUTE, 'playing');
  schedule(() => {
    root.removeAttribute(STARTUP_ENTRANCE_ATTRIBUTE);
    root.style?.removeProperty(DELAY_PROPERTY);
  }, startupEntranceMs(delayMs) + 50);
  return true;
}

/** Test seam. */
export function resetStartupEntranceForTests(): void {
  played = false;
}
