import type { CompanionPackage } from './sequencePackage';

/** Capability of an installed, explicitly accepted bundle, not a candidate promotion.
 * The source compiler/selection ledger owns route and exact-source acceptance. */
export function hasAcceptedDirectorAssets(packages: readonly CompanionPackage[]): boolean {
  const actions = ['director-supervise', 'director-listen-left', 'director-listen-right',
    'director-gather-present', 'director-intake', 'director-open-attention', 'idle-closed'];
  const accepted = packages.filter(asset => asset.reviewStatus === 'accepted' && asset.stage === 'motion-candidate'
    && asset.geometryReference && asset.entryPose && asset.exitPose && asset.frames.length > 0);
  return actions.every(action => accepted.some(asset => asset.action === action && asset.geometryReference === 'varin-upright-v2'));
}

export function companionDirectorMode(packages: readonly CompanionPackage[], developmentReview: boolean, candidateReview: boolean): boolean {
  return developmentReview ? candidateReview : hasAcceptedDirectorAssets(packages);
}
