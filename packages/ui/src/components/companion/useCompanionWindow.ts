import React from 'react';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';

/** Pointer ownership is local presentation; never sends cancellation or permission commands. */
export function useCompanionWindow(canvas: React.RefObject<HTMLCanvasElement | null>, reviewPointer = false, beforeNativeLift?: () => void) {
  const [tapRevision, setTapRevision] = React.useState(0);
  const [phase, setPhase] = React.useState<'rest' | 'lifting' | 'landing'>('rest');
  const [pinned, setPinned] = React.useState(false);
  const [passthrough, setPassthrough] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const reevaluatePointer = React.useRef<() => void>(() => {});
  const lastMouse = React.useRef<{ x: number; y: number } | null>(null);
  const ignored = React.useRef(false);
  const stoolQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const worldStool = React.useCallback((phase: 'lift' | 'landing' | 'clear') => {
    if (!isElectronShell()) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (phase !== 'clear' && !rect) return;
    const args = phase === 'clear' ? { phase } as const : { phase, viewport: { x: rect!.x, y: rect!.y, width: rect!.width, height: rect!.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } };
    stoolQueue.current = stoolQueue.current.catch(() => {}).then(() => invokeDesktop('desktop_companion_stool', args)).catch(error => setNotice(String(error)));
  }, [canvas]);
  const passthroughQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const resetPassthrough = React.useCallback(() => {
    ignored.current = false;
    if (isElectronShell()) passthroughQueue.current = passthroughQueue.current.catch(() => {}).then(() => invokeDesktop('desktop_companion_passthrough', { enabled: false })).catch(() => {});
  }, []);
  const alpha = React.useRef<{ width: number; height: number; pixels: Uint8ClampedArray } | null>(null);
  const refreshHitMask = React.useCallback(() => {
    const node = canvas.current, context = node?.getContext('2d');
    alpha.current = node && context ? { width: node.width, height: node.height, pixels: context.getImageData(0,0,node.width,node.height).data } : null;
    reevaluatePointer.current();
  }, [canvas]);
  const pointer = React.useRef<{ id: number; x: number; y: number; anchor: { x: number; y: number }; moving: boolean } | null>(null);
  const hit = React.useCallback((x: number, y: number) => {
    const node = canvas.current;
    if (!node) return false;
    const bounds = node.getBoundingClientRect();
    if (!bounds.width || !bounds.height || x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom) return false;
    const mask = alpha.current;
    if (!mask) return false;
    const px = Math.floor((x-bounds.left)*mask.width/bounds.width), py = Math.floor((y-bounds.top)*mask.height/bounds.height);
    return (mask.pixels[(py*mask.width+px)*4+3] ?? 0) > 16;
  }, [canvas]);
  const send = React.useCallback((phase: 'start' | 'move' | 'end') => {
    if (!isElectronShell()) return;
    const anchor = pointer.current?.anchor;
    if (phase === 'start' && !anchor) return;
    const args = phase === 'start' ? { phase, anchor: anchor! } : { phase };
    void invokeDesktop('desktop_companion_drag', args).catch(error => setNotice(String(error)));
  }, []);
  const end = React.useCallback((completedClick = false) => {
    const current = pointer.current;
    pointer.current = null;
    send('end'); resetPassthrough();
    if (!current) return;
    if (canvas.current?.hasPointerCapture(current.id)) canvas.current.releasePointerCapture(current.id);
    setPhase(current.moving ? 'landing' : 'rest');
    if (!current.moving && completedClick) setTapRevision(value => value + 1);
  }, [canvas, send, resetPassthrough]);
  React.useEffect(() => {
    const cancel = () => end();
    window.addEventListener('blur', cancel);
    const hidden = () => { if (document.hidden) end(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden); end(); worldStool('clear'); };
  }, [end, worldStool]);
  React.useEffect(() => {
    if (!passthrough || !isElectronShell()) return;
    let active = true;
    const reconcile = () => {
      const mouse = lastMouse.current;
      if (!mouse) return;
      const target = document.elementFromPoint(mouse.x, mouse.y);
      const interactivePanel = target?.closest('button,select,input,header,section');
      const ignore = !pointer.current && !interactivePanel && !hit(mouse.x, mouse.y);
      if (ignore === ignored.current) return;
      ignored.current = ignore;
      // Serialize changes so a late true cannot override cleanup's final false.
      passthroughQueue.current = passthroughQueue.current.catch(() => {}).then(() => invokeDesktop('desktop_companion_passthrough', { enabled: ignore })).then(result => {
        if (active && !result?.supported) { setNotice('passthrough-unsupported'); setPassthrough(false); }
      }).catch(error => { if (active) { setNotice(String(error)); setPassthrough(false); } });
    };
    reevaluatePointer.current = reconcile;
    const move = (event: MouseEvent) => { lastMouse.current = { x: event.clientX, y: event.clientY }; reconcile(); };
    window.addEventListener('mousemove', move); reconcile();
    return () => { active = false; reevaluatePointer.current = () => {}; window.removeEventListener('mousemove', move); resetPassthrough(); };
  }, [hit, passthrough, resetPassthrough]);
  return { phase, tapRevision, notice, pinned, worldStool, passthrough, setPassthrough, refreshHitMask,
    settle: () => setPhase('rest'),
    togglePinned: async () => { try { const result = await invokeDesktop('desktop_set_window_pinned', { pinned: !pinned }); setPinned(result?.pinned ?? false); } catch(error) { setNotice(String(error)); } },
    handlers: {
      onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
        if ((!isElectronShell() && !reviewPointer) || event.button !== 0 || !hit(event.clientX, event.clientY)) return;
        event.preventDefault(); resetPassthrough(); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor: { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight }, moving: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
        const current = pointer.current;
        if (!current || current.id !== event.pointerId) return;
        if (!current.moving && Math.hypot(event.clientX-current.x,event.clientY-current.y) < 3) return;
        if (!current.moving) { current.moving = true; beforeNativeLift?.(); send('start'); setPhase('lifting'); }
        send('move');
      },
      onPointerUp: () => end(true), onPointerCancel: () => end(), onLostPointerCapture: () => end(),
    },
  };
}
