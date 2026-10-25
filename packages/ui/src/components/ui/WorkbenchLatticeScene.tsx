import React from 'react';
import type { VarinTransitionSceneFrameV1 } from '@varin/extension-contract';
import { SwapText } from '@/components/motion/SwapText';
import { recentPointer } from '@/lib/motion/pointer';
import { LATTICE_HOLD_NOTICE_MS, type LatticePhase } from './workbench-lattice';
import { LatticeStage, latticeMode } from './workbench-lattice-stage';

export interface WorkbenchLatticeSceneProps {
  frame: VarinTransitionSceneFrameV1;
  /** Already translated; shown only if the cover has to wait for the target Shell. */
  status: string;
  onPhaseComplete: (phase: LatticePhase) => void;
}

/**
 * The Workbench switch (§3.11). The lattice grows out of the switcher until it covers the window,
 * holds while Core commits the Profile underneath, and opens again from the new switcher.
 *
 * Each phase plays once per transaction, whatever re-renders happen in between; a scene that mounts
 * after covering starts closed. The cover is opaque from the moment it reports itself complete until
 * the reveal starts, and the reveal's last frame shows nothing, as the scene contract requires.
 */
export const WorkbenchLatticeScene: React.FC<WorkbenchLatticeSceneProps> = ({ frame, status, onPhaseComplete }) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const fieldRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<{ stage: LatticeStage; played: Set<string> } | null>(null);
  const completeRef = React.useRef(onPhaseComplete);
  completeRef.current = onPhaseComplete;
  const { direction, phase, reducedMotion, transitionId } = frame;

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const field = fieldRef.current;
    const sheet = sheetRef.current;
    if (!root || !field || !sheet) return;
    const stage = new LatticeStage(root, field, sheet, latticeMode(reducedMotion));
    stageRef.current = { stage, played: new Set() };
    return () => {
      stage.dispose();
      stageRef.current = null;
      delete root.dataset.holding;
    };
  }, [reducedMotion, transitionId]);

  React.useLayoutEffect(() => {
    const entry = stageRef.current;
    const root = rootRef.current;
    if (!entry || !root || entry.played.has(phase)) return;
    entry.played.add(phase);
    const { stage } = entry;
    if (phase === 'covering') {
      void stage.cover(stage.measureOrigin(recentPointer())).then((done) => {
        if (done) completeRef.current('covering');
      });
      return;
    }
    if (phase === 'covered') {
      stage.close();
      const notice = setTimeout(() => { root.dataset.holding = 'true'; }, LATTICE_HOLD_NOTICE_MS);
      return () => clearTimeout(notice);
    }
    delete root.dataset.holding;
    // The new Shell has painted by now, so its switcher (often somewhere else) is where the light returns.
    void stage.reveal(stage.measureOrigin(null, stage.origin), direction === 'backward').then((done) => {
      if (done) completeRef.current('revealing');
    });
  }, [direction, phase, transitionId]);

  return (
    <div ref={rootRef} className="wb-lattice" aria-hidden="true">
      <div ref={fieldRef} className="wb-lattice-field" />
      <div ref={sheetRef} className="wb-lattice-sheet" />
      <div className="wb-lattice-hold">
        <SwapText text={status} live className="typography-meta" />
      </div>
    </div>
  );
};
