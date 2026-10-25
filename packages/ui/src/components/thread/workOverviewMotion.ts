import React from 'react';
import { requestAfterFrame, requestFrame, type FrameHandle } from '@/lib/motion/frame';
import type { MotionLevel } from '@/lib/motion/preference';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { SpringDriver, tokenSpring } from '@/lib/motion/spring';
import { springTiming } from '@/lib/motion/tokens';

export type WorkOverviewView = 'closed' | 'compact' | 'full';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
type Geometry = { width: number; height: number; extent: number };

/** One shape and two retained reading surfaces. Only the light frame changes
 * size each frame; prose takes its destination width once, then moves with the
 * space being reserved. Reversal retargets the same springs and their velocity. */
class OverviewMotion {
  private readonly frame: HTMLElement;
  private readonly launcher: HTMLElement;
  private readonly full: HTMLElement;
  private readonly compact: HTMLElement;
  private readonly main: HTMLElement | null;
  private readonly parent: HTMLElement;
  private readonly drivers: Record<keyof Geometry | 'full' | 'compact' | 'reveal', SpringDriver>;
  private observer: ResizeObserver | null = null;
  private pending: FrameHandle | null = null;
  private painting: FrameHandle | null = null;
  private readingMotions = new Set<Animation>();
  private placed = false;
  private vertical = false;
  private view: WorkOverviewView;
  private panelWidth: number;
  private resizing = false;

