import React from 'react';

/**
 * The in-place tray of a collapsed conversation-first process row.
 *
 * Conversation-first folds the ordinary work between two spoken messages into
 * one row, which would hide a file change while it is being written. The tray
 * shows those changes under the row while they work, in batches:
 *
 * - a batch starts with the first change that begins;
 * - a change that begins while the batch is still shown joins it, below;
 * - the batch retracts as a whole once every change in it has finished and
 *   700ms of reading time has passed without a new one, so concurrent writes
 *   never retract one by one;
 * - while the reader points into the tray, has a card expanded, or has paused
 *   a card's following, it stays; leaving restarts the 700ms;
 * - when the segment ends (the next spoken message, for example), a finished
 *   batch retracts at once.
 *
 * The linger is reading time, not animation, so it holds at every motion level.
 */
export const FILE_CHANGE_TRAY_LINGER_MS = 700;

/** Inside the tray a tool renders only its file change cards. */
export const FileChangeTrayContext = React.createContext(false);

export interface FileChangeTray {
  /** The batch currently shown, in the order its changes began; `null` when retracted. */
  batch: { id: number; ids: readonly string[] } | null;
  ref: React.RefObject<HTMLDivElement | null>;
  onPointerEnter(): void;
  onPointerLeave(): void;
}

/** Cards a reader is engaged with: expanded, or following paused. */
const ENGAGED = '[data-preview-expanded], [data-preview-paused]';

export function useFileChangeTray(active: readonly string[], segmentEnded: boolean): FileChangeTray {
  const [batch, setBatch] = React.useState<FileChangeTray['batch']>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const counter = React.useRef(0);
  const pointer = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeKey = active.join('\n');

  React.useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split('\n');
    setBatch(current => {
      if (!current) return { id: ++counter.current, ids };
      const joining = ids.filter(id => !current.ids.includes(id));
      return joining.length ? { ...current, ids: [...current.ids, ...joining] } : current;
    });
  }, [activeKey]);

  const working = Boolean(batch?.ids.some(id => active.includes(id)));
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const schedule = React.useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(function retract() {
      // The reader is looking: keep the batch and look again a beat later.
      if (pointer.current || ref.current?.querySelector(ENGAGED)) {
        timer.current = setTimeout(retract, FILE_CHANGE_TRAY_LINGER_MS);
        return;
      }
      timer.current = null;
      setBatch(null);
    }, delay);
  }, []);

  React.useEffect(() => {
    if (!batch || working) { clear(); return undefined; }
    schedule(segmentEnded ? 0 : FILE_CHANGE_TRAY_LINGER_MS);
    return clear;
  }, [batch, working, segmentEnded, schedule]);
  React.useEffect(() => clear, []);

  return {
    batch,
    ref,
    onPointerEnter: () => { pointer.current = true; },
    onPointerLeave: () => {
      pointer.current = false;
      if (batch && !working) schedule(FILE_CHANGE_TRAY_LINGER_MS);
    },
  };
}
