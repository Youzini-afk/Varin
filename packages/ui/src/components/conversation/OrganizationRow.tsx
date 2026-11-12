import React from 'react';
import { VARIN_CONVERSATION_SLOTS } from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { SwapIcon } from '@/components/motion/SwapIcon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { pauseLoopsOffscreen } from '@/lib/motion/loops';
import { renderFirstWorkbenchMatch, useWorkbenchMatchRenderers } from '@/lib/extensions/workbench-registry';
import type { SidebarConversation, ConversationSessionAttentionState } from './sidebarCatalog';

function Decoration({ session, current, attention }: { session: SidebarConversation; current: boolean; attention?: ConversationSessionAttentionState }) {
  const renderers = useWorkbenchMatchRenderers<{ attention?: ConversationSessionAttentionState; busy: boolean; current: boolean; pinned: boolean; session: SidebarConversation }>('session-decoration', VARIN_CONVERSATION_SLOTS.sessionDecorations);
  return <>{renderFirstWorkbenchMatch(renderers, { attention, busy: session.busy, current, pinned: session.pinned, session })}</>;
}

/** One quiet navigation row, with the existing attention, decoration and motion contracts. */
export function OrganizationRow({ id, title, icon, origin, active, container, expanded, expandable, selected, selecting, busy, waiting, attention, pinned, recent, path, time, actions, summary, onOpen, onToggle, onSelect, onKeyDown }: {
  id: string; title: string; icon: React.ReactNode; origin?: React.ReactNode; actions: React.ReactNode;
  active?: boolean; container?: boolean; expanded: boolean; expandable: boolean; selected: boolean; selecting: boolean;
  busy?: boolean; waiting?: boolean; attention?: ConversationSessionAttentionState; pinned?: boolean;
  recent?: boolean; path?: string; time?: string; summary?: SidebarConversation;
  onOpen(): void; onToggle(): void; onSelect(): void; onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
}) {
  const { t } = useI18n();
  const status = waiting ? 'waiting' : busy ? 'busy' : attention?.kind ?? (pinned ? 'pinned' : 'none');
  const rowActions = <div className="organization-row-actions">{actions}</div>;
  return <div ref={pauseLoopsOffscreen} role="treeitem" tabIndex={0} data-sidebar-row={id} data-current={active || undefined}
    data-container={container || undefined} data-recent={recent || undefined} aria-expanded={expandable ? expanded : undefined}
    aria-selected={selected || !!active} onKeyDown={onKeyDown}
    className={cn('organization-row group/organization corner-continuous', (active || selected) && 'bg-interactive-selection text-foreground')}>
    <button type="button" className="organization-chevron" aria-expanded={expandable ? expanded : undefined}
      aria-label={t(expanded ? 'organization.collapse' : 'organization.expand', { name: title })} disabled={!expandable} onClick={onToggle}>
      <Icon name="arrow-right-s" className={cn('size-3 transition-transform duration-[var(--motion-dur-glide)] ease-[var(--motion-ease-glide)]', expanded && 'rotate-90', !expandable && 'invisible')} />
    </button>
    {selecting && <button type="button" role="checkbox" aria-checked={selected} aria-label={t('organization.selectName', { name: title })} className="organization-icon-button size-5" onClick={onSelect}><Icon name={selected ? 'checkbox' : 'checkbox-blank'} className="size-3.5" /></button>}
    <button type="button" className="organization-row-main typography-ui-label" title={title} aria-current={active ? 'page' : undefined} onClick={selecting ? onSelect : onOpen}>
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block truncate">{title}</span>{path && <span className="organization-row-path block truncate" title={path}>{path}</span>}</span>
    </button>
    {origin}
    {summary && <Decoration session={summary} current={!!active} attention={attention} />}
    <SwapIcon swapKey={status} className="shrink-0">
      {waiting ? <Icon name="question" className="mx-0.5 size-3.5 text-[var(--status-warning)]" aria-label={t('chat.questionCard.inputNeeded')} />
        : busy ? <span className="mx-1 size-1.5 rounded-full bg-primary" aria-label={t('sessions.sidebar.session.status.active')} />
          : attention?.kind === 'error' ? <Icon name="error-warning" className="size-3.5 text-[var(--status-error)]" />
            : attention ? <span className="mx-1 size-1.5 rounded-full bg-primary" aria-label={t('sessions.sidebar.session.status.unread')} />
              : pinned ? <Icon name="pushpin" className="size-3 text-muted-foreground/70" /> : null}
    </SwapIcon>
    {recent ? <div className="organization-row-trailing">
      {time && <span className="organization-row-time typography-micro text-muted-foreground">{time}</span>}
      {rowActions}
    </div> : rowActions}
  </div>;
}
