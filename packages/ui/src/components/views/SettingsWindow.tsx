import React from 'react';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from './SettingsView';
import type { RecentPointer } from '@/lib/motion/pointer';

/** A workspace surface, not a dialog: chrome remains usable and the retained
 * conversation/editor stays mounted in its original shell. */
export function SettingsWindow({ onClose }: { onClose(origin?: RecentPointer): void }) {
  const { t } = useI18n();
  const main = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    const trigger = document.activeElement;
    main.current?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <main ref={main} tabIndex={-1} aria-label={t('settings.view.home.title')} className="min-h-0 min-w-0 flex-1 overflow-hidden outline-none">
    <SettingsView onClose={onClose} />
  </main>;
}
