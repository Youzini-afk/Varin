/**
 * Which way the user just moved between sessions: 1 toward later rows of the
 * session list (down), -1 toward earlier ones (up), 0 when unknown. Noted where
 * the switch is made (a sidebar click, a keyboard step) before the selection
 * changes, and read by whatever animates the switch: the conversation leaves
 * against the move and the title changes with it.
 */
export type SwitchDirection = -1 | 0 | 1;

/** A switch is animated with its direction for this long after it was noted; history can take a moment. */
const WINDOW_MS = 4000;
let noted: { direction: SwitchDirection; at: number } = { direction: 0, at: Number.NEGATIVE_INFINITY };

export function noteSwitchDirection(direction: number): void {
  noted = { direction: (Math.sign(direction) || 0) as SwitchDirection, at: Date.now() };
}

export function recentSwitchDirection(): SwitchDirection {
  return Date.now() - noted.at <= WINDOW_MS ? noted.direction : 0;
}
