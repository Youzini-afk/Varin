import React from 'react';
import { currentDialogOrigin, dialogFlightGeometry, dialogOrigin, type DialogMotionKey } from '@/lib/motion/dialogOrigin';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';

/** Base UI owns presence and interruption. This hook only supplies launch/return geometry. */
export function useDialogOriginMotion(key: DialogMotionKey, open: boolean) {
  const origin = dialogOrigin(key);
  const refresh = React.useRef<(() => void) | null>(null);
  const cleanup = React.useRef<(() => void) | null>(null);
  const ref = React.useCallback((popup: HTMLDivElement | null) => {
    cleanup.current?.(); cleanup.current = null; refresh.current = null;
    if (!popup) return;
    let frame: FrameHandle | undefined;
    const measure = () => {
      frame?.cancel();
      frame = undefined;
      const parent = popup.offsetParent as HTMLElement | null;
      const bounds = parent?.getBoundingClientRect();
      // Layout offsets deliberately ignore the popup's in-flight transform. Closing or
      // reversing halfway through must not use its currently scaled bounding rectangle.
      const geometry = origin ? dialogFlightGeometry({
        left: (bounds?.left ?? 0) + (parent?.clientLeft ?? 0) + popup.offsetLeft - (parent?.scrollLeft ?? 0),
        top: (bounds?.top ?? 0) + (parent?.clientTop ?? 0) + popup.offsetTop - (parent?.scrollTop ?? 0),
        width: popup.offsetWidth, height: popup.offsetHeight,
      }, currentDialogOrigin(origin)) : null;
      popup.style.setProperty('--dialog-flight-x', `${geometry?.x ?? 0}px`);
      popup.style.setProperty('--dialog-flight-y', `${geometry?.y ?? 0}px`);
      popup.style.setProperty('--dialog-flight-scale', String(geometry?.scale ?? 0.985));
    };
    const schedule = () => { frame ??= requestFrame(measure); };
    refresh.current = measure;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(popup);
    const source = origin?.element.deref(); if (source) observer?.observe(source);
    window.addEventListener('resize', schedule, { passive: true });
    cleanup.current = () => { frame?.cancel(); observer?.disconnect(); window.removeEventListener('resize', schedule); };
  }, [origin]);
  React.useLayoutEffect(() => { refresh.current?.(); }, [open, origin]);
  React.useLayoutEffect(() => () => { cleanup.current?.(); }, []);
  return {
    popupProps: { ref, 'data-dialog-flight': origin ? 'button' : 'center' },
    backdropClassName: origin ? 'motion-dialog-flight-backdrop' : undefined,
  };
}
