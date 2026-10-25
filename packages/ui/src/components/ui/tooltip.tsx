import * as React from "react"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"
import { tooltipGlideRef } from "./tooltipGlide"

const MOBILE_LONG_PRESS_DELAY = 600
const MOBILE_LONG_PRESS_CLOSE_DELAY = 1600
const MOBILE_LONG_PRESS_MOVE_TOLERANCE = 10

type LongPressTooltipContextValue = {
  /** This tooltip's own hover delay; the shared provider still groups it with its neighbours. */
  delay?: number;
  handlePointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  handlePointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  handlePointerEnd: () => void;
  handleClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  handleContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};

const LongPressTooltipContext = React.createContext<LongPressTooltipContextValue | null>(null)

type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

class TooltipPartBoundary extends React.Component<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }

    return this.props.children;
  }
}

/** The first tooltip waits this long, so passing over controls shows nothing. */
export const TOOLTIP_DELAY_MS = 520
/** Moving to another anchor within this long after a tooltip closes opens the next one at once. */
export const TOOLTIP_GROUP_MS = 400

type ProviderProps = React.ComponentProps<typeof BaseTooltip.Provider> & {
  delayDuration?: number;
  /** Radix name for the grouping window; Base UI calls it `timeout`. */
  skipDelayDuration?: number;
};

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  skipDelayDuration = TOOLTIP_GROUP_MS,
  delay,
  timeout,
  ...props
}: ProviderProps) {
  return (
    <BaseTooltip.Provider
      delay={delay ?? delayDuration}
      timeout={timeout ?? skipDelayDuration}
      {...props}
    />
  )
}

type TooltipRootProps = React.ComponentProps<typeof BaseTooltip.Root> & {
  delayDuration?: number
}

type TooltipChangeEventDetails = Parameters<NonNullable<TooltipRootProps['onOpenChange']>>[1]

function Tooltip({
  delayDuration,
  open,
  onOpenChange,
  ...props
}: TooltipRootProps) {
  const [longPressOpen, setLongPressOpen] = React.useState(false)
  const longPressTimeoutRef = React.useRef<number | null>(null)
  const closeTimeoutRef = React.useRef<number | null>(null)
  const startPointRef = React.useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = React.useRef(false)
  const controlled = open !== undefined
  const tooltipOpen = controlled ? open : longPressOpen

  const clearLongPressTimeout = React.useCallback(() => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current)
      longPressTimeoutRef.current = null
    }
  }, [])

  const clearCloseTimeout = React.useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
  }, [])

  const setTooltipOpen = React.useCallback((nextOpen: boolean) => {
    if (!controlled) {
      setLongPressOpen(nextOpen)
    }
  }, [controlled])

  const contextValue = React.useMemo<LongPressTooltipContextValue>(() => ({
    delay: delayDuration,
    handlePointerDown: (event) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return
      }

      clearLongPressTimeout()
      clearCloseTimeout()
      startPointRef.current = { x: event.clientX, y: event.clientY }

      longPressTimeoutRef.current = window.setTimeout(() => {
        if (controlled) {
          return
        }

        suppressClickRef.current = true
        setTooltipOpen(true)
      }, MOBILE_LONG_PRESS_DELAY)
    },
    handlePointerMove: (event) => {
      const startPoint = startPointRef.current

      if (!startPoint) {
        return
      }

      const movedX = Math.abs(event.clientX - startPoint.x)
      const movedY = Math.abs(event.clientY - startPoint.y)

      if (movedX > MOBILE_LONG_PRESS_MOVE_TOLERANCE || movedY > MOBILE_LONG_PRESS_MOVE_TOLERANCE) {
        clearLongPressTimeout()
        startPointRef.current = null
      }
    },
    handlePointerEnd: () => {
      clearLongPressTimeout()
      startPointRef.current = null

      if (suppressClickRef.current) {
        clearCloseTimeout()
        closeTimeoutRef.current = window.setTimeout(() => {
          suppressClickRef.current = false
          setTooltipOpen(false)
        }, MOBILE_LONG_PRESS_CLOSE_DELAY)
      }
    },
    handleClickCapture: (event) => {
      if (!suppressClickRef.current) {
        return
      }

      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    handleContextMenu: (event) => {
      if (!suppressClickRef.current) {
        return
      }

      event.preventDefault()
    },
  }), [clearCloseTimeout, clearLongPressTimeout, controlled, delayDuration, setTooltipOpen])

  React.useEffect(() => {
    return () => {
      clearLongPressTimeout()
      clearCloseTimeout()
    }
  }, [clearCloseTimeout, clearLongPressTimeout])

  const handleOpenChange = React.useCallback((nextOpen: boolean, event: TooltipChangeEventDetails) => {
    if (!controlled) {
      setLongPressOpen(nextOpen)
    }

    onOpenChange?.(nextOpen, event)
  }, [controlled, onOpenChange])

  // A per-tooltip delay goes to the trigger, not to a provider of its own, so
  // moving between neighbouring anchors still skips the wait.
  return (
    <LongPressTooltipContext.Provider value={contextValue}>
      <BaseTooltip.Root open={tooltipOpen} onOpenChange={handleOpenChange} {...props} />
    </LongPressTooltipContext.Provider>
  )
}

