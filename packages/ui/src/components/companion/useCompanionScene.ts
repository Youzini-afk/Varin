import { cueMatchesScene, directorCueMatchesPresentation } from './sceneCues';
import React from 'react';
import type { DesktopCompanionScene, DesktopCompanionSceneLayoutReceipt } from '@varin/application-client';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import type { SceneFact } from './sceneFacts';
import { visibleSceneViewport, type SceneViewport } from './sceneViewport';

/** Sends semantic changes only; the decorative surface owns no Host APIs or decisions. */
export function useCompanionScene(canvas: React.RefObject<HTMLCanvasElement | null>, fact: SceneFact, scope: string,
  suppressed: boolean, menuOpen: boolean, visibleCue?: { cue: DesktopCompanionScene['cue']; instance: number; action: string | undefined; context?: string | null }, team?: DesktopCompanionScene['team'], portfolio?: DesktopCompanionScene['portfolio'], presentationKey?: string | null) {
  const revision = React.useRef(0);
  const lastViewport = React.useRef<SceneViewport | null>(null);
  const lastMessage = React.useRef('');
  const lastLayoutKey = React.useRef('');
  const latestScope = React.useRef(scope); latestScope.current = scope;
  const [layoutReceipt, setLayoutReceipt] = React.useState<(DesktopCompanionSceneLayoutReceipt & { viewportRevision: number }) | null>(null);
  const [reduced, setReduced] = React.useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hidden, setHidden] = React.useState(document.hidden);
  const [sizeRevision, bumpSize] = React.useReducer((v: number) => v + 1, 0);
  React.useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let pendingFrame = 0;
    const update = () => setReduced(media.matches), visibility = () => setHidden(document.hidden);
    const resize = () => { if (!pendingFrame) pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; bumpSize(); }); };
    const observer = new ResizeObserver(resize);
    if (canvas.current) observer.observe(canvas.current);
    media.addEventListener('change', update); document.addEventListener('visibilitychange', visibility); window.addEventListener('resize', resize); window.addEventListener('scroll', resize, true);
    return () => { cancelAnimationFrame(pendingFrame); observer.disconnect(); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', resize); window.removeEventListener('scroll', resize, true); };
  }, []);
  const knownSide = layoutReceipt?.scope === scope && layoutReceipt.viewportRevision === sizeRevision ? layoutReceipt.inspectionSide : null;
  const signature = JSON.stringify([knownSide, fact, scope, suppressed, menuOpen, visibleCue, team, portfolio, presentationKey, reduced, hidden, sizeRevision]);
  React.useEffect(() => {
    if (!isElectronShell()) return;
    const { viewport, visible } = visibleSceneViewport(canvas.current?.getBoundingClientRect(), window.innerWidth, window.innerHeight, lastViewport.current);
    if (!viewport) return;
    if (visible) lastViewport.current = viewport;
    const managementCue = directorCueMatchesPresentation(visibleCue, presentationKey, knownSide);
    const matchingCue = (portfolio ? managementCue : cueMatchesScene(fact.kind, visibleCue?.action)) ? visibleCue : undefined;
    const next = { ...(portfolio ? { kind: 'portfolio' as const, phase: 'active' as const, outcome: null, count: null, portfolio } : { ...fact, ...(team ? { team } : {}) }), scope, suppressed: suppressed || hidden || !visible, reducedMotion: reduced, menuOpen, cue: matchingCue?.cue ?? 'transition' as const, cueInstance: matchingCue?.instance };
    const message = JSON.stringify([next, viewport]);
    if (lastMessage.current === message) return;
    lastMessage.current = message;
    const descriptor: DesktopCompanionScene = { ...next, revision: ++revision.current };
    let active = true;
    const layoutKey = JSON.stringify([scope, viewport, descriptor.suppressed, menuOpen]);
    if (lastLayoutKey.current !== layoutKey) { lastLayoutKey.current = layoutKey; setLayoutReceipt(null); }
    void invokeDesktop('desktop_companion_scene', { descriptor, viewport }).then(receipt => {
      if (active && receipt && receipt.scope === latestScope.current && receipt.scope === descriptor.scope
        && receipt.revision === descriptor.revision && revision.current === descriptor.revision) setLayoutReceipt({ ...receipt, viewportRevision: sizeRevision });
    }).catch(error => console.warn('[companion] decorative scene unavailable', error));
    return () => { active = false; };
  }, [signature, canvas]);
  return layoutReceipt?.scope === scope && layoutReceipt.viewportRevision === sizeRevision && !suppressed && !hidden && !menuOpen ? layoutReceipt : null;
}
