import { useCallback, useEffect, useState } from 'react';

export const COMPANION_QUIET_AFTER_MS = 60_000;
export const COMPANION_SLEEP_AFTER_MS = 5 * 60_000;

/** One local idle timeline; no OS monitor, periodic performance queue or Host command. */
export function useCompanionLeisure(eligible: boolean, activityRevision: number, quietAvailable = false) {
  const [due, setDue] = useState({ quiet: false, sleep: false });
  const finishQuiet = useCallback(() => setDue(current => current.quiet ? { ...current, quiet: false } : current), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const restart = () => {
      clearTimeout(timer); setDue({ quiet: false, sleep: false });
      if (!eligible || document.hidden) return;
      if (quietAvailable && !reduced?.matches) {
        timer = setTimeout(() => {
          setDue({ quiet: true, sleep: false });
          timer = setTimeout(() => setDue({ quiet: false, sleep: true }), COMPANION_SLEEP_AFTER_MS - COMPANION_QUIET_AFTER_MS);
        }, COMPANION_QUIET_AFTER_MS);
      } else timer = setTimeout(() => setDue({ quiet: false, sleep: true }), COMPANION_SLEEP_AFTER_MS);
    };
    restart(); document.addEventListener('visibilitychange', restart); reduced?.addEventListener('change', restart);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', restart); reduced?.removeEventListener('change', restart); };
  }, [eligible, activityRevision, quietAvailable]);
  return { quietDue: eligible && due.quiet, restDue: eligible && due.sleep, finishQuiet };
}
