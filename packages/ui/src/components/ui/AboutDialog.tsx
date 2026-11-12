import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { runtimeFetch } from '@varin/application-client';

const LICENSE_URL = 'https://github.com/Youzini-afk/Varin/blob/main/LICENSE';
const CONTACT_EMAIL = 'varin@astrmira.com';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDiagnostics: () => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  open,
  onOpenChange,
  onOpenDiagnostics,
}) => {
  const { t } = useI18n();
  const [version, setVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const fetchVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info');
        if (response.ok) {
          const data = await response.json();
          if (typeof data.varinVersion === 'string' && data.varinVersion.trim()) {
            setVersion(data.varinVersion);
            return;
          }
        }
      } catch {
        // Fall back to the native shell version when the web server is unavailable.
      }

      setVersion(await getDesktopAppVersion());
    };

    void fetchVersion();
  }, [open]);

  const displayVersion = version;

  const handleOpenDiagnostics = React.useCallback(() => {
    onOpenChange(false);
    onOpenDiagnostics();
  }, [onOpenChange, onOpenDiagnostics]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-6">
        <div className="flex flex-col items-center text-center space-y-4">
          <VarinLogo width={64} height={64} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Varin</h2>
            <div className="space-y-0.5 typography-meta text-muted-foreground">
              {displayVersion && (
                <p>{t('aboutDialog.versionLabel', { version: displayVersion })}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleOpenDiagnostics}
              className="typography-meta text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('aboutDialog.actions.openDiagnostics')}
            </button>
            <p className="typography-micro text-muted-foreground">
              {t('aboutDialog.diagnosticsDescription')}
            </p>
          </div>

          <div className="flex flex-col items-center gap-2 pt-2">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <a
                href="https://github.com/Youzini-afk/Varin"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
              >
                <Icon name="github-fill" className="h-4 w-4" />
                <span>GitHub</span>
              </a>
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
              >
                <Icon name="scales-3" className="h-4 w-4" />
                <span>AGPL-3.0</span>
              </a>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
              >
                <Icon name="send-plane" className="h-4 w-4 shrink-0" />
                <span className="break-all">{CONTACT_EMAIL}</span>
              </a>
            </div>
          </div>

          <p className="typography-meta text-muted-foreground/60 pt-2">
            {t('aboutDialog.footerNote')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};
