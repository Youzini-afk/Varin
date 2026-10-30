import React, {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { trackRecentPointer } from '@/lib/motion/pointer';
import { inkThemeChange } from '@/lib/motion/themeInk';
import type { Theme, ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { isDesktopLocalOriginActive, isDesktopShell as detectDesktopShell } from '@/lib/desktop';
import { setDesktopWindowTheme } from '@/lib/desktopNative';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  themes,
  getThemeById,
  getDefaultTheme,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_DARK_THEME_ID,
} from '@/lib/theme/themes';
import { withPrColors } from '@/lib/theme/themes/prColors';
import { ThemeSystemContext, type ThemeContextValue } from './theme-system-context';
import { runtimeFetch } from '@varin/application-client';
import {
  getInitialSystemPreference,
  publishEmbeddedThemeBootstrap,
  readEmbeddedThemeBootstrap,
  readEmbeddedThemeSearchParams,
} from './theme-embedded-bootstrap';
import { isValidTheme } from './theme-validation';
import { getSyncedThemeFromPayload, getSyncedThemeVariant } from './theme-sync-payload';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import {
  VARIN_THEME_STORAGE_KEY,
  readStoredThemeState,
  writeStoredThemeState,
} from '@/lib/theme/themeStorage';

type ThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

type ThemeSyncPayload = {
  themeMode?: unknown;
  lightThemeId?: unknown;
  darkThemeId?: unknown;
  currentTheme?: unknown;
};

const DEFAULT_LIGHT_ID = DEFAULT_LIGHT_THEME_ID;
const DEFAULT_DARK_ID = DEFAULT_DARK_THEME_ID;

const readEmbeddedCurrentTheme = (): Theme | null => {
  return readEmbeddedThemeBootstrap();
};

const fallbackThemeForVariant = (variant: 'light' | 'dark'): Theme =>
  getDefaultTheme(variant === 'dark');

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

const suppressTransitionsForThemeSwitch = () => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.classList.add('varin-theme-switching');

  const frame = window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      root.classList.remove('varin-theme-switching');
    });
  });

  return () => {
    window.cancelAnimationFrame(frame);
    root.classList.remove('varin-theme-switching');
  };
};

const buildInitialPreferences = (defaultThemeId?: string): ThemePreferences => {
  let lightThemeId: string = DEFAULT_LIGHT_ID;
  let darkThemeId: string = DEFAULT_DARK_ID;
  let themeMode: ThemeMode = 'system';

  if (typeof window !== 'undefined') {
    const embeddedParams = readEmbeddedThemeSearchParams();
    const embeddedMode = embeddedParams?.get('themeMode');
    const embeddedLightId = embeddedParams?.get('lightThemeId');
    const embeddedDarkId = embeddedParams?.get('darkThemeId');
    const stored = readStoredThemeState();

    if (embeddedMode === 'light' || embeddedMode === 'dark' || embeddedMode === 'system') {
      themeMode = embeddedMode;
    } else if (stored) {
      themeMode = stored.mode;
    }

    if (typeof embeddedLightId === 'string' && embeddedLightId.trim().length > 0) {
      lightThemeId = embeddedLightId.trim();
    } else if (stored) {
      lightThemeId = stored.lightThemeId;
    }

    if (typeof embeddedDarkId === 'string' && embeddedDarkId.trim().length > 0) {
      darkThemeId = embeddedDarkId.trim();
    } else if (stored) {
      darkThemeId = stored.darkThemeId;
    }
  }

  if (defaultThemeId) {
    const defaultTheme = getThemeById(defaultThemeId);
    if (defaultTheme) {
      if (defaultTheme.metadata.variant === 'light') {
        lightThemeId = defaultTheme.metadata.id;
      } else {
        darkThemeId = defaultTheme.metadata.id;
      }
    }
  }

  return {
    themeMode,
    lightThemeId,
    darkThemeId,
  };
};

