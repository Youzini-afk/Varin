import React from 'react';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { LocalInteractionTiming } from './localInteractionTiming';

/** Pointer ownership is local presentation; never sends cancellation or permission commands. */
export function useCompanionWindow(canvas: React.RefObject<HTMLCanvasElement | null>, reviewPointer = false, beforeNativeLift?: () => void, allowRepeatTap?: () => boolean) {
  const [tapRevision, setTapRevision] = React.useState(0);
  const [tapKind, setTapKind] = React.useState<'tap-first' | 'tap-repeat'>('tap-first');
  const timing = React.useRef(new LocalInteractionTiming());
  const repeatAllowed = React.useRef(allowRepeatTap); repeatAllowed.current = allowRepeatTap;
  const [returnedOnActivity, setReturnedOnActivity] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [hoverRevision, setHoverRevision] = React.useState(0);
  const [activityRevision, setActivityRevision] = React.useState(0);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverInside = React.useRef(false);
  const hoverPoint = React.useRef<{ x: number; y: number } | null>(null);
  const reevaluateHover = React.useRef<() => void>(() => {});
  const clearHover = React.useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null; timing.current.observeHover(false, performance.now()); hoverInside.current = false; hoverPoint.current = null; setHovered(false);
  }, []);
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
    reevaluatePointer.current(); reevaluateHover.current();
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
    if (!completedClick) timing.current.interrupt();
    if (canvas.current?.hasPointerCapture(current.id)) canvas.current.releasePointerCapture(current.id);
    setPhase(current.moving ? 'landing' : 'rest');
    if (!current.moving && completedClick) {
      const now = performance.now();
      setReturnedOnActivity(timing.current.returnOnActivity(now));
      const kind = timing.current.tap(now, repeatAllowed.current?.() ?? false);
      if (kind) { setTapKind(kind); setTapRevision(value => value + 1); }
    }
  }, [canvas, send, resetPassthrough]);
  React.useEffect(() => {
    const cancel = () => { timing.current.interrupt(); clearHover(); end(); };
    window.addEventListener('blur', cancel);
    const hidden = () => { timing.current.visibility(!document.hidden, performance.now()); if (document.hidden) { clearHover(); end(); } };
    hidden();
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden); clearHover(); end(); worldStool('clear'); };
  }, [end, worldStool, clearHover]);
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
  const resetLocalInteraction = React.useCallback(() => {
    timing.current.reset('scope'); clearHover(); setReturnedOnActivity(false);
  }, [clearHover]);
  const reconcileHover = React.useCallback(() => {
    const point = hoverPoint.current;
    if (!point || pointer.current || document.hidden || !hit(point.x, point.y)) { clearHover(); return; }
    hoverInside.current = true; setHovered(true);
    const now = performance.now();
    if (timing.current.observeHover(true, now)) {
      setReturnedOnActivity(timing.current.returnOnActivity(now));
      setActivityRevision(value => value + 1); setHoverRevision(value => value + 1);
    }
    const delay = timing.current.hoverDelay(now);
    if (delay !== null && hoverTimer.current === null) hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null; reevaluateHover.current();
    }, delay);
  }, [hit, clearHover]);
  reevaluateHover.current = reconcileHover;
  return { phase, tapRevision, tapKind, returnedOnActivity, resetLocalInteraction, hovered, hoverRevision, activityRevision, notice, pinned, worldStool, passthrough, setPassthrough, refreshHitMask,
    settle: () => setPhase('rest'),
    togglePinned: async () => { try { const result = await invokeDesktop('desktop_set_window_pinned', { pinned: !pinned }); setPinned(result?.pinned ?? false); } catch(error) { setNotice(String(error)); } },
    handlers: {
      onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
        if ((!isElectronShell() && !reviewPointer) || event.button !== 0 || !hit(event.clientX, event.clientY)) return;
        clearHover(); setActivityRevision(value => value + 1);
        event.preventDefault(); resetPassthrough(); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor: { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight }, moving: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
        const current = pointer.current;
        if (!current) {
          if (event.pointerType !== 'mouse' || !hit(event.clientX, event.clientY)) { clearHover(); return; }
          hoverPoint.current = { x: event.clientX, y: event.clientY };
          reconcileHover();
          return;
        }
        if (current.id !== event.pointerId) return;
        if (!current.moving && Math.hypot(event.clientX-current.x,event.clientY-current.y) < 3) return;
        if (!current.moving) { current.moving = true; timing.current.reset('drag'); beforeNativeLift?.(); send('start'); setPhase('lifting'); }
        send('move');
      },
      onPointerLeave: clearHover,
      onPointerUp: () => end(true), onPointerCancel: () => end(), onLostPointerCapture: () => end(),
    },
  };
}
