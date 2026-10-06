import React from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type OverviewPeekSection = 'questions' | 'review' | 'plan' | 'outputs' | 'threads' | 'sources' | 'memory';
export interface OverviewPeekRow {
  id: string;
  section: OverviewPeekSection;
  icon: IconName;
  label: string;
  value?: React.ReactNode;
  tone?: 'attention' | 'success';
  progress?: number;
}

function OverviewSurface({ compact, label, children }: {
  compact: boolean; label: string; children: React.ReactNode;
}) {
  const present = useIsPresent();
  const reduced = usePrefersReducedMotion();
  return <motion.section aria-label={label} inert={!present} aria-hidden={!present || undefined}
    initial={{ opacity: 0, y: -6, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: -4, scale: 0.99 }}
    transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
    style={{ transformOrigin: 'top right' }}
    className={cn('pointer-events-auto mt-3 flex flex-col overflow-hidden rounded-xl border border-border/70 shadow-lg',
      compact ? 'workbench-overview-peek max-h-[min(55dvh,24rem)] w-[min(16rem,calc(100cqi-1.5rem))]'
        : 'max-h-[min(72dvh,46rem)] w-[min(20rem,calc(100cqi-1.5rem))] bg-background/96 backdrop-blur-xl')}
    {...(compact ? { 'data-harness-overview-peek': true } : { 'data-harness-overview-floating': true })}>
    {children}
  </motion.section>;
}

/** The full overview and the small monitor share native projections and session choices. */
export function HarnessOverviewControl({ open, compactOpen, attention, onOpenChange, onCompactChange, rows, onSelect, children }: {
  open: boolean;
  compactOpen: boolean;
  attention: boolean;
  onOpenChange(open: boolean): void;
  onCompactChange(open: boolean): void;
  rows: readonly OverviewPeekRow[];
  onSelect(section: OverviewPeekSection): void;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const compactTrigger = React.useRef<HTMLButtonElement>(null);
  const fullTrigger = React.useRef<HTMLButtonElement>(null);
  const closeCompact = () => { onCompactChange(false); compactTrigger.current?.focus(); };
  const label = t(open ? 'harness.overview.collapse' : 'harness.overview.expand');
  const openFull = (section?: OverviewPeekSection) => {
    if (section) onSelect(section); else onOpenChange(true);
    fullTrigger.current?.focus();
  };
  return <div className="pointer-events-none absolute right-3 top-2 z-40 flex flex-col items-end"
    onKeyDown={event => {
      if (compactOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeCompact();
      }
    }}>
    <div className="workbench-overview-launcher pointer-events-auto relative" data-peek-open={compactOpen}
      data-harness-overview-controls="true">
      <Tooltip>
        <TooltipTrigger asChild>
          <button ref={fullTrigger} type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-label={label}
            className={cn('workbench-icon-button relative flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              open && 'bg-interactive-selection text-foreground')}>
            <Icon name="stack" className="size-4" />
            {attention ? <span aria-hidden="true" className="absolute right-1 top-1 size-1 rounded-full bg-[var(--status-warning)]" /> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
      <button ref={compactTrigger} type="button" className="workbench-overview-peek-trigger"
        aria-expanded={compactOpen} aria-controls={compactOpen ? id : undefined}
        aria-label={t('harness.overview.peek')}
        onClick={() => onCompactChange(!compactOpen)}>
        <Icon name="arrow-down-s" className={cn('size-3 transition-transform', compactOpen && 'rotate-180')} />
      </button>
    </div>
    <AnimatePresence initial={false}>
      {compactOpen ? <OverviewSurface key="compact" compact label={t('harness.overview.peek')}>
        <div id={id} className="min-h-0 overflow-y-auto p-1.5">
          {rows.length ? rows.map(row => <button key={row.id} type="button" onClick={() => openFull(row.section)}
            className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <Icon name={row.icon} className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground',
              row.tone === 'success' && 'text-[var(--status-success)]', row.tone === 'attention' && 'text-[var(--status-warning)]')} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 typography-meta">
                <span className={cn('text-foreground', row.tone === 'attention' && 'text-[var(--status-warning)]')}>{row.label}</span>
                {row.value !== undefined ? <span className="ml-auto typography-micro tabular-nums text-muted-foreground">{row.value}</span> : null}
              </span>
              {row.progress !== undefined ? <span className="workbench-overview-peek-progress mt-2 block h-0.5 overflow-hidden rounded-full bg-interactive-hover">
                <span className={cn('block h-full rounded-full bg-foreground/35', row.tone === 'success' && 'bg-[var(--status-success)]/65')}
                  style={{ width: `${row.progress * 100}%` }} />
              </span> : null}
            </span>
          </button>) : <p className="px-2 py-3 typography-meta text-muted-foreground">{t('harness.overview.empty')}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-border/50 px-2 py-1.5">
          <button type="button" onClick={() => openFull()}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('harness.overview.details')}<Icon name="arrow-right-s" className="size-3" />
          </button>
          <button type="button" onClick={closeCompact} aria-label={t('dialog.common.actions.close')}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Icon name="close" className="size-3" />
          </button>
        </div>
      </OverviewSurface> : open && children ? <OverviewSurface key="full" compact={false} label={t('harness.overview.title')}>{children}</OverviewSurface> : null}
    </AnimatePresence>
  </div>;
}
