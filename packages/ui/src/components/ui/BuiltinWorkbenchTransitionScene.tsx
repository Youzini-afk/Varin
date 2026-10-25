import React from 'react';
import { WorkbenchLatticeScene } from '@/components/ui/WorkbenchLatticeScene';
import { useI18n } from '@/lib/i18n';
import { useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import type { WorkbenchTransitionSceneController } from '@/lib/workbench/profile-transition';

export interface BuiltinWorkbenchTransitionSceneProps {
  transition: WorkbenchTransitionSceneController;
}

/**
 * Default Motion extension scene: the lattice wave. It owns visuals only; the controller remains
 * Core-owned. The boot splash (VarinSplash) is no longer used for Profile switches.
 */
export const BuiltinWorkbenchTransitionScene: React.FC<BuiltinWorkbenchTransitionSceneProps> = ({
  transition,
}) => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const frame = React.useSyncExternalStore(
    transition.subscribe,
    transition.getSnapshot,
    transition.getSnapshot,
  );
  const profiles = catalog.snapshot?.workbench?.document.profiles ?? [];
  const target = profiles.find((profile) => profile.id === frame.toProfileId);
  const status = target
    ? t('splash.switchingTo', { profile: workbenchProfileLabel(target, t) })
    : t('splash.switching');
  const { transitionId } = frame;
  const onPhaseComplete = React.useCallback((phase: 'covering' | 'revealing') => {
    transition.complete(transitionId, phase);
  }, [transition, transitionId]);

  return <WorkbenchLatticeScene frame={frame} status={status} onPhaseComplete={onPhaseComplete} />;
};
