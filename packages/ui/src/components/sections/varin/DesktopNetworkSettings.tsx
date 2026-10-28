import * as React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import {
  getDesktopLanAddress,
  invokeDesktop,
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@varin/application-client';
import { getRuntimeApiBaseUrl } from '@varin/application-client';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsStackedField,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const DesktopNetworkSettings: React.FC<{ section?: 'general' | 'access' | 'all' }> = ({ section = 'all' }) => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__VARIN_PLATFORM__ === 'darwin';
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [savedPassword, setSavedPassword] = React.useState('');
  const [draftPassword, setDraftPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [lanAccessActive, setLanAccessActive] = React.useState(false);
  const [lanAccessBlockedReason, setLanAccessBlockedReason] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [savedMacMenuBarEnabled, setSavedMacMenuBarEnabled] = React.useState(true);
  const [draftMacMenuBarEnabled, setDraftMacMenuBarEnabled] = React.useState(true);
  const [companionEnabled, setCompanionEnabled] = React.useState(false);
  const [savingCompanion, setSavingCompanion] = React.useState(false);
  React.useEffect(() => {
    if (!isLocalDesktop) return;
    let active = true;
    void invokeDesktop('desktop_get_companion').then(status => { if (active) setCompanionEnabled(status?.enabled === true); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [isLocalDesktop]);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(t('settings.varin.desktopNetwork.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | {
          desktopLanAccessEnabled?: unknown;
          desktopUiPassword?: unknown;
          desktopLanAccessActive?: unknown;
          desktopLanAccessBlockedReason?: unknown;
          desktopMacMenuBarEnabled?: unknown;
        };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        const password = typeof data?.desktopUiPassword === 'string' ? data.desktopUiPassword : '';
        setSavedValue(enabled);
        setDraftValue(enabled);
        setSavedPassword(password);
        setDraftPassword(password);
        setLanAccessActive(data?.desktopLanAccessActive === true);
        setLanAccessBlockedReason(
          typeof data?.desktopLanAccessBlockedReason === 'string' ? data.desktopLanAccessBlockedReason : null
        );
        const macMenuBarEnabled = data?.desktopMacMenuBarEnabled !== false;
        setSavedMacMenuBarEnabled(macMenuBarEnabled);
        setDraftMacMenuBarEnabled(macMenuBarEnabled);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.varin.desktopNetwork.error.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setLaunchAtLoginSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopLaunchAtLogin();
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(status?.supported === true);
      setLaunchAtLoginEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setMinimizeToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMinimizeToTray();
      if (cancelled) {
        return;
      }
      setMinimizeToTraySupported(status?.supported === true);
      setMinimizeToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopKeepAwake();
      if (cancelled) {
        return;
      }
      setKeepAwakeSupported(status?.supported === true);
      setKeepAwakeEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const isDirty = (section !== 'general' && (draftValue !== savedValue || draftPassword !== savedPassword))
    || (section !== 'access' && draftMacMenuBarEnabled !== savedMacMenuBarEnabled);
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAccessActive && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;
  const lanRequiresPassword = draftValue && !draftPassword.trim();
  const lanBlockedByMissingPassword = savedValue && !lanAccessActive && lanAccessBlockedReason === 'missing-password';
  const saveDisabled = isLoading || isSaving || !isDirty || (section !== 'general' && lanRequiresPassword);

  const handlePasswordChange = React.useCallback((value: string) => {
    setDraftPassword(value);
    if (!value.trim()) {
      setDraftValue(false);
    }
  }, []);

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.varin.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.varin.desktopNetwork.error.launchAtLoginSaveFailed'));
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported, t]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error(t('settings.varin.desktopNetwork.error.minimizeToTraySaveFailed'));
      }
      if (!status.supported) {
        throw new Error(t('settings.varin.desktopNetwork.error.minimizeToTrayUnsupported'));
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.varin.desktopNetwork.error.minimizeToTraySaveFailed'));
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported, t]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.varin.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.varin.desktopNetwork.error.keepAwakeSaveFailed'));
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported, t]);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) return true;

    setIsSaving(true);
    setError(null);

    try {
      const response = await runtimeFetch('/api/config/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ...(section !== 'general' ? { desktopLanAccessEnabled: draftValue, desktopUiPassword: draftPassword } : {}),
          ...(section !== 'access' ? { desktopMacMenuBarEnabled: draftMacMenuBarEnabled } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(t('settings.varin.desktopNetwork.error.saveFailed'));
      }

      setSavedValue(draftValue);
      setSavedPassword(draftPassword);
      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.varin.desktopNetwork.error.savedRestartFailed'));
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.varin.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
      return false;
    }
  }, [draftMacMenuBarEnabled, draftPassword, draftValue, isDirty, section, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.varin.desktopNetwork.title')}>
      <div className="space-y-3">
        {section !== 'access' && (isLocalDesktop || launchAtLoginSupported || isMacDesktop || minimizeToTraySupported || keepAwakeSupported) ? (
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            {isLocalDesktop && <SettingsCheckboxRow settingsItem="sessions.desktop-companion" checked={companionEnabled}
              disabled={savingCompanion} label={t('settings.varin.desktopNetwork.field.companion')}
              info={t('settings.varin.desktopNetwork.field.companionDescription')}
              onChange={enabled => { setSavingCompanion(true); void invokeDesktop('desktop_set_companion', { enabled })
                .then(status => setCompanionEnabled(status?.enabled === true)).catch(cause => setError(String(cause))).finally(() => setSavingCompanion(false)); }} />}

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
            onChange={(event) => handlePasswordChange(event.target.value)}
            placeholder={t('settings.varin.desktopPassword.field.passwordPlaceholder')}
            disabled={isLoading || isSaving}
            required={draftValue}
            aria-invalid={lanRequiresPassword}
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
            description={(
              <>
                <span className="block text-[var(--status-warning)]/85">
                  {t('settings.varin.desktopNetwork.field.warning')}
                </span>
                {lanRequiresPassword || lanBlockedByMissingPassword ? (
                  <span className="block text-[var(--status-warning)]/85">
                    {t('settings.varin.desktopNetwork.field.passwordRequiredWarning')}
                  </span>
                ) : null}
              </>
            )}
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
