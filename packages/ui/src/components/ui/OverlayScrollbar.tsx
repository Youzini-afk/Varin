import React from "react";
import { cn } from "@/lib/utils";
import { announceScrollIntent, moveViewport, ownsScrollTarget, SCROLL_INTENT, SCROLL_PAINT, scrollKeyOffset, stopViewportScroll, viewportScrollTarget } from '@/lib/motion/scroll';
import {
  calculateOverlayThumbMetrics,
  EMPTY_OVERLAY_THUMB,
  type OverlayThumbMetrics,
} from "./overlayScrollbarMetrics";

type OverlayScrollbarProps = {
  containerRef: React.RefObject<HTMLElement | null>;
  trackRef?: React.RefObject<HTMLElement | null>;
  minThumbSize?: number;
  hideDelayMs?: number;
  className?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  suppressVisibility?: boolean;
  userIntentOnly?: boolean;
  interactiveTrack?: boolean;
  ariaLabel?: string;
  ariaControls?: string;
  onScrollIntent?(): void;
  onDragChange?(dragging: boolean): void;
};

const METRIC_EPSILON = 0.5;

const isSameThumbMetrics = (a: OverlayThumbMetrics, b: OverlayThumbMetrics): boolean => {
  return Math.abs(a.length - b.length) < METRIC_EPSILON && Math.abs(a.offset - b.offset) < METRIC_EPSILON;
};

