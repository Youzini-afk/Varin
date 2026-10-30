import React from 'react';
import type { JsonValue } from '@varin/extension-contract';
import { useI18n } from '@/lib/i18n';
import {
  WorkbenchSurfaceContributionHost,
  useSurfaceRegistrySnapshot,
  workbenchContributionInstanceKey,
} from '@/lib/extensions/workbench-registry';
import { holdWorkbenchTransitionSceneContribution } from '@/lib/extensions/workbench-transition-scene';
import {
  armWorkbenchProfileTransitionPhase,
  createWorkbenchTransitionSceneController,
  finalizeWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  registerWorkbenchProfileTransitionSceneHost,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';
import {
  createWorkbenchTransitionPaintHandoff,
  type WorkbenchTransitionPaintHandoff,
} from '@/lib/workbench/transition-paint-handoff';

const CoreTransitionFallback: React.FC<{ onReady(): void }> = ({ onReady }) => {
  React.useEffect(() => {
    onReady();
  }, [onReady]);
  return <div className="absolute inset-0 bg-background" aria-hidden="true" />;
};

/**
 * Shell-independent Transition Scene host. The captured contribution is mounted once outside both
 * Shells; Profile commit can therefore replace the entire workbench without replacing its visual
 * owner halfway through cover/reveal.
 */
export const WorkbenchTransitionOverlay: React.FC = () => {
  const { t } = useI18n();
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );
  const paintHandoffRef = React.useRef<WorkbenchTransitionPaintHandoff | null>(null);
  const sceneLayerRef = React.useRef<HTMLDivElement | null>(null);
  const renderedTransitionRef = React.useRef<{
    contribution: ReturnType<typeof holdWorkbenchTransitionSceneContribution>;
    controller: ReturnType<typeof createWorkbenchTransitionSceneController>;
    id: number;
    scene: typeof transition.scene;
  } | null>(null);
  const [detachedTransitionId, setDetachedTransitionId] = React.useState<number | null>(null);
  if (
    transition.phase !== 'idle'
    && renderedTransitionRef.current?.id !== transition.id
  ) {
    renderedTransitionRef.current = {
      contribution: undefined,
      controller: createWorkbenchTransitionSceneController(transition.id),
      id: transition.id,
      scene: transition.scene,
    };
  }
  const renderedTransition = renderedTransitionRef.current;
  const sceneDetached = renderedTransition?.id === detachedTransitionId;

  /**
   * Three steps, in this order, and none of them overlapping.
   *
   * While the transaction runs, the root keeps the scene's palette. When the revealing timeline reports
   * finished, Core marks itself retiring and the scene's terminal frame is the only thing on screen. The
   * Core-owned wrapper then reaches compositor opacity zero before React is allowed to detach anything
   * inside it. Core reaches idle only afterwards, and the root palette is released later still.
   */
  React.useLayoutEffect(() => {
    if (
      !paintHandoffRef.current
      && transition.phase !== 'idle'
      && typeof document !== 'undefined'
    ) {
      paintHandoffRef.current = createWorkbenchTransitionPaintHandoff(document.documentElement);
    }
    const handoff = paintHandoffRef.current;
    if (!handoff) return;
    if (transition.phase === 'idle') {
      handoff.releaseAfterPaint();
      return;
    }
    if (sceneDetached) return;
    if (!transition.retiring || !renderedTransition) {
      handoff.hold();
      return;
    }
    const sceneLayer = sceneLayerRef.current;
    if (!sceneLayer) {
      handoff.hold();
      return;
    }
    handoff.retireScene(
      sceneLayer,
      { reducedMotion: transition.reducedMotion },
      () => setDetachedTransitionId(renderedTransition.id),
    );
  }, [
    renderedTransition,
    sceneDetached,
    transition.id,
    transition.phase,
    transition.reducedMotion,
    transition.retiring,
  ]);

  /**
   * Runs in the same commit that removed the scene's nodes, after every mutation in it. The scene is gone,
   * so the transaction can be idle and the Canvas controller's deferred teardown has a detached node to
   * work on.
   */
  React.useLayoutEffect(() => {
    if (!renderedTransition || !sceneDetached) return;
    finalizeWorkbenchProfileTransition(renderedTransition.id);
  }, [renderedTransition, sceneDetached]);

  // Declares that something is mounting scenes, so Core knows to wait for a detachment report rather than
  // ending the transaction the moment the reveal animation stops.
  React.useLayoutEffect(() => registerWorkbenchProfileTransitionSceneHost(), []);

  React.useLayoutEffect(() => () => {
    paintHandoffRef.current?.dispose();
    paintHandoffRef.current = null;
  }, []);
  const surface = useSurfaceRegistrySnapshot();
  const controller = renderedTransition?.controller ?? null;
  const sceneProps = React.useMemo(() => controller ? { transition: controller } : null, [controller]);

  // Resolved once per transaction and then held. The registry changes underneath this component precisely
  // during the Profile commit it is covering, and re-resolving would remount the scene mid-reveal.
  if (renderedTransition) {
    renderedTransition.contribution = holdWorkbenchTransitionSceneContribution({
      capture: renderedTransition.scene,
      held: renderedTransition.contribution,
      snapshot: surface,
    });
  }
  const contribution = renderedTransition?.contribution;
  const readinessKey = `${renderedTransition?.id ?? 0}\0${contribution
    ? workbenchContributionInstanceKey(contribution)
    : 'core-fallback'}`;
  const [readyKey, setReadyKey] = React.useState<string | null>(null);
  const onMountReady = React.useCallback(() => {
    setReadyKey(readinessKey);
  }, [readinessKey]);
  React.useEffect(() => {
    if (readyKey !== readinessKey) return;
    if (transition.phase === 'covering' || transition.phase === 'revealing') {
      armWorkbenchProfileTransitionPhase(transition.id, transition.phase);
    }
  }, [readinessKey, readyKey, transition.id, transition.phase]);

  const frame = controller?.getSnapshot() ?? null;
  // Keyed on the frame rather than rebuilt per render. An isolated scene reads this through a mount/unmount
  // message pair, so a fresh object on every render tells it to tear down and rebuild itself repeatedly,
  // including during the reveal it is in the middle of playing.
  const isolatedFrame = React.useMemo(() => contribution && frame ? {
    contributionId: contribution.descriptor.id,
    frame,
    type: 'motion.transition.frame',
  } as unknown as JsonValue : undefined, [contribution, frame]);

  if (!renderedTransition || sceneDetached || !controller || !sceneProps || !frame) return null;

  const fallback = <CoreTransitionFallback onReady={onMountReady} />;

  return (
    <div
      key={renderedTransition.id}
      ref={sceneLayerRef}
      className={`fixed inset-0 z-[9998] overflow-hidden ${frame.phase === 'revealing' ? 'pointer-events-none' : 'pointer-events-auto'}`}
      role="status"
      aria-live="polite"
      aria-label={t('splash.aria.switching')}
      data-varin-transition-scene={contribution?.descriptor.id ?? 'core-fallback'}
      style={{ isolation: 'isolate', opacity: 1, willChange: 'opacity' }}
    >
      {contribution ? (
        <WorkbenchSurfaceContributionHost
          className="h-full min-h-0 w-full min-w-0"
          contribution={contribution}
          fallback={fallback}
          isolatedProps={isolatedFrame}
          onMountReady={onMountReady}
          props={sceneProps}
        />
      ) : fallback}
    </div>
  );
};
