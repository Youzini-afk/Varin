/**
 * Motion preference: the user's choice in Appearance, combined with the
 * operating system's reduced-motion setting.
 *
 * - `full`: springs, flights and transitions as designed. The OS reduced-motion
 *   setting still lowers this to `reduced`.
 * - `reduced`: no translation, scaling or clipping; short opacity and colour
 *   changes remain. Reading pauses such as a retracting preview keep their time.
 * - `off`: state changes apply immediately.
 */
export type MotionPreference = 'full' | 'reduced' | 'off';
export type MotionLevel = MotionPreference;

export const MOTION_PREFERENCES: readonly MotionPreference[] = ['full', 'reduced', 'off'];

export const isMotionPreference = (value: unknown): value is MotionPreference =>
  value === 'full' || value === 'reduced' || value === 'off';

export const resolveMotionLevel = (preference: MotionPreference, systemReduced: boolean): MotionLevel =>
  preference === 'full' && systemReduced ? 'reduced' : preference;

/** The attribute CSS reads: `:root[data-motion="reduced"]` and `:root[data-motion="off"]`. */
export function applyMotionLevel(level: MotionLevel, root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement): void {
  if (!root) return;
  if (root.dataset.motion !== level) root.dataset.motion = level;
}
