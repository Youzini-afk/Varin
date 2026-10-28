import React from 'react';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { VarinLogo } from '@/components/ui/VarinLogo';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@varin/application-client';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import {
  SettingsCheckboxRow,
  SettingsSection,
  SETTINGS_BRAND_TITLE_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/Youzini-afk/Varin';
const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

const MIN_CHECKING_DURATION = 800; // ms

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const { t } = useI18n();
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(initialUpdateDialogOpen);
  const [showChecking, setShowChecking] = React.useState(false);
  const [varinVersion, setVarinVersion] = React.useState<string | null>(null);
  const updateStore = useUpdateStore(useShallow((s) => ({
    info: s.info,
    checking: s.checking,
    available: s.available,
    error: s.error,
    downloading: s.downloading,
    downloaded: s.downloaded,
    restarting: s.restarting,
    progress: s.progress,
    runtimeType: s.runtimeType,
    lastChecked: s.lastChecked,
    checkForUpdates: s.checkForUpdates,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));
  const autoUpdateChecksEnabled = usePreferencesStore((state) => state.settingsAutoUpdateChecksEnabled);
  const setAutoUpdateChecksEnabled = usePreferencesStore((state) => state.setSettingsAutoUpdateChecksEnabled);
  const { isMobile } = useDeviceInfo();

  const currentVersion = varinVersion
    || updateStore.info?.currentVersion
    || t('settings.varin.about.state.unknown');

  React.useEffect(() => {
    let cancelled = false;

    const loadVarinVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`System info request failed with ${response.status}`);
        const data = await response.json().catch(() => null) as { varinVersion?: unknown } | null;
        const version = typeof data?.varinVersion === 'string' && data.varinVersion.trim().length > 0
          ? data.varinVersion.trim()
          : null;
        if (!version) throw new Error('System info did not include a version');
        if (!cancelled) setVarinVersion(version);
      } catch {
        const nativeVersion = await getDesktopAppVersion();
        if (!cancelled) setVarinVersion(nativeVersion);
      }
    };

    void loadVarinVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  // Only a user-initiated check should produce the "latest version" toast.
  // Background polling uses the same store and must remain quiet.
  const didInitiateManualCheck = React.useRef(false);

  const handleCheckForUpdates = React.useCallback(() => {
    didInitiateManualCheck.current = true;
    void updateStore.checkForUpdates();
  }, [updateStore]);

  const handleAutoUpdateChecksChange = React.useCallback((enabled: boolean) => {
    setAutoUpdateChecksEnabled(enabled);
    void updateDesktopSettings({ autoUpdateChecksEnabled: enabled });
    if (enabled) {
      void updateStore.checkForUpdates({ automatic: true });
    }
  }, [setAutoUpdateChecksEnabled, updateStore]);

  // Ensure minimum visible duration for checking animation
  React.useEffect(() => {
    if (updateStore.checking) {
      setShowChecking(true);
    } else if (showChecking) {
      const timer = setTimeout(() => {
        setShowChecking(false);
        // Show toast if check completed with no update available
        if (didInitiateManualCheck.current && !updateStore.available && !updateStore.error) {
          toast.success(t('settings.varin.about.toast.latestVersion'));
        }
        didInitiateManualCheck.current = false;
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [t, updateStore.checking, showChecking, updateStore.available, updateStore.error]);

  const isChecking = updateStore.checking || showChecking;

  if (isMobile) {
    return (
      <div className="w-full space-y-6 pb-2">
        <div className="flex flex-col items-center text-center">
          <VarinLogo width={72} height={72} />
          <h2 className={`mt-4 ${SETTINGS_BRAND_TITLE_CLASS}`}>Varin</h2>
          <div className="mt-2 space-y-1 typography-ui text-muted-foreground">
            <p>{t('aboutDialog.versionLabel', { version: currentVersion })}</p>
          </div>
          <InstanceServiceUrls />
        </div>

        <div className="flex justify-center">
          {!updateStore.available && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCheckForUpdates}
              disabled={isChecking}
              className="h-10 w-auto justify-center gap-2 rounded-xl px-4"
            >
              {isChecking ? <Icon name="loader" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
              {isChecking ? t('settings.varin.about.state.checking') : t('settings.varin.about.actions.checkForUpdates')}
            </Button>
          )}

          {!isChecking && updateStore.available && (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setUpdateDialogOpen(true)}
              className="h-10 w-auto justify-center gap-2 rounded-xl px-4"
            >
              <Icon name="download" className="size-4" />
              {t('settings.varin.about.actions.updateToVersion', { version: updateStore.info?.version || '' })}
            </Button>
          )}
        </div>

        {updateStore.error && (
          <p className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {updateStore.error}
          </p>
        )}

        <SettingsCheckboxRow
          checked={autoUpdateChecksEnabled}
          onChange={handleAutoUpdateChecksChange}
          label={t('settings.varin.about.field.autoUpdateChecks')}
          description={t('settings.varin.about.field.autoUpdateChecksHint')}
          ariaLabel={t('settings.varin.about.field.autoUpdateChecksAria')}
          className="rounded-xl border border-border/60 px-3 py-3 text-left"
        />

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center gap-5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="github-fill" className="size-5" />
              <span>GitHub</span>
            </a>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="scales-3" className="size-5" />
              <span>AGPL-3.0</span>
            </a>
          </div>
        </div>

        <p className="text-center typography-ui text-muted-foreground/60">
          {t('aboutDialog.footerNote')}
        </p>
        <WinFspNotice />

        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={updateStore.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          restarting={updateStore.restarting}
          progress={updateStore.progress}
          error={updateStore.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={updateStore.runtimeType}
        />
      </div>
    );
  }

  // Desktop layout
  return (
    <SettingsSection divider={false}>
      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        <div className="flex flex-col gap-4 border-b border-border/40 px-4 py-4 @xl:flex-row @xl:items-center @xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <VarinLogo width={44} height={44} />
            <div className="flex min-w-0 flex-col">
              <span className={SETTINGS_FIELD_LABEL_CLASS}>Varin</span>
              <span className="typography-meta font-mono text-muted-foreground">
                {t('settings.varin.about.field.version')} {currentVersion}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {updateStore.checking && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon name="loader" className="h-4 w-4 animate-spin" />
                <span className="typography-meta">{t('settings.varin.about.state.checking')}</span>
              </div>
            )}

            {!updateStore.checking && updateStore.available && (
              <Button size="sm"
                variant="default"
                onClick={() => setUpdateDialogOpen(true)}
              >
                <Icon name="download" className="h-4 w-4 mr-1" />
                {t('settings.varin.about.actions.updateToVersion', { version: updateStore.info?.version || '' })}
              </Button>
            )}

            {!updateStore.checking && !updateStore.available && !updateStore.error && (
              <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${updateStore.lastChecked ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/60'}`}
                />
                {updateStore.lastChecked
                  ? t('settings.varin.about.state.upToDate')
                  : t('settings.varin.about.state.unknown')}
              </span>
            )}

            <Button size="sm"
              variant="outline"
              onClick={handleCheckForUpdates}
              disabled={updateStore.checking}
            >
              {t('settings.varin.about.actions.checkForUpdates')}
            </Button>
          </div>
        </div>

        {updateStore.error && (
          <div className="border-b border-border/40 px-4 py-2">
            <p className="typography-meta text-[var(--status-error)]">{updateStore.error}</p>
          </div>
        )}

        <div className="border-b border-border/40 px-4 py-3">
          <SettingsCheckboxRow
            checked={autoUpdateChecksEnabled}
            onChange={handleAutoUpdateChecksChange}
            label={t('settings.varin.about.field.autoUpdateChecks')}
            description={t('settings.varin.about.field.autoUpdateChecksHint')}
            ariaLabel={t('settings.varin.about.field.autoUpdateChecksAria')}
          />
        </div>

        <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between">
          <InstanceServiceUrls />
        </div>

        <div className="flex items-center gap-4 px-4 py-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="github-fill" className="h-4 w-4" />
            <span>GitHub</span>
          </a>
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="scales-3" className="h-4 w-4" />
            <span>AGPL-3.0</span>
          </a>

        </div>
      </div>

      <WinFspNotice />
      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        restarting={updateStore.restarting}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />
    </SettingsSection>
  );
};

function WinFspNotice() {
  return <a href="https://github.com/winfsp/winfsp" target="_blank" rel="noopener noreferrer"
    className="block typography-meta text-muted-foreground break-words hover:text-foreground transition-colors">
    WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos
  </a>;
}