interface ThemeSystemProviderProps {
  children: React.ReactNode;
  defaultThemeId?: string;
  /** Read-only transparent windows follow the same resolved theme without owning
   * saved preferences, browser/native chrome, splash colors or theme motion. */
  passiveTransparent?: boolean;
}

export function ThemeSystemProvider({ children, defaultThemeId, passiveTransparent = false }: ThemeSystemProviderProps) {
  const cssGenerator = useMemo(() => new CSSVariableGenerator(), []);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => buildInitialPreferences(defaultThemeId));
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getInitialSystemPreference());
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [developmentThemes, setDevelopmentThemes] = useState<Theme[]>([]);
  const [embeddedBootstrapTheme] = useState<Theme | null>(() => readEmbeddedCurrentTheme());
  const [embeddedSyncedTheme, setEmbeddedSyncedTheme] = useState<Theme | null>(null);
  const [customThemesLoading, setCustomThemesLoading] = useState(false);
  const isDesktopShell = useMemo(() => detectDesktopShell(), []);
  const customThemesRequestRef = useRef(0);
  const receivesParentThemeSync = useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return readEmbeddedThemeSearchParams() !== null;
  }, []);

  const availableThemes = useMemo(() => {
    const merged: Theme[] = [];
    const seen = new Set<string>();

    const add = (theme: Theme) => {
      const id = theme.metadata.id;
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(theme);
    };

    // Live-synced theme wins over bootstrap theme when IDs match (add is first-wins).
    if (embeddedSyncedTheme) {
      add(embeddedSyncedTheme);
    }

    if (embeddedBootstrapTheme) {
      add(embeddedBootstrapTheme);
    }

    // Custom themes first so they can override built-ins with the same id.
    customThemes.forEach(add);
    // Vite publishes valid built-in JSON edits through this development-only
    // runtime channel, avoiding a full page reload for theme work.
    developmentThemes.forEach(add);
    themes.forEach(add);

    return merged;
  }, [customThemes, developmentThemes, embeddedBootstrapTheme, embeddedSyncedTheme]);

  useEffect(() => {
    const handleThemeHmr = (event: Event) => {
      const theme = (event as CustomEvent<unknown>).detail;
      if (!isValidTheme(theme)) return;

      const nextTheme = withPrColors(theme);
      setDevelopmentThemes((previous) => {
        const index = previous.findIndex((candidate) => candidate.metadata.id === nextTheme.metadata.id);
        if (index < 0) return [...previous, nextTheme];
        const next = [...previous];
        next[index] = nextTheme;
        return next;
      });
    };

    window.addEventListener('varin:theme-hmr', handleThemeHmr);
    return () => window.removeEventListener('varin:theme-hmr', handleThemeHmr);
  }, []);

  const getThemeByIdFromAvailable = useCallback(
    (themeId: string): Theme | undefined => availableThemes.find((theme) => theme.metadata.id === themeId),
    [availableThemes],
  );

  const ensureThemeById = useCallback(
    (themeId: string, variant: 'light' | 'dark'): Theme => {
      const theme = getThemeByIdFromAvailable(themeId);
      if (theme && theme.metadata.variant === variant) {
        return theme;
      }

      const fallback = availableThemes.find((candidate) => candidate.metadata.variant === variant);
      return fallback ?? fallbackThemeForVariant(variant);
    },
    [availableThemes, getThemeByIdFromAvailable],
  );

  const currentTheme = useMemo(() => {
    if (preferences.themeMode === 'light') {
      return ensureThemeById(preferences.lightThemeId, 'light');
    }
    if (preferences.themeMode === 'dark') {
      return ensureThemeById(preferences.darkThemeId, 'dark');
    }
    return systemPrefersDark
      ? ensureThemeById(preferences.darkThemeId, 'dark')
      : ensureThemeById(preferences.lightThemeId, 'light');
  }, [ensureThemeById, preferences, systemPrefersDark]);

  const reloadCustomThemes = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    const runtimeKey = getRuntimeKey();
    const request = ++customThemesRequestRef.current;
    setCustomThemesLoading(true);
    try {
      const res = await runtimeFetch('/api/config/themes', {
        method: 'GET',
        credentials: isDesktopLocalOriginActive() ? 'omit' : 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      if (res.status === 401) {
        // UI auth gate will handle prompting; avoid noisy retries here.
        return;
      }

      if (!res.ok) {
        return;
      }

      const payload = await res.json();
      if (request !== customThemesRequestRef.current || runtimeKey !== getRuntimeKey()) return;
      const incoming = Array.isArray(payload?.themes) ? payload.themes : [];
      const normalized = incoming.filter(isValidTheme);
      setCustomThemes(normalized);
    } catch {
      // ignore
    } finally {
      if (request === customThemesRequestRef.current && runtimeKey === getRuntimeKey()) {
        setCustomThemesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reloadCustomThemes();
  }, [reloadCustomThemes]);

  useEffect(() => subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    customThemesRequestRef.current += 1;
    setCustomThemes([]);
    setCustomThemesLoading(false);
    void reloadCustomThemes();
  }), [reloadCustomThemes]);

  const updateBrowserChrome = useCallback((theme: Theme) => {
    if (typeof document === 'undefined') {
      return;
    }
    const hasMacVibrancy = document.documentElement.hasAttribute('data-varin-vibrancy')
      || window.__VARIN_ELECTRON__?.macVibrancy === true;
    const chromeColor = hasMacVibrancy ? 'transparent' : theme.colors.surface.background;

    document.body.style.backgroundColor = chromeColor;

    let metaThemeColor = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', chromeColor);

    const mediaQuery =
      theme.metadata.variant === 'dark'
        ? '(prefers-color-scheme: dark)'
        : '(prefers-color-scheme: light)';
    let metaThemeColorMedia = document.querySelector(
      `meta[name="theme-color"][media="${mediaQuery}"]`,
    ) as HTMLMetaElement;
    if (!metaThemeColorMedia) {
      metaThemeColorMedia = document.createElement('meta');
      metaThemeColorMedia.setAttribute('name', 'theme-color');
      metaThemeColorMedia.setAttribute('media', mediaQuery);
      document.head.appendChild(metaThemeColorMedia);
    }
    metaThemeColorMedia.setAttribute('content', chromeColor);
  }, []);

  const appliedThemeRef = React.useRef<string | null>(null);
  React.useEffect(() => { if (!passiveTransparent) trackRecentPointer(); }, [passiveTransparent]);
  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    let restoreTransitions: (() => void) | undefined;
    const apply = () => {
      if (!passiveTransparent) restoreTransitions = suppressTransitionsForThemeSwitch();
      cssGenerator.apply(currentTheme);
      if (!passiveTransparent && !receivesParentThemeSync) {
        publishEmbeddedThemeBootstrap(currentTheme);
      }
      if (!passiveTransparent) updateBrowserChrome(currentTheme);

      const root = document.documentElement;
      root.classList.remove('light', 'dark');
      root.classList.add(currentTheme.metadata.variant);
    };
    // The first theme is simply applied; a change spreads from where the user clicked.
    const previous = appliedThemeRef.current;
    appliedThemeRef.current = currentTheme.metadata.id;
    if (passiveTransparent || previous === null || previous === currentTheme.metadata.id || receivesParentThemeSync) apply();
    else inkThemeChange(apply);

    return () => restoreTransitions?.();
  }, [cssGenerator, currentTheme, updateBrowserChrome, passiveTransparent, receivesParentThemeSync]);

  useEffect(() => {
    if (preferences.themeMode !== 'system' || typeof window === 'undefined') {
      return;
    }

    if (receivesParentThemeSync) {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preferences.themeMode, receivesParentThemeSync]);

  useEffect(() => {
    if (passiveTransparent || receivesParentThemeSync || typeof window === 'undefined') {
      return;
    }

    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');
    writeStoredThemeState({
      mode: preferences.themeMode,
      lightThemeId: preferences.lightThemeId,
      darkThemeId: preferences.darkThemeId,
      splash: {
        light: {
          background: lightTheme.colors.surface.background,
          foreground: lightTheme.colors.surface.foreground,
        },
        dark: {
          background: darkTheme.colors.surface.background,
          foreground: darkTheme.colors.surface.foreground,
        },
      },
    });
  }, [ensureThemeById, preferences, receivesParentThemeSync, passiveTransparent]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (receivesParentThemeSync) {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== VARIN_THEME_STORAGE_KEY) {
        return;
      }

      const stored = readStoredThemeState();
      if (!stored) return;
      setPreferences((prev) => {
        if (
          stored.mode === prev.themeMode
          && stored.lightThemeId === prev.lightThemeId
          && stored.darkThemeId === prev.darkThemeId
        ) {
          return prev;
        }

        return {
          themeMode: stored.mode,
          lightThemeId: stored.lightThemeId,
          darkThemeId: stored.darkThemeId,
        };
      });
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [receivesParentThemeSync]);

  const applyIncomingThemeSync = useCallback((payload: ThemeSyncPayload) => {
    const mode = payload.themeMode;
    const light = payload.lightThemeId;
    const dark = payload.darkThemeId;
    const syncedVariant = getSyncedThemeVariant(payload);
    const syncedTheme = getSyncedThemeFromPayload(payload);

    if ((mode !== 'light' && mode !== 'dark' && mode !== 'system') || typeof light !== 'string' || typeof dark !== 'string') {
      return;
    }

    const normalizedLight = light.trim();
    const normalizedDark = dark.trim();
    if (!normalizedLight || !normalizedDark) {
      return;
    }

    if (!passiveTransparent) suppressTransitionsForThemeSwitch();
    flushSync(() => {
      if (receivesParentThemeSync && syncedTheme) {
        setEmbeddedSyncedTheme(syncedTheme);
      }

      if (mode === 'system' && syncedVariant) {
        setSystemPrefersDark(syncedVariant === 'dark');
      }

      setPreferences((prev) => {
        if (prev.themeMode === mode && prev.lightThemeId === normalizedLight && prev.darkThemeId === normalizedDark) {
          return prev;
        }

        return {
          themeMode: mode,
          lightThemeId: normalizedLight,
          darkThemeId: normalizedDark,
        };
      });
    });
  }, [receivesParentThemeSync, passiveTransparent]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scopedWindow = window as unknown as {
      __varinApplyThemeSync?: (payload: ThemeSyncPayload) => void;
    };

    scopedWindow.__varinApplyThemeSync = applyIncomingThemeSync;

    if (receivesParentThemeSync && window.parent !== window) {
      window.parent.postMessage({ type: 'varin:theme-sync-request' }, window.location.origin);
    }

    return () => {
      if (scopedWindow.__varinApplyThemeSync === applyIncomingThemeSync) {
        delete scopedWindow.__varinApplyThemeSync;
      }
    };
  }, [applyIncomingThemeSync, receivesParentThemeSync]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as {
        type?: unknown;
        payload?: ThemeSyncPayload;
      };

      if (data?.type !== 'varin:theme-sync' || !data.payload) {
        return;
      }

      applyIncomingThemeSync(data.payload);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [applyIncomingThemeSync]);

  const persistThemePreferences = useCallback((next: ThemePreferences) => {
    if (passiveTransparent || receivesParentThemeSync) return;

    const lightTheme = ensureThemeById(next.lightThemeId, 'light');
    const darkTheme = ensureThemeById(next.darkThemeId, 'dark');
    const resolvedTheme = next.themeMode === 'light'
      ? lightTheme
      : next.themeMode === 'dark'
        ? darkTheme
        : systemPrefersDark
          ? darkTheme
          : lightTheme;

    void updateDesktopSettings({
      themeId: resolvedTheme.metadata.id,
      themeVariant: resolvedTheme.metadata.variant,
      useSystemTheme: next.themeMode === 'system',
      lightThemeId: next.lightThemeId,
      darkThemeId: next.darkThemeId,
      splashBgLight: lightTheme.colors.surface.background,
      splashFgLight: lightTheme.colors.surface.foreground,
      splashBgDark: darkTheme.colors.surface.background,
      splashFgDark: darkTheme.colors.surface.foreground,
    });
  }, [ensureThemeById, receivesParentThemeSync, systemPrefersDark, passiveTransparent]);

  useEffect(() => {
    if (passiveTransparent || receivesParentThemeSync || !isDesktopShell) {
      return;
    }

    void (async () => {
      await setDesktopWindowTheme(preferences.themeMode, currentTheme.metadata.variant);
    })();
  }, [currentTheme.metadata.variant, isDesktopShell, preferences.themeMode, receivesParentThemeSync, passiveTransparent]);

  useEffect(() => {
    if (typeof window === 'undefined' || receivesParentThemeSync) {
      return;
    }
    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      if (!detail) {
        return;
      }

      setPreferences((prev) => {
        let nextMode = prev.themeMode;
        if (detail.useSystemTheme === true) {
          nextMode = 'system';
        } else if (detail.useSystemTheme === false) {
          if (detail.themeVariant === 'dark' || detail.themeVariant === 'light') {
            nextMode = detail.themeVariant;
          }
        }

        let nextLight = prev.lightThemeId;
        if (typeof detail.lightThemeId === 'string' && detail.lightThemeId.length > 0) {
          nextLight = detail.lightThemeId.trim();
        }

        let nextDark = prev.darkThemeId;
        if (typeof detail.darkThemeId === 'string' && detail.darkThemeId.length > 0) {
          nextDark = detail.darkThemeId.trim();
        }

        const same =
          nextMode === prev.themeMode &&
          nextLight === prev.lightThemeId &&
          nextDark === prev.darkThemeId;

        if (same) {
          return prev;
        }

        return {
          themeMode: nextMode,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('varin:settings-synced', handleSettingsSynced);
    return () => window.removeEventListener('varin:settings-synced', handleSettingsSynced);
  }, [receivesParentThemeSync]);

  const setThemeModeHandler = useCallback((mode: ThemeMode) => {
    if (passiveTransparent || preferences.themeMode === mode) {
      return;
    }

    const next = {
      ...preferences,
      themeMode: mode,
    } satisfies ThemePreferences;
    setPreferences(next);
    persistThemePreferences(next);
  }, [persistThemePreferences, preferences, passiveTransparent]);

  const setLightThemePreference = useCallback(
    (themeId: string) => {
      if (passiveTransparent) return;
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'light',
      );
      if (!theme) {
        return;
      }

      if (preferences.lightThemeId === theme.metadata.id) return;
      const next = { ...preferences, lightThemeId: theme.metadata.id };
      setPreferences(next);
      persistThemePreferences(next);
    },
    [availableThemes, persistThemePreferences, preferences, passiveTransparent],
  );

  const setDarkThemePreference = useCallback(
    (themeId: string) => {
      if (passiveTransparent) return;
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'dark',
      );
      if (!theme) {
        return;
      }

      if (preferences.darkThemeId === theme.metadata.id) return;
      const next = { ...preferences, darkThemeId: theme.metadata.id };
      setPreferences(next);
      persistThemePreferences(next);
    },
    [availableThemes, persistThemePreferences, preferences, passiveTransparent],
  );

  const value: ThemeContextValue = {
    currentTheme,
    availableThemes,
    customThemesLoading,
    reloadCustomThemes,
    themeMode: preferences.themeMode,
    setThemeMode: setThemeModeHandler,
    lightThemeId: preferences.lightThemeId,
    darkThemeId: preferences.darkThemeId,
    setLightThemePreference,
    setDarkThemePreference,
  };

  return (
    <ThemeSystemContext.Provider value={value}>
      {children}
    </ThemeSystemContext.Provider>
  );
}
