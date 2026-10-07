import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/** The Host emits operation metadata; this small launcher never acquires control or captures frames. */
export function PiComputerActivity({ sessionId, directory }: { sessionId: string; directory: string }) {
  const { t } = useI18n();
  const openTab = useUIStore(state => state.openContextPanelTab);
  const { activities: entries } = useComputerAutomation(sessionId);
  if (!entries.length) return null;
  return <div className="chat-input-column flex flex-wrap gap-1.5 pb-1.5">
    {entries.map(({ desktopId, activity }) => <button key={desktopId} type="button"
      className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 typography-micro text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t('chat.computerActivity.open', { app: activity.app })}
      onClick={() => openTab(directory, { mode: 'computer', dedupeKey: `desktop:${desktopId}`, targetPath: desktopId, label: activity.app })}>
      <Icon name={activity.status === 'running' ? 'loader-4' : activity.status === 'error' ? 'error-warning' : 'computer'}
        className={`size-3.5 shrink-0 ${activity.status === 'running' ? 'animate-spin' : ''}`} />
      <span className="truncate">{activity.app}</span>
      <span className="shrink-0 opacity-75">{t(activity.status === 'running' ? 'chat.computerActivity.working' : 'chat.computerActivity.view')}</span>
      <Icon name="arrow-right-s" className="size-3 shrink-0 opacity-60" />
    </button>)}
  </div>;
}
