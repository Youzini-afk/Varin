import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

export const HarnessOverviewSection: React.FC<{
  title: string;
  icon: IconName;
  status?: React.ReactNode;
  defaultOpen?: boolean;
  attention?: boolean;
  children: React.ReactNode;
}> = ({ title, icon, status, defaultOpen = false, attention = false, children }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <details
      className="group border-b border-border/45 last:border-b-0"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left hover:bg-interactive-hover/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/45 text-muted-foreground',
            attention && 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
          )}
        >
          <Icon name={icon} className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">{title}</span>
        {status ? (
          <span className={cn(
            'shrink-0 typography-meta tabular-nums text-muted-foreground',
            attention && 'text-[var(--status-warning)]',
          )}>
            {status}
          </span>
        ) : null}
        <Icon
          name="arrow-right-s"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
};
