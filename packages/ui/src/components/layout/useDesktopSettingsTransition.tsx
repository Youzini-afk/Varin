import React from 'react';
import { LatticeStage } from '@/components/ui/workbench-lattice-stage';
import { latticeOrigin, type LatticePoint } from '@/components/ui/workbench-lattice';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { importWithChunkRecovery, lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from '@/lib/extensions/workbench-registry';
import { useUIStore } from '@/stores/useUIStore';

// Give each wave time to travel from the button across the content area.
const SETTINGS_WAVE_SCALE = 0.7;
let SettingsWindow: typeof import('@/components/views/SettingsWindow').SettingsWindow | undefined;
const loadWindow = async () => {
  const module = await import('@/components/views/SettingsWindow');
  SettingsWindow = module.SettingsWindow;
  return { default: SettingsWindow };
};
const LazySettingsWindow = lazyWithChunkRecovery(loadWindow);

function originInContent(root: HTMLElement, shell: HTMLElement, open: boolean, point: LatticePoint | null) {
  const anchorName = open ? 'open' : 'return';
  const anchors = point ? [] : shell.querySelectorAll(`[data-varin-settings-origin="${anchorName}"]`);
  for (const anchor of anchors) {
    const rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return latticeOrigin(root.getBoundingClientRect(), rect, null);
  }
  return latticeOrigin(root.getBoundingClientRect(), null, point);
}

/** Replaces the visible row only once the lattice covers it. The Shell stays mounted. */
export function useDesktopSettingsTransition(enabled: boolean) {
  const requested = useUIStore(state => state.isSettingsDialogOpen);
  const point = useUIStore(state => state.settingsTransitionOrigin);
  const setOpen = useUIStore(state => state.setSettingsDialogOpen);
  const mode = useMotionLevel();
  const [visible, setVisible] = React.useState(requested);
  const visibleRef = React.useRef(visible);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const waveRef = React.useRef<{ stage: LatticeStage; origin: LatticePoint; target: boolean; covered: boolean } | null>(null);
  const close = React.useCallback((origin?: LatticePoint) => setOpen(false, origin), [setOpen]);

  React.useLayoutEffect(() => {
    visibleRef.current = visible;
    const wave = waveRef.current;
    const root = rootRef.current;
    if (!root || !wave?.covered || wave.target !== visible) return;
    delete root.dataset.covering;
    void wave.stage.reveal(wave.origin, false).then(() => {
      if (waveRef.current === wave) {
        wave.stage.dispose();
        waveRef.current = null;
        root.hidden = true;
      }
    });
  }, [visible]);

  React.useLayoutEffect(() => {
    if (requested === visibleRef.current) return;
    const root = rootRef.current;
    const field = fieldRef.current;
    const sheet = sheetRef.current;
    const shell = root?.parentElement;
    const titlebar = shell?.querySelector(':scope > [data-startup-part="header"]');
    if (!enabled || mode === 'off' || !root || !field || !sheet || !shell || !titlebar) {
      setVisible(requested);
      return;
    }
    root.style.top = `${Math.max(0, titlebar.getBoundingClientRect().bottom - shell.getBoundingClientRect().top)}px`;
    root.hidden = false;
    root.dataset.covering = '';
    const stage = new LatticeStage(root, field, sheet, mode, SETTINGS_WAVE_SCALE);
    const wave = { stage, origin: originInContent(root, shell, requested, point), target: requested, covered: false };
    waveRef.current = wave;
    const prepared = requested && !SettingsWindow ? importWithChunkRecovery(loadWindow).catch(() => undefined) : undefined;
    void Promise.all([stage.cover(wave.origin), prepared]).then(() => {
      if (waveRef.current !== wave) return;
      stage.close();
      wave.covered = true;
      setVisible(requested);
    });
    return () => {
      if (waveRef.current === wave) {
        stage.dispose();
        waveRef.current = null;
      }
      delete root.dataset.covering;
      root.hidden = true;
    };
  }, [enabled, mode, point, requested]);

  const open = enabled && mode !== 'off' ? visible : requested;
  const Window = SettingsWindow ?? LazySettingsWindow;
  return {
    open,
    content: enabled && open ? <WorkbenchReplacement target={WORKBENCH_REPLACEMENT_TARGETS.settings}
      fallback={<React.Suspense fallback={null}><Window onClose={close} /></React.Suspense>} /> : null,
    layer: enabled ? <div ref={rootRef} className="wb-lattice workbench-settings-lattice" hidden aria-hidden="true">
      <div ref={fieldRef} className="wb-lattice-field" />
      <div ref={sheetRef} className="wb-lattice-sheet" />
    </div> : null,
  };
}
