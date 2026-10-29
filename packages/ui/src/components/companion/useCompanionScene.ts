import React from 'react';
import type { DesktopCompanionScene } from '@varin/application-client';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import type { SceneFact } from './sceneFacts';
import { visibleSceneViewport, type SceneViewport } from './sceneViewport';

/** Sends semantic changes only; the decorative surface owns no Host APIs or decisions. */
export function useCompanionScene(canvas: React.RefObject<HTMLCanvasElement | null>, fact: SceneFact, scope: string,
  suppressed: boolean, menuOpen: boolean, engaged: boolean) {
  const revision = React.useRef(0);
  const lastViewport = React.useRef<SceneViewport | null>(null);
  const lastMessage = React.useRef('');
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
  const signature = JSON.stringify([fact, scope, suppressed, menuOpen, engaged, reduced, hidden, sizeRevision]);
  React.useEffect(() => {
    if (!isElectronShell()) return;
    const { viewport, visible } = visibleSceneViewport(canvas.current?.getBoundingClientRect(), window.innerWidth, window.innerHeight, lastViewport.current);
    if (!viewport) return;
    if (visible) lastViewport.current = viewport;
    const next = { ...fact, scope, suppressed: suppressed || hidden || !visible, reducedMotion: reduced, menuOpen, cue: engaged ? 'engaged' as const : 'transition' as const };
    const message = JSON.stringify([next, viewport]);
    if (lastMessage.current === message) return;
    lastMessage.current = message;
    const descriptor: DesktopCompanionScene = { ...next, revision: ++revision.current };
    void invokeDesktop('desktop_companion_scene', { descriptor, viewport }).catch(error => console.warn('[companion] decorative scene unavailable', error));
  }, [signature, canvas]);
}
