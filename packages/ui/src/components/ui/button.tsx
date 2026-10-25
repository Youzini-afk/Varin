import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Slot } from "@/components/ui/slot"

const TINT_DESTRUCTIVE = [
  "bg-[color-mix(in_srgb,var(--status-error)_7%,var(--background))]",
  "text-[var(--status-error)]",
  "border border-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--status-error)_11%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--status-error)_16%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--status-error)_20%,transparent)]",
].join(" ")

const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md typography-ui-label font-medium shrink-0 select-none",
    "transition-[background-color,border-color,color,opacity] outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: "border border-transparent bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] active:bg-[var(--primary-active)]",
        destructive: cn(
          TINT_DESTRUCTIVE,
          "focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        ),
        neutral:
          "bg-interactive-hover text-foreground border border-border hover:bg-interactive-active",
        outline:
          "bg-transparent text-foreground border border-border hover:bg-interactive-hover hover:text-foreground",
        // Selection is a localized theme accent, not a tint over the surrounding surface.
        chip: cn(
          "border border-border bg-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
          "aria-pressed:bg-interactive-selection aria-pressed:text-foreground aria-pressed:border-[var(--interactive-border-focus)]",
        ),
        secondary:
          "bg-interactive-hover text-foreground hover:bg-interactive-active",
        ghost:
          "text-foreground hover:bg-interactive-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-2.5 has-[>svg]:px-2",
        xs: "h-6 gap-1 px-2 typography-micro has-[>svg]:px-1.5 rounded",
        lg: "h-10 px-4 has-[>svg]:px-3.5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
