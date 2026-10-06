import React from 'react';
import { getRuntimeKey } from '@varin/application-client';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { PiMessageHandoff } from './piMessageHandoff';

export function usePiMessageHandoff(runtimeKey: string, sessionId: string | null, active: boolean) {
  const [handoff] = React.useState(() => new PiMessageHandoff());
  const reduced = usePrefersReducedMotion();
  const view = React.useRef({ active, reduced, runtimeKey });
  view.current = { active, reduced, runtimeKey };
  React.useLayoutEffect(() => {
    handoff.select(runtimeKey, sessionId, active, reduced);
    handoff.observe(sessionId ? usePiSessionStore.getState().records[sessionId] : undefined);
    return usePiSessionStore.subscribe((next, previous) => {
      if (next.runtimeKey !== runtimeKey || next.currentSessionId !== sessionId) {
        handoff.select(next.runtimeKey, next.currentSessionId, false, reduced);
        return;
      }
      if (sessionId) handoff.observe(next.records[sessionId], previous.records[sessionId]);
    });
  }, [active, handoff, reduced, runtimeKey, sessionId]);
  React.useLayoutEffect(() => () => handoff.dispose(), [handoff]);

  const captureDraft = React.useCallback((targetSessionId: string) => {
    const state = usePiSessionStore.getState();
    const current = view.current;
    if (!current.active || state.currentSessionId !== targetSessionId || getRuntimeKey() !== current.runtimeKey) return null;
    handoff.select(current.runtimeKey, targetSessionId, current.active, current.reduced);
    return handoff.captureDraft();
  }, [handoff]);
  const submit = React.useCallback((id: string, targetSessionId: string, source: ReturnType<PiMessageHandoff['captureDraft']>) => {
    if (!view.current.active || usePiSessionStore.getState().currentSessionId !== targetSessionId
      || getRuntimeKey() !== view.current.runtimeKey) return;
    handoff.submit(id, targetSessionId, source);
    handoff.observe(usePiSessionStore.getState().records[targetSessionId]);
  }, [handoff]);
  return React.useMemo(() => ({ ref: handoff.setRoot, captureDraft, submit,
    cancelSubmission: (id: string) => handoff.cancelSubmission(id) }), [captureDraft, handoff, submit]);
}
