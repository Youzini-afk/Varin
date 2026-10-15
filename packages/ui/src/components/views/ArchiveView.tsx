import React from 'react';
import { ThreadSidebar } from '@/components/thread/ThreadSidebar';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

export const ArchiveView: React.FC = () => {
  const open = useUIStore(state => state.isArchivePageOpen);
  const { t } = useI18n();
  return open ? <div className="absolute inset-0 z-10 flex flex-col bg-background">
    <div className="flex items-center gap-2 px-4 pt-3">
      <Button variant="ghost" size="sm" onClick={() => useUIStore.getState().setArchivePageOpen(false)} aria-label={t('onboarding.common.actions.back')}><Icon name="arrow-left" className="size-4" /></Button>
      <h1 className="typography-ui-label font-medium">{t('sessions.archivePage.title')}</h1>
    </div>
    <div className="min-h-0 flex-1"><ThreadSidebar archived /></div>
  </div> : null;
};
