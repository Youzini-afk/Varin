import { useRef } from 'react';
import type { ThreadAttentionSnapshot } from '@varin/application-client';
import type { DirectorPresentation } from './directorPresentation';
import { DirectorPortfolioProjector, type DirectorPortfolioDisplayOptions, type DirectorToolDetail } from './directorPortfolio';

/** Candidate-only inert descriptor; full titles and execution identities remain in the UI legend. */
export function useDirectorPortfolio(view: DirectorPresentation, snapshot: ThreadAttentionSnapshot | null,
  hostGeneration: number, details: readonly DirectorToolDetail[] = [], display: DirectorPortfolioDisplayOptions = {}) {
  const projector = useRef(new DirectorPortfolioProjector());
  return projector.current.project(view, snapshot, hostGeneration, details, display);
}
