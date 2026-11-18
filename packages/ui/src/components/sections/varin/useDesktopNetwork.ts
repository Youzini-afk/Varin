import * as React from 'react';
import { getRuntimeApiBaseUrl, runtimeFetch } from '@varin/application-client';
import {
  getDesktopLanAddress,
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

export type DesktopNetworkSection = 'general' | 'access' | 'all';

/** Desktop startup, LAN access and interface password, owned by the local desktop Host and shell. */
export function useDesktopNetwork(section: DesktopNetworkSection = 'all') {
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
  const passwordlessLanAccess = draftValue && !draftPassword.trim();
  const saveDisabled = isLoading || isSaving || !isDirty;

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

  return {
    isLocalDesktop, isMacDesktop, isLoading, isSaving, error, setError, isDirty, saveDisabled, lanUrl, passwordlessLanAccess,
    savedValue, draftValue, setDraftValue, savedPassword, draftPassword, setDraftPassword, showPassword, setShowPassword,
    launchAtLoginSupported, launchAtLoginEnabled, isSavingLaunchAtLogin, handleLaunchAtLoginToggle,
    minimizeToTraySupported, minimizeToTrayEnabled, isSavingMinimizeToTray, handleMinimizeToTrayToggle,
    keepAwakeSupported, keepAwakeEnabled, isSavingKeepAwake, handleKeepAwakeToggle,
    savedMacMenuBarEnabled, draftMacMenuBarEnabled, setDraftMacMenuBarEnabled, handleSaveAndRestart,
    discard: () => { setDraftValue(savedValue); setDraftPassword(savedPassword); setDraftMacMenuBarEnabled(savedMacMenuBarEnabled); setError(null); },
  };
}
