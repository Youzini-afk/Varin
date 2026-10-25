import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "text-foreground file:text-foreground placeholder:text-muted-foreground selection:bg-interactive-selection selection:text-interactive-selection-foreground bg-transparent appearance-none flex h-9 w-full min-w-0 rounded-md border border-input px-3 py-1 typography-markdown outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:typography-ui-label file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:typography-ui-label",
        "transition-[border-color,box-shadow] hover:border-[var(--interactive-border-hover)]",
        "focus:border-[var(--interactive-border-focus)] focus:ring-2 focus:ring-[var(--interactive-focus-ring)]",
        "aria-invalid:border-[var(--status-error)] aria-invalid:focus:ring-[var(--status-error-border)]",
        className
      )}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      {...props}
    />
  )
}

export { Input }