const OverlayScrollbarComponent: React.FC<OverlayScrollbarProps> = ({
  containerRef,
  trackRef,
  minThumbSize = 32,
  hideDelayMs = 1000,
  className,
  disableHorizontal = false,
  observeMutations = true,
  suppressVisibility = false,
  userIntentOnly = false,
  interactiveTrack = false,
  ariaLabel,
  ariaControls,
  onScrollIntent,
  onDragChange,
}) => {
  const [visible, setVisible] = React.useState(false);
  const vertical = React.useRef<OverlayThumbMetrics>({ length: 0, offset: 0 });
  const horizontal = React.useRef<OverlayThumbMetrics>({ length: 0, offset: 0 });
  const verticalNode = React.useRef<HTMLDivElement>(null);
  const horizontalNode = React.useRef<HTMLDivElement>(null);
  const railNode = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState({ vertical: false, horizontal: false });
  const overflowRef = React.useRef(overflow);
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsFrameRef = React.useRef<number | null>(null);
  const isDraggingRef = React.useRef(false);
  const isHoveringRef = React.useRef(false);
  const isFocusedRef = React.useRef(false);
  const dragStartRef = React.useRef<{
    pointerX: number;
    pointerY: number;
    scrollTop: number;
    scrollLeft: number;
  }>({ pointerX: 0, pointerY: 0, scrollTop: 0, scrollLeft: 0 });
  const dragAxisRef = React.useRef<"vertical" | "horizontal" | null>(null);
  const observedElementsRef = React.useRef<Set<Element>>(new Set());

  const updateMetrics = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = container;
    const trackInset = 8;
    const track = trackRef?.current ?? container;
    const trackHeight = track.clientHeight;
    const trackWidth = track.clientWidth;

    const nextVertical = calculateOverlayThumbMetrics({
      viewportLength: clientHeight,
      contentLength: scrollHeight,
      scrollOffset: scrollTop,
      trackLength: trackHeight,
      minThumbSize,
      trackInset,
    });
    if (!isSameThumbMetrics(vertical.current, nextVertical)) vertical.current = nextVertical;
    if (verticalNode.current) {
      verticalNode.current.style.height = `${vertical.current.length}px`;
      verticalNode.current.style.transform = `translateY(${vertical.current.offset}px)`;
    }
    if (interactiveTrack) railNode.current?.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(1, scrollTop / Math.max(scrollHeight - clientHeight, 1))) * 100)));

    let nextHorizontal: OverlayThumbMetrics = EMPTY_OVERLAY_THUMB;
    if (!disableHorizontal && scrollWidth > clientWidth) {
      nextHorizontal = calculateOverlayThumbMetrics({
        viewportLength: clientWidth,
        contentLength: scrollWidth,
        scrollOffset: scrollLeft,
        trackLength: trackWidth,
        minThumbSize,
        trackInset,
      });
    }
    if (!isSameThumbMetrics(horizontal.current, nextHorizontal)) horizontal.current = nextHorizontal;
    if (horizontalNode.current) {
      horizontalNode.current.style.width = `${horizontal.current.length}px`;
      horizontalNode.current.style.transform = `translateX(${horizontal.current.offset}px)`;
    }
    if (overflowRef.current.vertical !== (nextVertical.length > 0) || overflowRef.current.horizontal !== (nextHorizontal.length > 0)) {
      overflowRef.current = { vertical: nextVertical.length > 0, horizontal: nextHorizontal.length > 0 };
      setOverflow(overflowRef.current);
    }
  }, [containerRef, disableHorizontal, interactiveTrack, minThumbSize, trackRef]);

  const scheduleMetricsUpdate = React.useCallback(() => {
    if (metricsFrameRef.current !== null) return;
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  const syncObservedElements = React.useCallback((container: HTMLElement, resizeObserver: ResizeObserver | null) => {
    if (!resizeObserver) {
      observedElementsRef.current.clear();
      return;
    }

    const nextObserved = new Set<Element>();
    nextObserved.add(container);
    Array.from(container.children).forEach((child) => {
      nextObserved.add(child);
    });

    observedElementsRef.current.forEach((element) => {
      if (!nextObserved.has(element)) {
        resizeObserver.unobserve(element);
      }
    });

    nextObserved.forEach((element) => {
      if (!observedElementsRef.current.has(element)) {
        resizeObserver.observe(element);
      }
    });

    observedElementsRef.current = nextObserved;
  }, []);

  const scheduleHide = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    if (isHoveringRef.current || isDraggingRef.current || isFocusedRef.current) {
      return;
    }
    hideTimeoutRef.current = setTimeout(() => setVisible(false), hideDelayMs);
  }, [hideDelayMs]);

  const markUserIntent = React.useCallback(() => {
    if (!suppressVisibility) { setVisible(true); scheduleHide(); }
  }, [scheduleHide, suppressVisibility]);

  const handleScroll = React.useCallback(() => {
    // A scroll event runs before paint; the thumb must not trail the text by a frame.
    updateMetrics();
    if (suppressVisibility && !isDraggingRef.current) { setVisible(false); return; }
    // User input owns visibility in reading panes; streamed output only moves the thumb.
    if (userIntentOnly) return;
    setVisible(true);
    scheduleHide();
  }, [scheduleHide, suppressVisibility, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateMetrics();
    setVisible(false);

    const onScroll = () => handleScroll();
    const onUserInput = (event: Event) => { if (ownsScrollTarget(container, event.target)) markUserIntent(); };
    const onIntent = (event: Event) => { if (event.target === container) markUserIntent(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'PageUp'
        || event.key === 'PageDown'
        || event.key === 'Home'
        || event.key === 'End'
        || event.key === ' '
      ) {
        onUserInput(event);
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener(SCROLL_PAINT, updateMetrics);
    container.addEventListener(SCROLL_INTENT, onIntent);
    if (userIntentOnly) {
      container.addEventListener("wheel", onUserInput, { passive: true });
      container.addEventListener("touchstart", onUserInput, { passive: true });
      container.addEventListener("touchmove", onUserInput, { passive: true });
      container.addEventListener("keydown", onKeyDown);
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleMetricsUpdate();
          })
        : null;
    syncObservedElements(container, resizeObserver);
    const track = trackRef?.current;
    const trackResizeObserver = track && track !== container && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => scheduleMetricsUpdate())
      : null;
    if (track && track !== container) trackResizeObserver?.observe(track);

    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            syncObservedElements(container, resizeObserver);
            scheduleMetricsUpdate();
          })
        : null;
    mutationObserver?.observe(container, { childList: true });

    const onInput = () => scheduleMetricsUpdate();
    const onLoad = () => scheduleMetricsUpdate();
    container.addEventListener("input", onInput, true);
    container.addEventListener("load", onLoad, true);

    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener(SCROLL_PAINT, updateMetrics);
      container.removeEventListener(SCROLL_INTENT, onIntent);
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("load", onLoad, true);
      if (userIntentOnly) {
        container.removeEventListener("wheel", onUserInput);
        container.removeEventListener("touchstart", onUserInput);
        container.removeEventListener("touchmove", onUserInput);
        container.removeEventListener("keydown", onKeyDown);
      }
      resizeObserver?.disconnect();
      trackResizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedElementsRef.current.clear();
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (metricsFrameRef.current) cancelAnimationFrame(metricsFrameRef.current);
      metricsFrameRef.current = null;
      if (isDraggingRef.current) onDragChange?.(false);
      isDraggingRef.current = false;
      isHoveringRef.current = false;
      isFocusedRef.current = false;
    };
  }, [containerRef, handleScroll, markUserIntent, observeMutations, onDragChange, scheduleMetricsUpdate, syncObservedElements, trackRef, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    if (!suppressVisibility) {
      return;
    }
    if (isDraggingRef.current) {
      return;
    }
    setVisible(false);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, [suppressVisibility]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    const container = containerRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopViewportScroll(container);
    onScrollIntent?.();
    announceScrollIntent(container, { input: 'scrollbar', direction: 0 });

    isDraggingRef.current = true;
    onDragChange?.(true);
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
    };
    dragAxisRef.current = axis;
    markUserIntent();
    setVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    const axis = dragAxisRef.current;
    if (axis === "vertical") {
      const { pointerY } = dragStartRef.current;
      const delta = event.clientY - pointerY;
      const trackLength = Math.max((trackRef?.current?.clientHeight ?? container.clientHeight) - 16, 0);
      const thumbTravel = Math.max(trackLength - vertical.current.length, 1);
      const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollTop += scrollDelta;
      dragStartRef.current.pointerY = event.clientY;
    } else if (axis === "horizontal") {
      const { pointerX } = dragStartRef.current;
      const delta = event.clientX - pointerX;
      const trackLength = Math.max((trackRef?.current?.clientWidth ?? container.clientWidth) - 16, 0);
      const thumbTravel = Math.max(trackLength - horizontal.current.length, 1);
      const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollLeft += scrollDelta;
      dragStartRef.current.pointerX = event.clientX;
    }
    updateMetrics();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    onDragChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragAxisRef.current = null;
    scheduleHide();
  };

  const handleThumbMouseEnter = React.useCallback(() => {
    isHoveringRef.current = true;
    setVisible(true);
    // Cancel any pending hide when hovering
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const handleThumbMouseLeave = React.useCallback(() => {
    isHoveringRef.current = false;
    // Schedule hide when leaving the thumb
    scheduleHide();
  }, [scheduleHide]);

  const showVertical = overflow.vertical;
  const showHorizontal = overflow.horizontal;
  if (!showVertical && !showHorizontal) return null;

  const trackInset = 8;
  const verticalThumb = <div
    ref={verticalNode}
    className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
    data-overlay-scrollbar-thumb="vertical"
    style={{ height: `${vertical.current.length}px`, top: trackInset, transform: `translateY(${vertical.current.offset}px)` }}
    onPointerDown={event => handlePointerDown(event, 'vertical')}
    onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
    onLostPointerCapture={handlePointerUp}
    onMouseEnter={interactiveTrack ? undefined : handleThumbMouseEnter}
    onMouseLeave={interactiveTrack ? undefined : handleThumbMouseLeave}
  />;
  const moveTo = (offset: number, animated = false) => {
    const container = containerRef.current;
    if (!container) return;
    onScrollIntent?.();
    announceScrollIntent(container, { input: 'scrollbar', direction: offset < container.scrollTop ? -1 : 1 });
    markUserIntent();
    setVisible(true);
    moveViewport(container, offset, animated);
    scheduleMetricsUpdate();
    scheduleHide();
  };

  return (
    <div
      className={cn("overlay-scrollbar", className)}
      aria-hidden={ariaLabel ? undefined : true}
      style={{ opacity: visible ? 1 : 0 }}
    >
      {showVertical && (interactiveTrack ? <div
        ref={railNode} className="overlay-scrollbar__track--vertical" role="scrollbar" tabIndex={0}
        aria-label={ariaLabel} aria-controls={ariaControls} aria-orientation="vertical"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, (containerRef.current?.scrollTop ?? 0) / Math.max((containerRef.current?.scrollHeight ?? 0) - (containerRef.current?.clientHeight ?? 0), 1)) * 100)}
        onMouseEnter={handleThumbMouseEnter} onMouseLeave={handleThumbMouseLeave}
        onFocus={() => { isFocusedRef.current = true; setVisible(true); if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current); }}
        onBlur={() => { isFocusedRef.current = false; scheduleHide(); }}
        onPointerDown={event => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          event.preventDefault();
          const container = containerRef.current;
          if (!container) return;
          const track = event.currentTarget.getBoundingClientRect();
          const travel = Math.max(track.height - trackInset * 2 - vertical.current.length, 1);
          moveTo((event.clientY - track.top - trackInset - vertical.current.length / 2) / travel * Math.max(container.scrollHeight - container.clientHeight, 0));
        }}
        onKeyDown={event => {
          const container = containerRef.current;
          if (!container) return;
          const next = scrollKeyOffset(container, event.key, event.shiftKey, viewportScrollTarget(container));
          if (next === undefined) return;
          event.preventDefault(); event.stopPropagation(); moveTo(next, true);
        }}
      >{verticalThumb}</div> : verticalThumb)}
      {showHorizontal && (
        <div
          ref={horizontalNode}
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
          data-overlay-scrollbar-thumb="horizontal"
          style={{
            width: `${horizontal.current.length}px`,
            left: `${trackInset}px`, transform: `translateX(${horizontal.current.offset}px)`,
            bottom: `${trackInset / 2}px`,
          }}
          onPointerDown={(e) => handlePointerDown(e, "horizontal")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={handleThumbMouseEnter}
          onMouseLeave={handleThumbMouseLeave}
        />
      )}
    </div>
  );
};

OverlayScrollbarComponent.displayName = "OverlayScrollbar";

export const OverlayScrollbar = OverlayScrollbarComponent;
