import React from 'react';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from './SettingsView';

interface SettingsWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Settings rendered as a centered window with blurred backdrop.
 * Used for desktop and web (non-mobile) environments.
 */
export const SettingsWindow: React.FC<SettingsWindowProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const descriptionId = React.useId();

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) return;
        if (next) onOpenChange(true);
        else requestSettingsNavigation(() => onOpenChange(false));
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'fixed inset-0 z-50 bg-black/50 dark:bg-black/75',
            'motion-dialog-backdrop',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            aria-describedby={descriptionId}
            className={cn(
              'relative pointer-events-auto',
              'w-[94vw] max-w-[1440px] h-[90vh] max-h-[1000px]',
              'rounded-xl border shadow-none overflow-hidden origin-center',
              'bg-background',
              // Settles from 98.5% on glide; leaves on the exit tween.
              'motion-dialog',
              // Dim this window when a nested dialog (e.g. "Add a device") opens
              // on top of it, mirroring how the page behind a dialog is dimmed.
              'data-[nested-dialog-open]:brightness-[0.55] dark:data-[nested-dialog-open]:brightness-[0.4]',
            )}
          >
            <Dialog.Description id={descriptionId} className="sr-only">
              {t('settings.window.description')}
            </Dialog.Description>
            <SettingsView onClose={() => onOpenChange(false)} isWindowed animateEntrance />
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
