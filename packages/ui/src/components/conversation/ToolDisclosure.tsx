import React from 'react';
import { timelinePresentationCache } from './timelinePresentationCache';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ChatToolExecutionState } from './types';
import { DisclosureContext, ExpandedToolContext, TimelineSessionContext, useToolDisclosureChoices } from './toolDisclosureContext';

export function ToolDisclosureScope({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const parent = React.useContext(DisclosureContext);
  const [choices] = React.useState(() => timelinePresentationCache(sessionId, 'tools', () => new Map<string, boolean>()));
  return parent ? <>{children}</> : <TimelineSessionContext.Provider value={sessionId}>
    <DisclosureContext.Provider value={choices}>{children}</DisclosureContext.Provider>
  </TimelineSessionContext.Provider>;
}
export function ToolDisclosure({ id, children, className, initiallyExpanded = false, onExpanded, open: controlledOpen, onOpenChange }: {
  id: string; children: React.ReactNode; className?: string; initiallyExpanded?: boolean; onExpanded?(value: boolean): void;
  open?: boolean; onOpenChange?(value: boolean): void;
}) {
  const choices = useToolDisclosureChoices();
  const nestedDetail = React.useContext(ExpandedToolContext);
  const defaultExpanded = initiallyExpanded || nestedDetail && id.startsWith('tool:');
  const [localExpanded, setExpanded] = React.useState(() => choices?.get(id) ?? defaultExpanded);
  const expanded = controlledOpen ?? localExpanded;
  const [visited, setVisited] = React.useState(expanded);
  React.useEffect(() => { if (!choices?.has(id)) setExpanded(defaultExpanded); }, [choices, id, defaultExpanded]);
  React.useEffect(() => { if (expanded) setVisited(true); onExpanded?.(expanded); }, [expanded, onExpanded]);
  return <details className={cn('workbench-disclosure', className)} open={expanded} data-conversation-tool-disclosure={id}
    onToggle={event => {
      if (event.target !== event.currentTarget) return;
      const open = event.currentTarget.open;
      choices?.set(id, open); setExpanded(open);
      if (open !== expanded) onOpenChange?.(open);
    }}>{expanded || visited ? children : React.Children.toArray(children).slice(0, 1)}</details>;
}

export function ToolStatus({ status, stopped = false, generating = false }: { status: ChatToolExecutionState['status']; stopped?: boolean; generating?: boolean }) {
  const { t } = useI18n();
  return <span className={cn('tool-action-status typography-micro', status === 'error' && 'text-destructive',
    status === 'unknown' && 'text-[var(--status-warning)]')} data-status={status} role={status === 'error' || status === 'waiting' ? 'status' : undefined}>
    <Icon name={stopped ? 'stop' : status === 'running' ? 'loader-4' : status === 'success' ? 'check' : status === 'error' || status === 'unknown'
      ? 'error-warning' : status === 'cancelled' ? 'close' : status === 'waiting' ? 'question' : 'time'}
      className={cn('size-3 shrink-0', status === 'running' && !stopped && 'animate-spin motion-reduce:animate-none')} />
    <span key={generating ? 'generating' : stopped ? 'stopping' : status} className="workbench-status-arrival">{t(generating ? 'chat.tools.preparingCall' : stopped ? 'chat.children.stopping' : ('chat.timeline.tools.' + status) as I18nKey)}</span>
  </span>;
}