function TooltipTrigger({
  asChild,
  children,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClickCapture,
  onContextMenu,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Trigger> & { asChild?: boolean }) {
  const longPressTooltip = React.useContext(LongPressTooltipContext)
  const renderProps: AsChildRenderProps = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : { children };
  return (
    <TooltipPartBoundary fallback={children}>
      <BaseTooltip.Trigger
        data-slot="tooltip-trigger"
        delay={longPressTooltip?.delay}
        onPointerDown={(event) => {
          onPointerDown?.(event)
          longPressTooltip?.handlePointerDown(event)
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event)
          longPressTooltip?.handlePointerMove(event)
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event)
          longPressTooltip?.handlePointerEnd()
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event)
          longPressTooltip?.handlePointerEnd()
        }}
        onClickCapture={(event) => {
          longPressTooltip?.handleClickCapture(event)
          if (event.defaultPrevented) {
            return
          }

          onClickCapture?.(event)
        }}
        onContextMenu={(event) => {
          longPressTooltip?.handleContextMenu(event)
          if (event.defaultPrevented) {
            return
          }

          onContextMenu?.(event)
        }}
        {...props}
        {...renderProps}
      />
    </TooltipPartBoundary>
  )
}

type ContentProps = React.ComponentProps<typeof BaseTooltip.Popup> & {
  sideOffset?: number;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** `motion-tooltip-follow` slides a shared tooltip between its triggers. */
  positionerClassName?: string;
};

function TooltipContent({
  className,
  sideOffset = 0,
  side,
  align,
  positionerClassName,
  children,
  style,
  ...props
}: ContentProps) {
  return (
    <TooltipPartBoundary>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={sideOffset} side={side} align={align} className={cn("z-50", positionerClassName)}>
          <BaseTooltip.Popup
            data-slot="tooltip-content"
            className={cn(
              // `motion-popover` grows the tooltip from its anchor. A grouped
              // tooltip that opens without waiting (data-instant) appears in place.
              "bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] border border-border/60 motion-popover z-50 w-fit origin-[var(--transform-origin)] rounded-xl px-3 py-1.5 typography-meta text-balance overflow-hidden",
              className
            )}
            style={{ ...style }}
            {...props}
            // A tooltip opened at once next to the previous one slides over from it (tooltipGlide.ts).
            ref={tooltipGlideRef}
          >
            {children}
            <BaseTooltip.Arrow className="fill-[var(--surface-elevated)] z-50 size-2" />
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </TooltipPartBoundary>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
