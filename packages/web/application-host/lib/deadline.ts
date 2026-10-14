const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Timers are wake-up hints. Check the accepted deadline after every wake. */
export function scheduleAtDeadline(deadlineAt: number, onDeadline: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS));
      return;
    }
    onDeadline();
  };
  timer = setTimeout(check, Math.min(Math.max(0, deadlineAt - Date.now()), MAX_TIMER_DELAY_MS));
  return () => clearTimeout(timer);
}
