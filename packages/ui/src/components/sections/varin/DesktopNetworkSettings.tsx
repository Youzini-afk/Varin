import * as React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useDesktopNetwork, type DesktopNetworkSection } from './useDesktopNetwork';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsStackedField,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const DesktopNetworkSettings: React.FC<{ section?: DesktopNetworkSection }> = ({ section = 'all' }) => {
  const { t } = useI18n();
  const {
    isLocalDesktop, isMacDesktop, isLoading, isSaving, error, setError, isDirty, saveDisabled, lanUrl, passwordlessLanAccess,
    savedValue, draftValue, setDraftValue, savedPassword, draftPassword, setDraftPassword, showPassword, setShowPassword,
    launchAtLoginSupported, launchAtLoginEnabled, isSavingLaunchAtLogin, handleLaunchAtLoginToggle,
    minimizeToTraySupported, minimizeToTrayEnabled, isSavingMinimizeToTray, handleMinimizeToTrayToggle,
    keepAwakeSupported, keepAwakeEnabled, isSavingKeepAwake, handleKeepAwakeToggle,
    savedMacMenuBarEnabled, draftMacMenuBarEnabled, setDraftMacMenuBarEnabled, handleSaveAndRestart,
  } = useDesktopNetwork(section);
  if (!isLocalDesktop) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.varin.desktopNetwork.title')}>
      <div className="space-y-3">
        {section !== 'access' && (isLocalDesktop || launchAtLoginSupported || isMacDesktop || minimizeToTraySupported || keepAwakeSupported) ? (
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            {launchAtLoginSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-launch-at-login"
                checked={launchAtLoginEnabled}
                onChange={(checked) => {
                  if (checked === launchAtLoginEnabled) return;
                  void handleLaunchAtLoginToggle();
                }}
                disabled={isSavingLaunchAtLogin}
                label={t('settings.varin.desktopNetwork.field.launchAtLogin')}
                info={t('settings.varin.desktopNetwork.field.launchAtLoginDescription')}
                ariaLabel={t('settings.varin.desktopNetwork.field.launchAtLoginAria')}
              />
            ) : null}

            {isMacDesktop ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-mac-menu-bar"
                checked={draftMacMenuBarEnabled}
                onChange={setDraftMacMenuBarEnabled}
                disabled={isLoading || isSaving}
                label={t('settings.varin.desktopNetwork.field.macMenuBar')}
                info={t('settings.varin.desktopNetwork.field.macMenuBarDescription')}
                ariaLabel={t('settings.varin.desktopNetwork.field.macMenuBarAria')}
              />
            ) : null}

            {minimizeToTraySupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-minimize-to-tray"
                checked={minimizeToTrayEnabled}
                onChange={(checked) => {
                  if (checked === minimizeToTrayEnabled) return;
                  void handleMinimizeToTrayToggle();
                }}
                disabled={isSavingMinimizeToTray}
                label={t('settings.varin.desktopNetwork.field.minimizeToTray')}
                info={t('settings.varin.desktopNetwork.field.minimizeToTrayDescription')}
                ariaLabel={t('settings.varin.desktopNetwork.field.minimizeToTrayAria')}
              />
            ) : null}

            {keepAwakeSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-keep-awake"
                checked={keepAwakeEnabled}
                onChange={(checked) => {
                  if (checked === keepAwakeEnabled) return;
                  void handleKeepAwakeToggle();
                }}
                disabled={isSavingKeepAwake}
                label={t('settings.varin.desktopNetwork.field.keepAwake')}
                info={t('settings.varin.desktopNetwork.field.keepAwakeDescription')}
                ariaLabel={t('settings.varin.desktopNetwork.field.keepAwakeAria')}
              />
            ) : null}
          </div>
        ) : null}

        {section !== 'general' ? <>
        <SettingsStackedField
          settingsItem="sessions.desktop-ui-password"
          label={(
            <label htmlFor="desktop-ui-password">
              {t('settings.varin.desktopPassword.field.password')}
            </label>
          )}
          info={t('settings.varin.desktopPassword.field.passwordDescription')}
        >
          <Input
            id="desktop-ui-password"
            type={showPassword ? 'text' : 'password'}
            className="h-8 min-w-0 flex-1"
            value={draftPassword}
            onChange={(event) => setDraftPassword(event.target.value)}
            placeholder={t('settings.varin.desktopPassword.field.passwordPlaceholder')}
            disabled={isLoading || isSaving}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowPassword((current: boolean) => !current)}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t(showPassword ? 'settings.varin.desktopPassword.actions.hidePassword' : 'settings.varin.desktopPassword.actions.showPassword')}
            aria-pressed={showPassword}
          >
            <Icon name={showPassword ? 'eye-off' : 'eye'} className="h-4 w-4" />
          </Button>
        </SettingsStackedField>

        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.desktop-lan-access"
            checked={draftValue}
            onChange={setDraftValue}
            disabled={isLoading || isSaving}
            label={t('settings.varin.desktopNetwork.field.allowLanAccess')}
            info={t('settings.varin.desktopNetwork.field.allowLanAccessDescription')}
            description={passwordlessLanAccess ? (
              <span className="block text-[var(--status-warning)]/85">
                {t('settings.varin.desktopNetwork.field.warning')}
              </span>
            ) : undefined}
            ariaLabel={t('settings.varin.desktopNetwork.field.allowLanAccessAria')}
          />
        </div>

        </> : null}
        {error ? (
          <div className="typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {section !== 'general' && lanUrl ? (
          <div className="typography-micro text-muted-foreground/80">
            {isDirty && !savedValue
              ? t('settings.varin.desktopNetwork.hint.openAfterRestart')
              : t('settings.varin.desktopNetwork.hint.openNow')}
            <span className="font-mono text-foreground">{lanUrl}</span>
          </div>
        ) : null}

        {section !== 'general' || isMacDesktop ? <SettingsActionBar
          dirty={isDirty} saving={isSaving} saveDisabled={saveDisabled}
          onSave={handleSaveAndRestart} saveLabel={t('settings.varin.desktopNetwork.actions.saveAndRestart')}
          onCancel={() => { setDraftValue(savedValue); setDraftPassword(savedPassword); setDraftMacMenuBarEnabled(savedMacMenuBarEnabled); setError(null); }}
          error={error}
        /> : null}
      </div>
    </SettingsSection>
  );
};
