import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';

/** The Agent column follows the selected native Thread without owning execution. */
export function IdeSessionHeader({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const title = useThreadStore(state => state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId)?.title);
  return <div className="ide-agent-header flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <span className="min-w-0 flex-1 truncate typography-ui-label font-medium" title={title}>{title || t('sessions.sidebar.session.untitled')}</span>
    {children}
  </div>;
}