  constructor(private readonly root: HTMLElement, view: WorkOverviewView, width: number, private level: MotionLevel) {
    this.parent = root.parentElement!;
    this.frame = root.querySelector('[data-overview-frame]')!;
    this.launcher = root.querySelector('[data-harness-overview-controls]')!;
    this.full = root.querySelector('[data-harness-overview-panel]')!;
    this.compact = root.querySelector('[data-harness-overview-peek]')!;
    this.main = this.parent.querySelector(':scope > .thread-conversation-main');
    this.view = view;
    this.panelWidth = width;
    const driver = (restDelta: number) => new SpringDriver({
      spring: tokenSpring('glide'), restDelta, restSpeed: restDelta * 10,
      onUpdate: () => this.schedulePaint(),
    });
    this.drivers = {
      width: driver(0.2), height: driver(0.2), extent: driver(0.2),
      full: driver(0.001), compact: driver(0.001), reveal: driver(0.001),
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        this.pending ??= requestFrame(() => { this.pending = null; this.measure(); });
      });
      for (const element of [this.parent, this.full, this.compact]) this.observer.observe(element);
    }
    window.addEventListener('resize', this.onResize);
    this.measure();
  }

  set(view: WorkOverviewView, width: number, resizing: boolean, level: MotionLevel): void {
    const changed = view !== this.view;
    this.view = view;
    this.panelWidth = width;
    this.resizing = resizing;
    this.level = level;
    this.measure();
    if (changed) this.handoffFocus();
  }

  private onResize = () => {
    this.pending ??= requestFrame(() => { this.pending = null; this.measure(); });
  };

  private measure(): void {
    const { clientWidth: availableWidth, clientHeight: availableHeight } = this.parent;
    // A prepared/hidden shell gets its first placement when it has a real box.
    if (!availableWidth || !availableHeight) return;
    const style = getComputedStyle(this.root);
    const vertical = style.getPropertyValue('--overview-axis').trim() === 'height';
    const axisChanged = vertical !== this.vertical;
    this.vertical = vertical;
    const level = this.level;
    const instant = !this.placed || axisChanged || this.resizing || level === 'off';
    const geometric = instant || level !== 'full';
    const compactWidth = Number.parseFloat(style.getPropertyValue('--wb-overview-compact-width')) || 240;
    const contentWidth = vertical ? availableWidth - 24 : Math.min(
      this.view === 'compact' ? compactWidth : this.panelWidth, availableWidth - 336,
    );
    const limit = Math.max(0, vertical ? availableHeight / 2 - 16 : availableHeight - 24);
    const surface = this.view === 'compact' ? this.compact : this.full;
    const visible = this.view !== 'closed';
    if (visible) {
      surface.hidden = false;
      surface.style.width = `${Math.max(0, contentWidth - 2)}px`;
      surface.style.maxHeight = `${Math.max(0, limit - 2)}px`;
    }
    const height = visible ? Math.min(limit, surface.getBoundingClientRect().height + 2) : 36;
    const geometry: Geometry = {
      width: visible ? contentWidth : 56,
      height,
      extent: visible ? vertical ? height + 16 : contentWidth + 16 : 0,
    };
    const geometryChanged = Object.entries(geometry).some(([key, value]) =>
      Math.abs(this.drivers[key as keyof Geometry].target - value) > 0.2);
    const facesChanged = this.drivers.full.target !== Number(this.view === 'full')
      || this.drivers.compact.target !== Number(this.view === 'compact');
    const readingWidth = `${Math.max(0, availableWidth - geometry.extent)}px`;
    const readingWidthChanged = Boolean(this.main?.hasAttribute('data-overview-gliding'))
      && this.main?.style.getPropertyValue('--overview-reading-width') !== readingWidth;
    if (this.placed && !geometryChanged && !facesChanged && !readingWidthChanged && !geometric) return;

    // Exiting surfaces stay painted until their own alpha reaches zero. They
    // are already inert/aria-hidden from the logical React state.
    this.frame.hidden = false;
    this.launcher.hidden = false;
    for (const [key, element] of [['full', this.full], ['compact', this.compact]] as const) {
      if (this.view === key || this.drivers[key].value > 0) element.hidden = false;
    }
    this.root.setAttribute('data-overview-motion', '');
    if (!geometric && !vertical && (geometryChanged || readingWidthChanged) && this.main) {
      const previousWidth = this.main.style.getPropertyValue('--overview-reading-width');
      const nextWidth = readingWidth;
      const column = this.main.querySelector<HTMLElement>('.chat-message-column, .chat-input-column');
      const before = column?.getBoundingClientRect().left;
      if (previousWidth !== nextWidth) this.main.style.setProperty('--overview-reading-width', nextWidth);
      this.main.setAttribute('data-overview-gliding', '');
      const after = column?.getBoundingClientRect().left;
      const layer = this.main.querySelector<HTMLElement>(':scope > .thread-conversation-content');
      const dx = before !== undefined && after !== undefined ? before - after : 0;
      if (layer && Math.abs(dx) > 0.5 && typeof layer.animate === 'function') {
        const animation = layer.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], {
          ...springTiming('glide'), composite: 'add',
        });
        this.readingMotions.add(animation);
        const done = () => this.readingMotions.delete(animation);
        void animation.finished.then(done, done);
      }
    } else if (geometric || vertical) this.unlockReading();

    for (const [key, value] of Object.entries(geometry)) {
      const driver = this.drivers[key as keyof Geometry];
      // Reduced motion closes through opacity at its original geometry.
      if (geometric && level === 'reduced' && !visible && this.placed && key !== 'extent') continue;
      this.move(driver, value, geometric);
    }
    this.move(this.drivers.reveal, Number(visible), instant);
    this.move(this.drivers.full, Number(this.view === 'full'), instant);
    this.move(this.drivers.compact, Number(this.view === 'compact'), instant);
    this.placed = true;
    this.paint();
  }

  private move(driver: SpringDriver, target: number, instant: boolean): void {
    if (instant) driver.jump(target);
    else if (driver.target !== target) driver.to(target);
  }

  private schedulePaint(): void {
    this.painting ??= requestAfterFrame(() => { this.painting = null; this.paint(); });
  }

  private paint(): void {
    if (!this.placed) return;
    const { width, height, extent, reveal, full, compact } = this.drivers;
    const moving = Object.values(this.drivers).some(driver => driver.active);
    const motion = this.level;
    this.root.style.width = this.vertical ? '100%' : `${Math.max(0, extent.value)}px`;
    this.root.style.height = this.vertical ? `${Math.max(0, extent.value)}px` : '100%';
    this.frame.style.width = `${Math.max(0, width.value)}px`;
    this.frame.style.height = `${Math.max(0, height.value)}px`;
    this.frame.style.opacity = String(clamp(reveal.value * 2));
    this.frame.style.translate = motion === 'full' ? `${(1 - reveal.value) * 12}px ${(1 - reveal.value) * -4}px` : '';
    this.launcher.style.opacity = String(clamp(1 - reveal.value * 2));
    for (const [driver, element] of [[full, this.full], [compact, this.compact]] as const) {
      element.style.opacity = String(clamp((driver.value - 0.2) / 0.8));
      element.style.translate = motion === 'full' ? `0 ${(1 - clamp(driver.value)) * 6}px` : '';
    }
    if (moving) return;
    this.frame.hidden = this.view === 'closed';
    this.full.hidden = this.view !== 'full';
    this.compact.hidden = this.view !== 'compact';
    this.launcher.hidden = this.view !== 'closed';
    this.root.removeAttribute('data-overview-motion');
    this.unlockReading();
  }

  private handoffFocus(): void {
    const active = this.root.ownerDocument.activeElement;
    if (!active || !this.root.contains(active)) return;
    const target = this.view === 'closed' ? this.launcher : this.view === 'full' ? this.full : this.compact;
    if (target.contains(active)) return;
    target.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
  }

  private unlockReading(): void {
    for (const animation of this.readingMotions) animation.cancel();
    this.readingMotions.clear();
    this.main?.removeAttribute('data-overview-gliding');
    this.main?.style.removeProperty('--overview-reading-width');
  }

  dispose(): void {
    this.observer?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.pending?.cancel();
    this.painting?.cancel();
    for (const driver of Object.values(this.drivers)) driver.stop();
    this.unlockReading();
    this.root.removeAttribute('data-overview-motion');
  }
}

export function useWorkOverviewMotion(root: React.RefObject<HTMLElement | null>, view: WorkOverviewView, width: number, resizing: boolean): void {
  const level = useMotionLevel();
  const motion = React.useRef<OverviewMotion | null>(null);
  React.useLayoutEffect(() => {
    if (!root.current?.parentElement) return;
    const controller = new OverviewMotion(root.current, view, width, level);
    motion.current = controller;
    return () => { controller.dispose(); motion.current = null; };
    // The retained controller receives new targets below, without resetting velocity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  React.useLayoutEffect(() => { motion.current?.set(view, width, resizing, level); }, [view, width, resizing, level]);
}
