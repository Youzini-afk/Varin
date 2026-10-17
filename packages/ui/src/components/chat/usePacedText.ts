import React from 'react';

const TEXT_PACE_MS = 64;
const PACE_RATIO = TEXT_PACE_MS / 24;
const TEXT_SNAP = /[\s.,!?;:)\]]/;
const nextRevealIndex = (text: string, start: number): number => {
  const remaining = text.length - start;
  const base = remaining <= 12 ? 2 : remaining <= 48 ? 4 : remaining <= 96 ? 8 : Math.min(24, Math.ceil(remaining / 8));
  const end = Math.min(text.length, start + Math.max(1, Math.round(base * PACE_RATIO)));
  for (let i = end; i < Math.min(text.length, end + 8); i += 1) if (TEXT_SNAP.test(text[i] ?? '')) return i + 1;
  return end;
};

/** Appending tokens updates the target, never the already scheduled reveal. */
export function usePacedText(content: string, streaming: boolean): string {
  const [shown, setShown] = React.useState(() => streaming ? 0 : content.length);
  const shownRef = React.useRef(shown);
  const latest = React.useRef({ content, streaming });
  latest.current = { content, streaming };
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = React.useCallback(function reveal() {
    timer.current = null;
    const current = latest.current;
    if (!current.streaming) return;
    const next = nextRevealIndex(current.content, Math.min(shownRef.current, current.content.length));
    shownRef.current = next;
    setShown(next);
    if (next < current.content.length) timer.current = setTimeout(reveal, TEXT_PACE_MS);
  }, []);

  React.useEffect(() => {
    if (!streaming || typeof window === 'undefined') {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      shownRef.current = content.length;
      setShown(content.length);
      return;
    }
    if (shownRef.current > content.length) { shownRef.current = content.length; setShown(content.length); }
    if (timer.current === null && shownRef.current < content.length) timer.current = setTimeout(tick, TEXT_PACE_MS);
  }, [content, streaming, tick]);
  React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  return streaming ? content.slice(0, Math.min(shown, content.length)) : content;
}
