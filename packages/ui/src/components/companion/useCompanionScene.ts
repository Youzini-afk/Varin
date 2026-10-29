import React from 'react';
import type { DesktopCompanionScene } from '@varin/application-client';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import type { SceneFact } from './sceneFacts';

/** Sends semantic changes only; the decorative surface owns no Host APIs or decisions. */
export function useCompanionScene(canvas: React.RefObject<HTMLCanvasElement | null>, fact: SceneFact, scope: string,
  suppressed: boolean, menuOpen: boolean, engaged: boolean) {
  const revision = React.useRef(0);
  const [reduced, setReduced] = React.useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hidden, setHidden] = React.useState(document.hidden);
  const [sizeRevision, bumpSize] = React.useReducer((v: number) => v + 1, 0);
  React.useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches), visibility = () => setHidden(document.hidden), resize = () => bumpSize();
    const observer = new ResizeObserver(resize);
    if (canvas.current) observer.observe(canvas.current);
    media.addEventListener('change', update); document.addEventListener('visibilitychange', visibility); window.addEventListener('resize', resize);
    return () => { observer.disconnect(); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', resize); };
  }, []);
  const signature = JSON.stringify([fact, scope, suppressed, menuOpen, engaged, reduced, hidden, sizeRevision]);
  React.useEffect(() => {
    const node = canvas.current, rect = node?.getBoundingClientRect();
    if (!rect?.width || !rect.height || !isElectronShell()) return;
    const descriptor: DesktopCompanionScene = { ...fact, scope, revision: ++revision.current, suppressed: suppressed || hidden,
      reducedMotion: reduced, menuOpen, cue: engaged ? 'engaged' : 'transition' };
    void invokeDesktop('desktop_companion_scene', { descriptor, viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } }).catch(error => console.warn('[companion] decorative scene unavailable', error));
  }, [signature, canvas]);
}
