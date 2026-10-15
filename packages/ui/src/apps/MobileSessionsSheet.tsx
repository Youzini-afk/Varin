import React from 'react';
import { ThreadSidebar } from '@/components/thread/ThreadSidebar';
import { useThreadStore } from '@/stores/useThreadStore';
import { MobileSurfaceShell } from './MobileSurfaceShell';
import { useI18n } from '@/lib/i18n';

export function MobileSessionsSheet({ open, onOpenChange, variant = 'sheet' }: {
  open: boolean; onOpenChange(open: boolean): void; variant?: 'sheet' | 'sidebar' | 'content';
}) {
  const { t } = useI18n();
  const previous = React.useRef(useThreadStore.getState().selectedIdentity);
  React.useEffect(() => useThreadStore.subscribe(state => {
    if (state.selectedIdentity !== previous.current) { previous.current = state.selectedIdentity; onOpenChange(false); }
  }), [onOpenChange]);
  if (!open) return null;
  const content = <ThreadSidebar mobileVariant />;
  return variant === 'sheet' ? <MobileSurfaceShell open title={t('mobile.sessions.sheet.title')} onClose={() => onOpenChange(false)}>{content}</MobileSurfaceShell> : content;
}
