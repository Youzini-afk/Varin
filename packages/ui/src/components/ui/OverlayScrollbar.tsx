import React from "react";
import { cn } from "@/lib/utils";
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

const USER_SCROLL_INTENT_WINDOW_MS = 1000;
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
  const [vertical, setVertical] = React.useState<OverlayThumbMetrics>({ length: 0, offset: 0 });
  const [horizontal, setHorizontal] = React.useState<OverlayThumbMetrics>({ length: 0, offset: 0 });
  const [scrollPercent, setScrollPercent] = React.useState(0);
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const metricsFrameRef = React.useRef<number | null>(null);
  const isDraggingRef = React.useRef(false);
  const isHoveringRef = React.useRef(false);
  const isFocusedRef = React.useRef(false);
  const lastUserIntentAtRef = React.useRef(0);
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
    setVertical((prev) => (isSameThumbMetrics(prev, nextVertical) ? prev : nextVertical));
    if (interactiveTrack) setScrollPercent(Math.round(Math.max(0, Math.min(1, scrollTop / Math.max(scrollHeight - clientHeight, 1))) * 100));

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
    setHorizontal((prev) => (isSameThumbMetrics(prev, nextHorizontal) ? prev : nextHorizontal));
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
    lastUserIntentAtRef.current = Date.now();
  }, []);

  const handleScroll = React.useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      updateMetrics();
      if (suppressVisibility && !isDraggingRef.current) {
        setVisible(false);
        return;
      }
      if (userIntentOnly && !isDraggingRef.current) {
        const hasRecentUserIntent = Date.now() - lastUserIntentAtRef.current <= USER_SCROLL_INTENT_WINDOW_MS;
        if (!hasRecentUserIntent) {
          setVisible(false);
          return;
        }
      }
      setVisible(true);
      scheduleHide();
    });
  }, [scheduleHide, suppressVisibility, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateMetrics();
    setVisible(false);

    const onScroll = () => handleScroll();
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
        markUserIntent();
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    if (userIntentOnly) {
      container.addEventListener("wheel", markUserIntent, { passive: true });
      container.addEventListener("touchstart", markUserIntent, { passive: true });
      container.addEventListener("touchmove", markUserIntent, { passive: true });
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
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("load", onLoad, true);
      if (userIntentOnly) {
        container.removeEventListener("wheel", markUserIntent);
        container.removeEventListener("touchstart", markUserIntent);
        container.removeEventListener("touchmove", markUserIntent);
        container.removeEventListener("keydown", onKeyDown);
      }
      resizeObserver?.disconnect();
      trackResizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedElementsRef.current.clear();
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (metricsFrameRef.current) cancelAnimationFrame(metricsFrameRef.current);
      frameRef.current = null;
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
    onScrollIntent?.();

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
      const { pointerY, scrollTop } = dragStartRef.current;
      const delta = event.clientY - pointerY;
      const trackLength = Math.max((trackRef?.current?.clientHeight ?? container.clientHeight) - 16, 0);
      const thumbTravel = Math.max(trackLength - vertical.length, 1);
      const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollTop = scrollTop + scrollDelta;
    } else if (axis === "horizontal") {
      const { pointerX, scrollLeft } = dragStartRef.current;
      const delta = event.clientX - pointerX;
      const trackLength = Math.max((trackRef?.current?.clientWidth ?? container.clientWidth) - 16, 0);
      const thumbTravel = Math.max(trackLength - horizontal.length, 1);
      const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollLeft = scrollLeft + scrollDelta;
    }
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

  const showVertical = vertical.length > 0;
  const showHorizontal = horizontal.length > 0;
  if (!showVertical && !showHorizontal) return null;

  const trackInset = 8;
  const verticalThumb = <div
    className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
    data-overlay-scrollbar-thumb="vertical"
    style={{ height: `${vertical.length}px`, top: trackInset, transform: `translateY(${vertical.offset}px)`, right: trackInset / 2 }}
    onPointerDown={event => handlePointerDown(event, 'vertical')}
    onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
    onLostPointerCapture={handlePointerUp}
    onMouseEnter={interactiveTrack ? undefined : handleThumbMouseEnter}
    onMouseLeave={interactiveTrack ? undefined : handleThumbMouseLeave}
  />;
  const moveTo = (offset: number) => {
    const container = containerRef.current;
    if (!container) return;
    onScrollIntent?.();
    markUserIntent();
    setVisible(true);
    container.scrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, offset));
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
        className="overlay-scrollbar__track--vertical" role="scrollbar" tabIndex={0}
        aria-label={ariaLabel} aria-controls={ariaControls} aria-orientation="vertical"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={scrollPercent}
        onMouseEnter={handleThumbMouseEnter} onMouseLeave={handleThumbMouseLeave}
        onFocus={() => { isFocusedRef.current = true; setVisible(true); if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current); }}
        onBlur={() => { isFocusedRef.current = false; scheduleHide(); }}
        onPointerDown={event => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          event.preventDefault();
          const container = containerRef.current;
          if (!container) return;
          const track = event.currentTarget.getBoundingClientRect();
          const travel = Math.max(track.height - trackInset * 2 - vertical.length, 1);
          moveTo((event.clientY - track.top - trackInset - vertical.length / 2) / travel * Math.max(container.scrollHeight - container.clientHeight, 0));
        }}
        onKeyDown={event => {
          const container = containerRef.current;
          if (!container) return;
          let next: number;
          switch (event.key) {
            case 'ArrowUp': next = container.scrollTop - 40; break;
            case 'ArrowDown': next = container.scrollTop + 40; break;
            case 'PageUp': next = container.scrollTop - container.clientHeight; break;
            case 'PageDown': next = container.scrollTop + container.clientHeight; break;
            case 'Home': next = 0; break;
            case 'End': next = container.scrollHeight; break;
            default: return;
          }
          event.preventDefault(); event.stopPropagation(); moveTo(next);
        }}
      >{verticalThumb}</div> : verticalThumb)}
      {showHorizontal && (
        <div
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
          data-overlay-scrollbar-thumb="horizontal"
          style={{
            width: `${horizontal.length}px`,
            left: `${trackInset + horizontal.offset}px`,
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
