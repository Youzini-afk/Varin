import type { ExploreQueryView } from './harness.js';

/** Source facts changed; re-evaluate affected views without switching providers. */
export class ExploreEvidenceChanged extends Error {
  constructor() { super('Retrieval evidence changed; its affected source was refreshed.'); }
}

/** Keep related source together when it fits. Whole views survive partitioning;
 * a view that cannot fit is reported rather than shortened into misleading code. */
export async function partitionExploreViews(
  views: readonly ExploreQueryView[],
  retained: readonly ExploreQueryView[],
  fits: (views: ExploreQueryView[]) => Promise<boolean>,
): Promise<{ batches: ExploreQueryView[][]; oversized: ExploreQueryView[] }> {
  const related = (a: ExploreQueryView, b: ExploreQueryView) => a.path === b.path
    || a.relatedPaths?.includes(b.path) || b.relatedPaths?.includes(a.path);
  const remaining = new Set(views), groups: ExploreQueryView[][] = [];
  for (const seed of views) {
    if (!remaining.delete(seed)) continue;
    const group = [seed];
    for (let index = 0; index < group.length; index++) {
      for (const candidate of remaining) if (related(group[index]!, candidate)) {
        group.push(candidate); remaining.delete(candidate);
      }
    }
    groups.push(group);
  }
  const batches: ExploreQueryView[][] = [], oversized: ExploreQueryView[] = [];
  let current: ExploreQueryView[] = [];
  for (const group of groups) {
    if (await fits([...current, ...group])) { current.push(...group); continue; }
    if (current.length) { batches.push(current); current = []; }
    if (await fits(group)) { current = [...group]; continue; }
    for (const view of group) {
      if (await fits([...current, view])) current.push(view);
      else {
        if (current.length) batches.push(current);
        current = [];
        if (await fits([view])) current = [view]; else oversized.push(view);
      }
    }
  }
  if (current.length) batches.push(current);
  // Add relevant retained bodies to the same judgment. The caller describes which
  // evidence is present and which remains outside this capacity-sized comparison.
  for (const batch of batches) {
    const affinity = (view: ExploreQueryView) => batch.some(other => related(other, view)) ? 2 : 0;
    const background = [...new Map([...retained, ...views.filter(view => affinity(view))].map(view => [view.viewId, view])).values()];
    for (const view of background.sort((a, b) => affinity(b) - affinity(a))) {
      if (!batch.some(item => item.viewId === view.viewId) && await fits([...batch, view])) batch.push(view);
    }
  }
  return { batches, oversized };
}
