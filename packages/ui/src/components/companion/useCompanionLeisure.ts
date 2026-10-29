import { useEffect, useState } from 'react';

/** Local idle eligibility only; no OS idle monitor and no Host state/command. */
export function useCompanionLeisure(eligible: boolean, activityRevision: number) {
  const [restDue, setRestDue] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer); setRestDue(false);
      if (eligible && !document.hidden) timer = setTimeout(() => setRestDue(true), 5 * 60_000);
    };
    restart(); document.addEventListener('visibilitychange', restart);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', restart); };
  }, [eligible, activityRevision]);
  return eligible && restDue;
}
