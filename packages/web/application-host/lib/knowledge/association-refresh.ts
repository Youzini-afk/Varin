/** Private, resumable work over a captured connection set. Each step publishes
 * one file, then returns the storage queue to interactive callers. */
export interface AssociationRefreshPort {
  beginAssociationRefresh(): Promise<number | null>;
  stepAssociationRefresh(id: number): Promise<{ done: boolean; activated: number }>;
  releaseAssociationRefresh(id: number): Promise<void>;
}

export async function resolveAssociations(port: AssociationRefreshPort): Promise<{ activated: number }> {
  const id = await port.beginAssociationRefresh();
  if (id === null) return { activated: 0 };
  let activated = 0;
  try {
    for (;;) {
      const step = await port.stepAssociationRefresh(id);
      activated += step.activated;
      if (step.done) return { activated };
    }
  } finally {
    await port.releaseAssociationRefresh(id);
  }
}
