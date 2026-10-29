import { useMemo, useReducer } from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import type { CompanionAttentionView } from './attentionCoordinator';
import { CompanionDirector, type DirectorInteractionRoute } from './directorPresentation';

/** Director-mode candidate hook. Project inspection is independent from the body actor. */
export function useCompanionDirector(attention: CompanionAttentionView, inspected: ThreadIdentity | null, hostGeneration: number,
  options: { visible: boolean; interacting: boolean; cardCapacity: number; interactionRoute?: DirectorInteractionRoute }) {
  const director = useMemo(() => {
    void hostGeneration; // A new authenticated Host has a new portfolio identity domain.
    return new CompanionDirector();
  }, [hostGeneration]);
  const [, redraw] = useReducer(value => value + 1, 0);
  const presentation = director.observe(attention.snapshot, attention.health, inspected, options);
  return { ...presentation,
    consumeEdge: (key: string) => { director.consumeEdge(key); redraw(); },
    discardTransient: () => { director.discardTransient(); redraw(); },
  };
}
