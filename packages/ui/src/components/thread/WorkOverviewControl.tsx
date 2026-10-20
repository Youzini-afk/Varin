import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { cn } from '@/lib/utils';

export type OverviewPeekSection = 'questions' | 'review' | 'plan' | 'outputs' | 'threads' | 'sources' | 'memory' | 'computer' | 'context' | 'goals' | 'followups' | 'recovery' | 'research' | 'operations';
export interface OverviewPeekRow {
  id: string; section: OverviewPeekSection; icon: IconName; label: string; value?: React.ReactNode;
  description?: string; tone?: 'attention' | 'success'; progress?: number;
  action?: { label: string; disabled?: boolean; run(): void };
}

/** Disclosure and geometry stay outside the streaming timeline's subscriptions. */
export function WorkOverviewControl({ open, compactOpen, attention, onOpenChange, onCompactChange, rows, onSelect, children,
  status, compactContent, detailTitle, onBack, headerActions }: {
  open: boolean; compactOpen: boolean; attention: boolean;
  onOpenChange(open: boolean): void; onCompactChange(open: boolean): void;
  rows: readonly OverviewPeekRow[]; onSelect(section: OverviewPeekSection): void; children?: React.ReactNode;
  status?: React.ReactNode; compactContent?: React.ReactNode; detailTitle?: string; onBack?(): void; headerActions?: React.ReactNode;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const root = React.useRef<HTMLElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const width = useWorkOverviewStore(state => state.width);
  const setWidth = useWorkOverviewStore(state => state.setWidth);
  const drag = React.useRef<{ x: number; width: number } | null>(null);
  const fitWidth = (value: number) => Math.max(280, Math.min(value, Math.max(280, (root.current?.parentElement?.clientWidth ?? 960) - 320)));
  const close = () => { onCompactChange(false); onOpenChange(false); trigger.current?.focus(); };
  const label = t(open ? 'harness.overview.collapse' : 'harness.overview.expand');
  const openFull = (section?: OverviewPeekSection) => { if (section) onSelect(section); else onOpenChange(true); };
  const iconButton = 'workbench-icon-button flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return <aside ref={root} className="workbench-overview-control pointer-events-none relative flex h-full min-h-0 shrink-0 flex-col items-end"
    style={{ '--wb-overview-full-width': width + 'px' } as React.CSSProperties} data-view={compactOpen ? 'compact' : open ? 'full' : 'closed'}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (onBack && open && detailTitle) onBack(); else close(); } }}>
    <div className="workbench-overview-launcher pointer-events-auto absolute right-3 top-2 z-40 flex items-center" data-peek-open={compactOpen} data-harness-overview-controls="true" hidden={open}>
      <Tooltip><TooltipTrigger asChild><button ref={trigger} type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-label={label} className={cn(iconButton, 'relative size-9')}>
        <Icon name="stack" className="size-5" />{attention && <span className="absolute right-1 top-1 size-1 rounded-full bg-status-warning" />}
      </button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>
      <button type="button" className={cn(iconButton, 'w-5')} aria-expanded={compactOpen} aria-controls={compactOpen ? id : undefined} aria-label={t('harness.overview.peek')} onClick={() => onCompactChange(!compactOpen)}><Icon name="arrow-down-s" className="size-3" /></button>
    </div>
    {compactOpen && <section id={id} aria-label={t('harness.overview.peek')} data-harness-overview-peek="true" className="workbench-overview-peek pointer-events-auto absolute right-3 top-14 z-40 flex max-h-[calc(100%-4rem)] flex-col overflow-hidden rounded-xl border border-border shadow-xl">
      <div className="min-h-0 overflow-y-auto p-4">
        {status}
        {compactContent ?? rows.map(row => <button key={row.id} type="button" onClick={() => openFull(row.section)} className="mt-3 flex w-full items-start gap-2 rounded-md py-1.5 text-left hover:bg-interactive-hover">
          <Icon name={row.icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 typography-meta"><span className="flex justify-between gap-2"><span>{row.label}</span><span className="text-muted-foreground">{row.value}</span></span>{row.description && <span className="mt-1 block truncate typography-micro text-muted-foreground">{row.description}</span>}</span>
        </button>)}
        {!status && !rows.length && !compactContent && <p className="typography-meta text-muted-foreground">{t('harness.overview.empty')}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border/50 px-3 py-2"><button type="button" onClick={() => openFull()} className="flex flex-1 items-center gap-2 rounded-md p-1 typography-meta hover:bg-interactive-hover">{t('harness.overview.details')}<Icon name="external-link" className="size-3.5" /></button><button type="button" onClick={close} className={iconButton} aria-label={t('dialog.common.actions.close')}><Icon name="close" className="size-4" /></button></div>
    </section>}
    <section aria-label={t('harness.overview.title')} hidden={!open || compactOpen} data-harness-overview-panel="true" className="workbench-overview-full pointer-events-auto flex h-full min-h-0 w-full flex-col bg-background">
      <div role="separator" aria-orientation="vertical" aria-label={t('harness.overview.resize')} aria-valuemin={280} aria-valuemax={Math.max(width, fitWidth(Number.MAX_SAFE_INTEGER))} aria-valuenow={Math.round(width)} tabIndex={0} className="workbench-overview-resizer"
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(fitWidth(width + (event.key === 'ArrowLeft' ? 16 : -16))); } }}
        onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) setWidth(fitWidth(drag.current.width + drag.current.x - event.clientX)); }}
        onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }} />
      <header className="flex h-14 shrink-0 items-center gap-1 px-3">
        {onBack && detailTitle && <button type="button" className={iconButton} onClick={onBack} aria-label={t('harness.overview.back')}><Icon name="arrow-left" className="size-4" /></button>}
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{detailTitle ?? t('harness.overview.title')}</span>{headerActions}
        <button type="button" className={iconButton} onClick={() => onCompactChange(true)} aria-label={t('harness.overview.peek')}><Icon name="arrow-down-s" className="size-4" /></button>
        <button type="button" className={iconButton} onClick={close} aria-label={t('harness.overview.collapse')}><Icon name="close" className="size-4" /></button>
      </header>
      <div className="thread-work-overview min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
    </section>
  </aside>;
}
