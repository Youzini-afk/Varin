import { useMemo, useReducer } from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import type { CompanionAttentionView } from './attentionCoordinator';
import { CompanionDirector, type DirectorObserveOptions } from './directorPresentation';

/** Director-mode candidate hook. Project inspection is independent from the body actor.
 * The director is a state machine over distinct observations: it advances once per new
 * snapshot/health/option value, never once per animation frame that re-renders the window. */
export function useCompanionDirector(attention: CompanionAttentionView, inspected: ThreadIdentity | null, hostGeneration: number,
  options: DirectorObserveOptions) {
  const director = useMemo(() => {
    void hostGeneration; // A new authenticated Host has a new portfolio identity domain.
    return new CompanionDirector();
  }, [hostGeneration]);
  const [revision, redraw] = useReducer(value => value + 1, 0);
  const inspectedKey = inspected ? JSON.stringify([inspected.threadId, inspected.branchId]) : null;
  const { visible, interacting, cardCapacity, interactionRoute, botId } = options;
  const presentation = useMemo(() => {
    void revision; // A consumed or discarded beat is a new observation of the same facts.
    const lens: ThreadIdentity | null = inspectedKey ? { runtime: 'agent', threadId: JSON.parse(inspectedKey)[0], branchId: JSON.parse(inspectedKey)[1] } : null;
    return director.observe(attention.snapshot, attention.health, lens, { visible, interacting, cardCapacity, interactionRoute, botId });
  }, [director, attention.snapshot, attention.health, inspectedKey, visible, interacting, cardCapacity, interactionRoute, botId, revision]);
  return useMemo(() => ({ ...presentation,
    consumeEdge: (key: string) => { director.consumeEdge(key); redraw(); },
    discardTransient: () => { director.discardTransient(); redraw(); },
  }), [presentation, director]);
}
