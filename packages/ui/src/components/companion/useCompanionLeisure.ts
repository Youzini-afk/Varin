import { useCallback, useEffect, useRef, useState } from 'react';

export const COMPANION_QUIET_AFTER_MS = 60_000;
export const COMPANION_SLEEP_AFTER_MS = 5 * 60_000;
export const COMPANION_QUIET_ACTIONS = ['quiet-hair-smooth', 'quiet-stretch', 'quiet-sleeve-smooth', 'quiet-seat-adjust'] as const;
const LEGACY_QUIET_ACTIONS = ['quiet-hair-smooth'];

/** One local idle timeline; one available phrase per epoch, never a performance queue. */
export function useCompanionLeisure(eligible: boolean, activityRevision: number, quietAvailable = false, quietActions: readonly string[] = LEGACY_QUIET_ACTIONS) {
  const [due, setDue] = useState<{ quiet: boolean; sleep: boolean; action: string | null }>({ quiet: false, sleep: false, action: null });
  const lastQuiet = useRef<string | null>(null);
  const availableKey = JSON.stringify(quietActions);
  const finishQuiet = useCallback(() => setDue(current => current.quiet ? { ...current, quiet: false, action: null } : current), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const actions: string[] = JSON.parse(availableKey);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const restart = () => {
      clearTimeout(timer); setDue({ quiet: false, sleep: false, action: null });
      if (!eligible || document.hidden) return;
      if (quietAvailable && actions.length && !reduced?.matches) {
        timer = setTimeout(() => {
          const previous = lastQuiet.current === null ? -1 : actions.indexOf(lastQuiet.current);
          const action = actions[(previous + 1) % actions.length];
          lastQuiet.current = action;
          setDue({ quiet: true, sleep: false, action });
          timer = setTimeout(() => setDue({ quiet: false, sleep: true, action: null }), COMPANION_SLEEP_AFTER_MS - COMPANION_QUIET_AFTER_MS);
        }, COMPANION_QUIET_AFTER_MS);
      } else timer = setTimeout(() => setDue({ quiet: false, sleep: true, action: null }), COMPANION_SLEEP_AFTER_MS);
    };
    restart(); document.addEventListener('visibilitychange', restart); reduced?.addEventListener('change', restart);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', restart); reduced?.removeEventListener('change', restart); };
  }, [eligible, activityRevision, quietAvailable, availableKey]);
  return { quietDue: eligible && due.quiet, quietAction: eligible && due.quiet ? due.action : null, restDue: eligible && due.sleep, finishQuiet };
}
