import React from 'react';
import { getRuntimeUrlResolver, refreshRuntimeUrlAuthToken } from '@varin/application-client';
import type RFB from '@novnc/novnc';

/** noVNC only decodes the framebuffer. Server-side Xvnc also refuses RFB
 * keyboard/pointer/clipboard writes; parent input handlers use Host ownership. */
export const VncDesktop = React.forwardRef<HTMLDivElement, {
  desktopId: string;
  onGeometry(width: number, height: number): void;
  onConnected(connected: boolean): void;
}>(({ desktopId, onGeometry, onConnected }, ref) => {
  const target = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => target.current!, []);
  React.useEffect(() => {
    let cancelled = false;
    let connection: RFB | undefined;
    let observer: ResizeObserver | undefined;
    let geometryObserver: MutationObserver | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const reconnect = () => {
      if (cancelled || retry) return;
      onConnected(false);
      retry = setTimeout(() => { retry = undefined; void start(); }, Math.min(1000 * 2 ** failures++, 30000));
    };
    const start = async () => {
      try {
        await refreshRuntimeUrlAuthToken();
        const { default: Rfb } = await import('@novnc/novnc');
        if (cancelled || !target.current) return;
        const rfb = new Rfb(target.current, getRuntimeUrlResolver().websocket(`/api/computers/desktops/${encodeURIComponent(desktopId)}/vnc`));
        connection = rfb;
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = false;
        rfb.addEventListener('connect', () => {
          if (cancelled) return;
          failures = 0;
          onConnected(true);
          const canvas = target.current?.querySelector('canvas');
          if (canvas) {
            const update = () => { if (canvas.width && canvas.height) onGeometry(canvas.width, canvas.height); };
            observer = new ResizeObserver(update); observer.observe(canvas); update();
            geometryObserver = new MutationObserver(update);
            geometryObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
          }
        });
        rfb.addEventListener('disconnect', () => { observer?.disconnect(); geometryObserver?.disconnect(); reconnect(); });
      } catch { reconnect(); }
    };
    void start();
    return () => { cancelled = true; if (retry) clearTimeout(retry); observer?.disconnect(); geometryObserver?.disconnect(); connection?.disconnect(); };
  }, [desktopId, onConnected, onGeometry]);
  return <div ref={target} className="h-full w-full pointer-events-none" />;
});
VncDesktop.displayName = 'VncDesktop';
