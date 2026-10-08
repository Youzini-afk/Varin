import * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";
import {
  dropdownMenuItemClass,
  dropdownMenuPopupClass,
  dropdownMenuSeparatorClass,
} from "./dropdown-menu.styles";

const ContextMenuPortalContext = React.createContext<HTMLElement | null>(null);

function ContextMenu({ onOpenChange, ...props }: React.ComponentProps<typeof BaseContextMenu.Root>) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  return <ContextMenuPortalContext.Provider value={portalContainer}>
    <BaseContextMenu.Root {...props} onOpenChange={(open, details) => {
      if (open) {
        const target = details.event.target;
        setPortalContainer(target instanceof Element
          ? target.closest<HTMLElement>('[data-slot="dialog-content"], [role="dialog"]') : null);
      }
      onOpenChange?.(open, details);
    }} />
  </ContextMenuPortalContext.Provider>;
}

function ContextMenuTrigger({ asChild, children, ...props }: React.ComponentProps<typeof BaseContextMenu.Trigger> & { asChild?: boolean }) {
  const render = asChild && React.isValidElement(children) ? { render: children as React.ReactElement } : { children };
  return <BaseContextMenu.Trigger {...props} {...render} />;
}

type ContentProps = {
  className?: string;
  positionerClassName?: string;
  children?: React.ReactNode;
} & React.ComponentProps<typeof BaseContextMenu.Popup>;

function ContextMenuContent({ className, positionerClassName, children, style, onContextMenu, ...props }: ContentProps) {
  const portalContainer = React.useContext(ContextMenuPortalContext);
  return (
    <BaseContextMenu.Portal container={portalContainer || undefined}>
      <BaseContextMenu.Positioner className={cn("app-region-no-drag z-50", positionerClassName)}>
        <BaseContextMenu.Popup
          data-slot="dropdown-menu-content"
          style={{
            backgroundColor: "var(--surface-elevated)",
            color: "var(--surface-elevated-foreground)",
            ...style,
          }}
          className={cn(dropdownMenuPopupClass, "overflow-y-auto", className)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onContextMenu?.(event);
          }}
          {...props}
        >
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof BaseContextMenu.Item>) {
  return <BaseContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...props} />;
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof BaseContextMenu.Separator>) {
  return <BaseContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...props} />;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
