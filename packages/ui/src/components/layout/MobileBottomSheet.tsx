import React from 'react';
import { cn } from '@/lib/utils';
import { springTiming } from '@/lib/motion/tokens';
import { FULL_GAP_PX, OVERSHOOT, settleSheet, sheetOffsets, type SheetSnap } from './mobileBottomSheetPhysics';

/**
 * A panel that rises from the bottom on phones. It opens at half height, can be pulled to full
 * height, follows the finger 1:1 and settles on glide; above full height it resists. Tapping
 * the dimmed conversation closes it.
 */
export function MobileBottomSheet({ open, onOpenChange, label, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  children: React.ReactNode;
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  const [snap, setSnap] = React.useState<SheetSnap>('half');
  const [drag, setDrag] = React.useState<number | null>(null);
  const [mounted, setMounted] = React.useState(open);
  // Raised one frame after mounting, so opening rises from the bottom instead of appearing.
  const [raised, setRaised] = React.useState(open);
  React.useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return undefined;
    const measure = () => setHeight(parent.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [mounted]);
  React.useEffect(() => {
    if (open) {
      setMounted(true); setSnap('half');
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setRaised(true)); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setRaised(false);
    const timer = setTimeout(() => setMounted(false), springTiming('glide').duration);
    return () => clearTimeout(timer);
  }, [open]);
  const stops = sheetOffsets(height);
  const resting = open && raised ? stops[snap] : stops.closed;
  const offset = drag ?? resting;
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!open || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startOffset = resting;
    let last = { y: startY, at: performance.now() };
    let velocity = 0;
    let current = startOffset;
    const move = (next: PointerEvent) => {
      const now = performance.now();
      velocity = (next.clientY - last.y) / Math.max(1, now - last.at);
      last = { y: next.clientY, at: now };
      const raw = startOffset + next.clientY - startY;
      current = raw < 0 ? raw * OVERSHOOT : raw;
      setDrag(current);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDrag(null);
      const landed = settleSheet(snap, current, velocity, height);
      if (landed === 'closed') onOpenChange(false);
      else setSnap(landed);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  if (!mounted) return <div ref={host} hidden />;
  const shown = Math.max(0, Math.min(1, 1 - offset / Math.max(1, stops.closed)));
  return <div ref={host} className="absolute inset-0 z-30" data-page-scroll-lock="true">
    <div aria-hidden="true" className="absolute inset-0 bg-black/30" style={{ opacity: open && raised ? shown : 0, transition: drag === null ? 'opacity var(--motion-dur-glide) var(--motion-ease-glide)' : 'none' }}
      onClick={() => onOpenChange(false)} />
    <section role="dialog" aria-label={label} aria-modal="false"
      className={cn('mobile-bottom-sheet absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-2xl bg-background shadow-[0_-12px_40px_-18px_rgb(0_0_0/0.45)]')}
      style={{ top: FULL_GAP_PX, transform: `translateY(${height ? offset : 10_000}px)`, transition: drag === null ? 'transform var(--motion-dur-glide) var(--motion-ease-glide)' : 'none' }}
      onKeyDown={event => { if (event.key === 'Escape') onOpenChange(false); }}>
      <div className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center" onPointerDown={begin} data-sheet-handle="">
        <span className="h-1 w-9 rounded-full bg-[var(--interactive-border)]" />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  </div>;
}
