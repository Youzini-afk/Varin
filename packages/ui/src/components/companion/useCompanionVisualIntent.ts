import { useEffect, useReducer, useRef } from 'react';
import type { CompanionIntent } from './presentation';
import { CompanionVisualStabilizer } from './attentionPresentation';

/** Identity includes Host generation, branch and Run; this hook does not own those facts. */
export function useCompanionVisualIntent(scope: string, intent: CompanionIntent): CompanionIntent {
  const stabilizer = useRef(new CompanionVisualStabilizer());
  const [tick, wake] = useReducer(value => value + 1, 0);
  const now = performance.now();
  const visual = stabilizer.current.observe(scope, intent, now);
  const remaining = stabilizer.current.remaining(now);
  useEffect(() => {
    if (remaining === null) return;
    const timer = setTimeout(wake, remaining);
    return () => clearTimeout(timer);
  }, [scope, intent.state, remaining, tick]);
  return visual;
}
