import React from 'react';
import { runtimeFetch } from '@varin/application-client';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    canUseElectronDesktopIPC,
    invokeDesktop,
    isDesktopLocalOriginActive,
    isDesktopShell,
    isWebRuntime,
    usesFramelessElectronChrome,
    type DesktopWindowControlsPosition,
    type DesktopWindowControlsStyle,
} from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { useI18n, type Locale } from '@/lib/i18n';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getStoredMobileLayoutPreference, setStoredMobileLayoutPreference, type MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import {
    SettingsSection,
    SettingsTwoColumn,
    SettingsControlGroup,
    SettingsStackedField,
    SettingsFieldRow,
    SettingsInset,
    SettingsCheckboxRow,
    SettingsRadioGroup,
    SettingsRadioOption,
    SettingsChipGroup,
    SETTINGS_SELECT_TRIGGER_CLASS,
    SETTINGS_SELECT_SIZE,
    SETTINGS_ICON_BUTTON_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_CLUSTER_CONTROL_CLASS,
    SETTINGS_NUMBER_STEPPER_ROW_CLASS,
    SETTINGS_NUMBER_UNIT_CLASS,
    SETTINGS_FIELDS_STACK_CLASS,
    SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TerminalShellOption } from '@varin/application-client';
import { isTerminalShell } from '@/lib/terminalShell';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { FileEditorPreferencesSettings } from './FileEditorPreferencesSettings';
import { ThemePicker } from './ThemePicker';

interface Option<T extends string> {
    id: T;
    labelKey: string;
    descriptionKey?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: string; descriptionKey: string }> = [
    {
        value: 'system',
        labelKey: 'settings.varin.visual.option.themeMode.system',
        descriptionKey: 'settings.varin.visual.option.themeMode.system.description',
    },
    {
        value: 'light',
        labelKey: 'settings.varin.visual.option.themeMode.light',
        descriptionKey: 'settings.varin.visual.option.themeMode.light.description',
    },
    {
        value: 'dark',
        labelKey: 'settings.varin.visual.option.themeMode.dark',
        descriptionKey: 'settings.varin.visual.option.themeMode.dark.description',
    },
];

const DEFAULT_PWA_INSTALL_NAME = 'Varin - Agent Workspace';
const PWA_ORIENTATION_OPTIONS: Option<'system' | 'portrait' | 'landscape'>[] = [
    {
        id: 'system',
        labelKey: 'settings.varin.visual.option.pwaOrientation.system.label',
        descriptionKey: 'settings.varin.visual.option.pwaOrientation.system.description',
    },
    {
        id: 'portrait',
        labelKey: 'settings.varin.visual.option.pwaOrientation.portrait.label',
        descriptionKey: 'settings.varin.visual.option.pwaOrientation.portrait.description',
    },
    {
        id: 'landscape',
        labelKey: 'settings.varin.visual.option.pwaOrientation.landscape.label',
        descriptionKey: 'settings.varin.visual.option.pwaOrientation.landscape.description',
    },
];

const MOBILE_KEYBOARD_MODE_OPTIONS: Option<MobileKeyboardMode>[] = [
    {
        id: 'native',
        labelKey: 'settings.varin.visual.option.mobileKeyboardMode.native.label',
        descriptionKey: 'settings.varin.visual.option.mobileKeyboardMode.native.description',
    },
    {
        id: 'resize-content',
        labelKey: 'settings.varin.visual.option.mobileKeyboardMode.resizeContent.label',
        descriptionKey: 'settings.varin.visual.option.mobileKeyboardMode.resizeContent.description',
    },
];

const MOBILE_LAYOUT_OPTIONS: Array<{ value: MobileLayoutPreference; labelKey: string }> = [
    {
        value: 'default',
        labelKey: 'settings.varin.visual.option.mobileLayout.default',
    },
    {
        value: 'new',
        labelKey: 'settings.varin.visual.option.mobileLayout.new',
    },
];

type PwaInstallNameWindow = Window & {
    __VARIN_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __VARIN_SET_PWA_ORIENTATION__?: (value: 'system' | 'portrait' | 'landscape') => 'system' | 'portrait' | 'landscape';
    __VARIN_UPDATE_PWA_MANIFEST__?: () => void;
};

const normalizePwaOrientation = (value: unknown): 'system' | 'portrait' | 'landscape' => {
    return value === 'portrait' || value === 'landscape' ? value : 'system';
};

const TIME_FORMAT_OPTIONS: Option<'auto' | '12h' | '24h'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.varin.visual.option.timeFormat.auto.label',
        descriptionKey: 'settings.varin.visual.option.timeFormat.auto.description',
    },
    {
        id: '24h',
        labelKey: 'settings.varin.visual.option.timeFormat.24h.label',
        descriptionKey: 'settings.varin.visual.option.timeFormat.24h.description',
    },
    {
        id: '12h',
        labelKey: 'settings.varin.visual.option.timeFormat.12h.label',
        descriptionKey: 'settings.varin.visual.option.timeFormat.12h.description',
    },
];

const WEEK_START_OPTIONS: Option<'auto' | 'monday' | 'sunday'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.varin.visual.option.weekStart.auto.label',
        descriptionKey: 'settings.varin.visual.option.weekStart.auto.description',
    },
    {
        id: 'monday',
        labelKey: 'settings.varin.visual.option.weekStart.monday.label',
    },
    {
        id: 'sunday',
        labelKey: 'settings.varin.visual.option.weekStart.sunday.label',
    },
];

type VisibleSetting =
    | 'theme'
    | 'windowControlsPosition'
    | 'pwaInstallName'
    | 'pwaOrientation'
    | 'mobileKeyboardMode'
    | 'timeFormat'
    | 'weekStart'
    | 'fontSize'
    | 'terminalFontSize'
    | 'terminalShell'
    | 'terminalLoginShell'
    | 'editorFontSize'
    | 'spacing'
    | 'inputBarOffset'
    | 'mobileStatusBar'
    | 'terminalQuickKeys'
    | 'fileEditorKeymap'
    | 'fileEditorPreferences'
    | 'expandedEditorToolbar'
    | 'autoSaveEnabled';

const WINDOW_CONTROLS_POSITION_OPTIONS: Array<{ id: DesktopWindowControlsPosition; labelKey: string }> = [
    { id: 'left', labelKey: 'settings.varin.desktopNetwork.option.windowControlsLeft' },
    { id: 'right', labelKey: 'settings.varin.desktopNetwork.option.windowControlsRight' },
];

const WINDOW_CONTROLS_STYLE_OPTIONS: Array<{ id: DesktopWindowControlsStyle; labelKey: string }> = [
    { id: 'classic', labelKey: 'settings.varin.desktopNetwork.option.windowControlsClassic' },
    { id: 'traffic-lights', labelKey: 'settings.varin.desktopNetwork.option.windowControlsTrafficLights' },
];

interface VarinVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
}

export const VarinVisualSettings: React.FC<VarinVisualSettingsProps> = ({ visibleSettings }) => {
    const { locale, locales, setLocale, label, t } = useI18n();
    const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const { isMobile } = useDeviceInfo();
    const { terminal } = useRuntimeAPIs();
    const { browserTab } = usePwaDetection();

    const expandedEditorToolbar = useUIStore(state => state.expandedEditorToolbar);
    const setExpandedEditorToolbar = useUIStore(state => state.setExpandedEditorToolbar);
    const autoSaveEnabled = useUIStore(state => state.autoSaveEnabled);
    const setAutoSaveEnabled = useUIStore(state => state.setAutoSaveEnabled);
    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const terminalShell = useUIStore(state => state.terminalShell);
    const setTerminalShell = useUIStore(state => state.setTerminalShell);
    const terminalLoginShells = useUIStore(state => state.terminalLoginShells);
    const setTerminalLoginShells = useUIStore(state => state.setTerminalLoginShells);
    const editorFontSize = useUIStore(state => state.editorFontSize);
    const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
    const uiFont = useUIStore(state => state.uiFont);
    const setUiFont = useUIStore(state => state.setUiFont);
    const monoFont = useUIStore(state => state.monoFont);
    const setMonoFont = useUIStore(state => state.setMonoFont);
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore(state => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
    const showTerminalQuickKeysOnDesktop = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
    const fileEditorKeymap = useUIStore(state => state.fileEditorKeymap);
    const setFileEditorKeymap = useUIStore(state => state.setFileEditorKeymap);
    const timeFormatPreference = useUIStore(state => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore(state => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore(state => state.weekStartPreference);
    const setWeekStartPreference = useUIStore(state => state.setWeekStartPreference);
    const {
        themeMode,
        setThemeMode,
        availableThemes,
        customThemesLoading,
        reloadCustomThemes,
        lightThemeId,
        darkThemeId,
        setLightThemePreference,
        setDarkThemePreference,
    } = useThemeSystem();

    const [themesReloading, setThemesReloading] = React.useState(false);

    // macOS-desktop-only vibrancy toggle. Changing it needs a full relaunch
    // (vibrancy is a window-creation option), so we persist + restart on save.
    const macVibrancySupported = React.useMemo(
        () => isDesktopShell()
            && canUseElectronDesktopIPC()
            && isDesktopLocalOriginActive()
            && typeof window !== 'undefined'
            && window.__VARIN_ELECTRON__?.macVibrancySupported === true,
        [],
    );
    const macVibrancyEnabled = typeof window !== 'undefined' && window.__VARIN_ELECTRON__?.macVibrancy === true;
    const [vibrancyChecked, setVibrancyChecked] = React.useState(macVibrancyEnabled);
    const [vibrancyRestarting, setVibrancyRestarting] = React.useState(false);

    // macOS-desktop-only dock badge that counts chats with unseen activity.
    // The tray sync (mac-only) pumps the count to the main process, so the
    // toggle is offered only where it actually has an effect. No relaunch needed.
    const dockBadgeSupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined'
            && (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ === 'darwin',
        [],
    );
    const dockBadgeEnabled = useUIStore(state => state.dockBadgeEnabled);
    const setDockBadgeEnabled = useUIStore(state => state.setDockBadgeEnabled);
    const showWindowControlsPosition = usesFramelessElectronChrome();
    const desktopWindowControlsPosition = useUIStore((state) => state.desktopWindowControlsPosition);
    const setDesktopWindowControlsPosition = useUIStore((state) => state.setDesktopWindowControlsPosition);
    const desktopWindowControlsStyle = useUIStore((state) => state.desktopWindowControlsStyle);
    const setDesktopWindowControlsStyle = useUIStore((state) => state.setDesktopWindowControlsStyle);

    const handleWindowControlsPositionChange = React.useCallback((value: DesktopWindowControlsPosition) => {
        setDesktopWindowControlsPosition(value);
        void updateDesktopSettings({ desktopWindowControlsPosition: value });
    }, [setDesktopWindowControlsPosition]);

    const handleWindowControlsStyleChange = React.useCallback((value: DesktopWindowControlsStyle) => {
        setDesktopWindowControlsStyle(value);
        void updateDesktopSettings({ desktopWindowControlsStyle: value });
    }, [setDesktopWindowControlsStyle]);

    const handleExpandedEditorToolbarChange = React.useCallback((enabled: boolean) => {
        setExpandedEditorToolbar(enabled);
        void updateDesktopSettings({ expandedEditorToolbar: enabled });
    }, [setExpandedEditorToolbar]);

    const handleTimeFormatPreferenceChange = React.useCallback((value: 'auto' | '12h' | '24h') => {
        setTimeFormatPreference(value);
        void updateDesktopSettings({ timeFormatPreference: value });
    }, [setTimeFormatPreference]);

    const handleWeekStartPreferenceChange = React.useCallback((value: 'auto' | 'monday' | 'sunday') => {
        setWeekStartPreference(value);
        void updateDesktopSettings({ weekStartPreference: value });
    }, [setWeekStartPreference]);

    const lightThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'light'),
        [availableThemes],
    );

    const darkThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'dark'),
        [availableThemes],
    );

    const selectedLightTheme = React.useMemo(
        () => lightThemes.find((theme) => theme.metadata.id === lightThemeId) ?? lightThemes[0],
        [lightThemes, lightThemeId],
    );

    const selectedDarkTheme = React.useMemo(
        () => darkThemes.find((theme) => theme.metadata.id === darkThemeId) ?? darkThemes[0],
        [darkThemes, darkThemeId],
    );

    const shouldShow = (setting: VisibleSetting): boolean => {
        if (!visibleSettings) return true;
        return visibleSettings.includes(setting);
    };

    const hasThemeSettings = shouldShow('theme');
    const showWindowControlsPositionSetting = shouldShow('windowControlsPosition') && showWindowControlsPosition;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const showMobileLayoutSetting = isMobile && isWebRuntime() && !isDesktopShell();
    const hasAppearanceSettings = shouldShow('theme') || showWindowControlsPositionSetting || showMobileLayoutSetting || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('timeFormat') || shouldShow('weekStart');
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile);
    const hasNavigationSettings = (shouldShow('terminalQuickKeys') && !isMobile) || shouldShow('terminalShell') || shouldShow('terminalLoginShell') || shouldShow('fileEditorKeymap') || shouldShow('autoSaveEnabled') || shouldShow('expandedEditorToolbar');
    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab && !isDesktopShell();
    const showPwaOrientationSetting = shouldShow('pwaOrientation') && isWebRuntime() && !isDesktopShell();
    const showMobileKeyboardModeSetting = shouldShow('mobileKeyboardMode') && isWebRuntime() && !isDesktopShell() && supportsMobileKeyboardResizeContent();
    const showTerminalShellSetting = shouldShow('terminalShell') || shouldShow('terminalLoginShell');
    const [availableTerminalShells, setAvailableTerminalShells] = React.useState<TerminalShellOption[]>([]);
    const [terminalShellRuntimeEpoch, setTerminalShellRuntimeEpoch] = React.useState(0);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
        setAvailableTerminalShells([]);
        setTerminalShellRuntimeEpoch((epoch) => epoch + 1);
    }), []);
    React.useEffect(() => {
        let cancelled = false;
        if (!showTerminalShellSetting || !terminal.listShells) return;
        void terminal.listShells()
            .then((shells) => {
                if (!cancelled) setAvailableTerminalShells(shells);
            })
            .catch(() => {
                if (!cancelled) setAvailableTerminalShells([]);
            });
        return () => {
            cancelled = true;
        };
    }, [showTerminalShellSetting, terminal, terminalShellRuntimeEpoch]);
    const terminalShellOptions = React.useMemo(() => {
        const explicitShells = availableTerminalShells.filter((shell) => shell.id !== 'auto');
        if (terminalShell === 'auto' || explicitShells.some((shell) => shell.id === terminalShell)) {
            return explicitShells;
        }
        return [{ id: terminalShell, name: terminalShell, supportsLogin: false }, ...explicitShells];
    }, [availableTerminalShells, terminalShell]);
    const terminalShellSupportsLogin = availableTerminalShells.find((shell) => shell.id === terminalShell)?.supportsLogin === true;
    const terminalLoginShellEnabled = terminalLoginShells.includes(terminalShell);
    const setTerminalLoginShellEnabled = (enabled: boolean) => {
        setTerminalLoginShells(enabled
            ? [...terminalLoginShells.filter((shell) => shell !== terminalShell), terminalShell]
            : terminalLoginShells.filter((shell) => shell !== terminalShell));
    };
    const [mobileLayoutPreference, setMobileLayoutPreference] = React.useState<MobileLayoutPreference>(() => getStoredMobileLayoutPreference());
    const [pwaInstallName, setPwaInstallName] = React.useState('');
    const [pwaOrientation, setPwaOrientation] = React.useState<'system' | 'portrait' | 'landscape'>('system');
    const selectedTimeFormatLabel = React.useMemo(() => {
        const option = TIME_FORMAT_OPTIONS.find((item) => item.id === timeFormatPreference);
        return tUnsafe(option?.labelKey ?? 'settings.varin.visual.option.timeFormat.auto.label');
    }, [timeFormatPreference, tUnsafe]);
    const selectedWeekStartLabel = React.useMemo(() => {
        const option = WEEK_START_OPTIONS.find((item) => item.id === weekStartPreference);
        return tUnsafe(option?.labelKey ?? 'settings.varin.visual.option.weekStart.auto.label');
    }, [weekStartPreference, tUnsafe]);
    const selectedPwaOrientationLabel = React.useMemo(() => {
        const option = PWA_ORIENTATION_OPTIONS.find((item) => item.id === pwaOrientation);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [pwaOrientation, tUnsafe]);
    const selectedMobileKeyboardModeLabel = React.useMemo(() => {
        const option = MOBILE_KEYBOARD_MODE_OPTIONS.find((item) => item.id === mobileKeyboardMode);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [mobileKeyboardMode, tUnsafe]);

    const handleMobileLayoutPreferenceChange = React.useCallback((value: MobileLayoutPreference) => {
        if (value === mobileLayoutPreference) {
            return;
        }

        setMobileLayoutPreference(value);
        setStoredMobileLayoutPreference(value);
        window.location.reload();
    }, [mobileLayoutPreference]);

    const applyPwaInstallName = React.useCallback(async (value: string) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 64);
        const persistedValue = normalized;

        await updateDesktopSettings({ pwaAppName: persistedValue });

        if (typeof win.__VARIN_SET_PWA_INSTALL_NAME__ === 'function') {
            const resolved = win.__VARIN_SET_PWA_INSTALL_NAME__(persistedValue);
            setPwaInstallName(resolved);
            return;
        }

        setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
        win.__VARIN_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const applyPwaOrientation = React.useCallback(async (value: 'system' | 'portrait' | 'landscape') => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = normalizePwaOrientation(value);

        await updateDesktopSettings({ pwaOrientation: normalized });

        if (typeof win.__VARIN_SET_PWA_ORIENTATION__ === 'function') {
            const resolved = win.__VARIN_SET_PWA_ORIENTATION__(normalized);
            setPwaOrientation(resolved);
            return;
        }

        setPwaOrientation(normalized);
        win.__VARIN_UPDATE_PWA_MANIFEST__?.();
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined' || (!showPwaInstallNameSetting && !showPwaOrientationSetting && !showMobileKeyboardModeSetting)) {
            return;
        }

        let cancelled = false;

        const loadPwaInstallName = async () => {
            try {
                const response = await runtimeFetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });

                if (!response.ok) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const settings = await response.json().catch(() => ({}));
                const raw = typeof settings?.pwaAppName === 'string' ? settings.pwaAppName : '';
                const normalized = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
                const orientation = normalizePwaOrientation(settings?.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode);

                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation(orientation);
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode(nextMobileKeyboardMode);
                    }
                }
            } catch {
                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation('system');
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode('native');
                    }
                }
            }
        };

        void loadPwaInstallName();

        return () => {
            cancelled = true;
        };
    }, [setMobileKeyboardMode, showMobileKeyboardModeSetting, showPwaInstallNameSetting, showPwaOrientationSetting]);

    return (
        <div className="space-y-0">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <div className="space-y-0">
                        {hasThemeSettings && (
                            <SettingsSection title={t('settings.varin.visual.section.colorModeAndTheme')} divider={false}>
                                <SettingsTwoColumn>
                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsRadioGroup aria-label={t('settings.varin.visual.section.colorMode')}>
                                            {THEME_MODE_OPTIONS.map((option) => (
                                                <SettingsRadioOption
                                                    key={option.value}
                                                    selected={themeMode === option.value}
                                                    onSelect={() => setThemeMode(option.value)}
                                                    label={tUnsafe(option.labelKey)}
                                                    ariaLabel={tUnsafe(option.labelKey)}
                                                />
                                            ))}
                                        </SettingsRadioGroup>

                                        {showMobileLayoutSetting && (
                                            <SettingsInset>
                                                <SettingsStackedField label={t('settings.varin.visual.section.mobileLayout')}>
                                                    <SettingsChipGroup
                                                        value={mobileLayoutPreference}
                                                        options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
                                                            value: option.value,
                                                            label: tUnsafe(option.labelKey),
                                                        }))}
                                                        onChange={handleMobileLayoutPreferenceChange}
                                                        aria-label={t('settings.varin.visual.section.mobileLayout')}
                                                    />
                                                </SettingsStackedField>
                                            </SettingsInset>
                                        )}
                                    </div>

                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsStackedField
                                            label={t('settings.varin.visual.field.lightTheme')}
                                            settingsItem="appearance.light-theme"
                                        >
                                            <ThemePicker themes={lightThemes} selected={selectedLightTheme}
                                                onChange={setLightThemePreference}
                                                label={t('settings.varin.visual.field.selectLightThemeAria')} />
                                        </SettingsStackedField>
                                        <SettingsStackedField
                                            label={t('settings.varin.visual.field.darkTheme')}
                                            settingsItem="appearance.dark-theme"
                                        >
                                            <ThemePicker themes={darkThemes} selected={selectedDarkTheme}
                                                onChange={setDarkThemePreference}
                                                label={t('settings.varin.visual.field.selectDarkThemeAria')} />
                                        </SettingsStackedField>

                                        <div className="flex items-center gap-2 pt-1">
                                            <button
                                                type="button"
                                                disabled={customThemesLoading || themesReloading}
                                                onClick={() => {
                                                    const startedAt = Date.now();
                                                    setThemesReloading(true);
                                                    void reloadCustomThemes().finally(() => {
                                                        const elapsed = Date.now() - startedAt;
                                                        if (elapsed < 500) {
                                                            window.setTimeout(() => {
                                                                setThemesReloading(false);
                                                            }, 500 - elapsed);
                                                            return;
                                                        }
                                                        setThemesReloading(false);
                                                    });
                                                }}
                                                className="typography-settings-link inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                                            >
                                                <Icon name="restart" className={cn('h-3.5 w-3.5', themesReloading && 'animate-spin')} />
                                                {themesReloading ? t('settings.varin.visual.actions.reloadingThemes') : t('settings.varin.visual.actions.reloadThemes')}
                                            </button>
                                            <SettingsInfoHint>
                                                {t('settings.varin.visual.field.themeImportInfoTooltip')}
                                            </SettingsInfoHint>
                                        </div>
                                    </div>
                                </SettingsTwoColumn>

                                {macVibrancySupported && (
                                    <SettingsInset settingsItem="appearance.window-transparency" className="flex flex-col gap-1.5">
                                        <SettingsCheckboxRow
                                            checked={vibrancyChecked}
                                            onChange={setVibrancyChecked}
                                            disabled={vibrancyRestarting}
                                            label={t('settings.varin.visual.field.macVibrancy')}
                                            info={t('settings.varin.visual.field.macVibrancyHint')}
                                            ariaLabel={t('settings.varin.visual.field.macVibrancy')}
                                        />
                                        {vibrancyChecked !== macVibrancyEnabled && (
                                            <div className="pl-6">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={vibrancyRestarting}
                                                    onClick={() => {
                                                        setVibrancyRestarting(true);
                                                        void invokeDesktop('desktop_set_vibrancy', { enabled: vibrancyChecked })
                                                            .catch(() => setVibrancyRestarting(false));
                                                    }}
                                                >
                                                    {vibrancyRestarting
                                                        ? t('settings.varin.visual.actions.restarting')
                                                        : t('settings.varin.visual.actions.saveAndRestart')}
                                                </Button>
                                            </div>
                                        )}
                                    </SettingsInset>
                                )}

                                {dockBadgeSupported && (
                                    <SettingsInset settingsItem="appearance.dock-badge">
                                        <SettingsCheckboxRow
                                            checked={dockBadgeEnabled}
                                            onChange={setDockBadgeEnabled}
                                            label={t('settings.varin.visual.field.dockBadge')}
                                            info={t('settings.varin.visual.field.dockBadgeHint')}
                                            ariaLabel={t('settings.varin.visual.field.dockBadge')}
                                        />
                                    </SettingsInset>
                                )}
                            </SettingsSection>
                        )}

                        {showWindowControlsPositionSetting && (
                            <SettingsSection
                                title={t('settings.varin.desktopNetwork.field.windowControls')}
                                info={t('settings.varin.desktopNetwork.field.windowControlsPositionDescription')}
                                divider={hasThemeSettings}
                            >
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={t('settings.varin.desktopNetwork.field.windowControlsPosition')}
                                        settingsItem="sessions.desktop-window-controls-position"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsPosition}
                                            options={WINDOW_CONTROLS_POSITION_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: tUnsafe(option.labelKey),
                                            }))}
                                            onChange={handleWindowControlsPositionChange}
                                            aria-label={t('settings.varin.desktopNetwork.field.windowControlsPositionAria')}
                                        />
                                    </SettingsStackedField>
                                    <SettingsStackedField
                                        label={t('settings.varin.desktopNetwork.field.windowControlsStyle')}
                                        settingsItem="sessions.desktop-window-controls-style"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsStyle}
                                            options={WINDOW_CONTROLS_STYLE_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: tUnsafe(option.labelKey),
                                            }))}
                                            onChange={handleWindowControlsStyleChange}
                                            aria-label={t('settings.varin.desktopNetwork.field.windowControlsStyleAria')}
                                        />
                                    </SettingsStackedField>
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {hasLocalizationSettings && (
                            <SettingsSection title={t('settings.varin.visual.section.localization')}>
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={t('settings.appearance.language.label')}
                                        info={t('settings.appearance.language.description')}
                                        settingsItem="appearance.language"
                                    >
                                        <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                                            <SelectTrigger aria-label={t('settings.appearance.language.select')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{label(locale)}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {locales.map((availableLocale) => (
                                                    <SelectItem key={availableLocale} value={availableLocale}>
                                                        {label(availableLocale)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </SettingsStackedField>

                                    {(shouldShow('timeFormat') || shouldShow('weekStart')) && (
                                        <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                            {shouldShow('timeFormat') && (
                                                <SettingsStackedField
                                                    label={t('settings.varin.visual.field.timeFormat')}
                                                    settingsItem="appearance.time-format"
                                                >
                                                    <Select value={timeFormatPreference} onValueChange={(value: 'auto' | '12h' | '24h') => handleTimeFormatPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={t('settings.varin.visual.field.selectTimeFormatAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {TIME_FORMAT_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}

                                            {shouldShow('weekStart') && (
                                                <SettingsStackedField
                                                    label={t('settings.varin.visual.field.weekStartsOn')}
                                                    settingsItem="appearance.week-start"
                                                >
                                                    <Select value={weekStartPreference} onValueChange={(value: 'auto' | 'monday' | 'sunday') => handleWeekStartPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={t('settings.varin.visual.field.selectWeekStartAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedWeekStartLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {WEEK_START_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}
                                        </div>
                                    )}
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <SettingsSection title={t('settings.varin.visual.section.appInstall')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>

                            {showPwaInstallNameSetting && (
                                <SettingsFieldRow
                                    label={t('settings.varin.visual.field.installAppName')}
                                    info={t('settings.varin.visual.field.installAppNameHint')}
                                    settingsItem="appearance.pwa-install-name"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Input
                                        value={pwaInstallName}
                                        onChange={(event) => {
                                            setPwaInstallName(event.target.value);
                                        }}
                                        onBlur={() => {
                                            void applyPwaInstallName(pwaInstallName);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                void applyPwaInstallName(pwaInstallName);
                                            }
                                        }}
                                        className="min-w-0 flex-1"
                                        maxLength={64}
                                        aria-label={t('settings.varin.visual.field.pwaInstallAppNameAria')}
                                    />
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                                            void applyPwaInstallName('');
                                        }}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.varin.visual.actions.resetInstallAppNameAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}

                            {showPwaOrientationSetting && (
                                <SettingsFieldRow
                                    label={t('settings.varin.visual.field.installOrientation')}
                                    description={t('settings.varin.visual.field.installOrientationHint')}
                                    settingsItem="appearance.pwa-orientation"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={pwaOrientation}
                                        onValueChange={(value) => {
                                            const orientation = normalizePwaOrientation(value);
                                            setPwaOrientation(orientation);
                                            void applyPwaOrientation(orientation);
                                        }}
                                    >
                                        <SelectTrigger aria-label={t('settings.varin.visual.field.pwaInstallOrientationAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
                                            <SelectValue placeholder={t('settings.varin.visual.field.selectOrientationPlaceholder')}>
                                                {selectedPwaOrientationLabel}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PWA_ORIENTATION_OPTIONS.map((option) => (
                                                <SelectItem key={option.id} value={option.id}>
                                                    {tUnsafe(option.labelKey)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setPwaOrientation('system');
                                            void applyPwaOrientation('system');
                                        }}
                                        disabled={pwaOrientation === 'system'}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.varin.visual.actions.resetInstallOrientationAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}

                            {showMobileKeyboardModeSetting && (
                                <SettingsFieldRow
                                    label={t('settings.varin.visual.field.mobileKeyboardMode')}
                                    info={t('settings.varin.visual.field.mobileKeyboardModeHint')}
                                    settingsItem="appearance.mobile-keyboard-mode"
                                    alignEnd={false}
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={mobileKeyboardMode}
                                        onValueChange={(value) => {
                                            const mode = normalizeMobileKeyboardMode(value);
                                            setMobileKeyboardMode(mode);
                                            void updateDesktopSettings({ mobileKeyboardMode: mode });
                                        }}
                                    >
                                        <SelectTrigger aria-label={t('settings.varin.visual.field.mobileKeyboardModeAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
                                            <SelectValue placeholder={t('settings.varin.visual.field.selectMobileKeyboardModePlaceholder')}>
                                                {selectedMobileKeyboardModeLabel}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {MOBILE_KEYBOARD_MODE_OPTIONS.map((option) => (
                                                <SelectItem key={option.id} value={option.id}>
                                                    {tUnsafe(option.labelKey)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => {
                                            setMobileKeyboardMode('native');
                                            void updateDesktopSettings({ mobileKeyboardMode: 'native' });
                                        }}
                                        disabled={mobileKeyboardMode === 'native'}
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.varin.visual.actions.resetMobileKeyboardModeAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsFieldRow>
                            )}
                            </SettingsSection>
                        )}
                    </div>
                )}

                {/* --- Density & type --- */}
                {hasLayoutSettings && (
                    <SettingsSection title={t('settings.varin.visual.section.densityAndType')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.interfaceFont')}
                                        settingsItem="appearance.interface-font-size"
                                        controlClassName="w-full"
                                    >
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={t('settings.varin.visual.field.selectInterfaceFontAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {UI_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setUiFont(DEFAULT_UI_FONT)}
                                            disabled={uiFont === DEFAULT_UI_FONT}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.varin.visual.actions.resetInterfaceFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.codeFont')}
                                        controlClassName="w-full"
                                    >
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={t('settings.varin.visual.field.selectCodeFontAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {CODE_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setMonoFont(DEFAULT_MONO_FONT)}
                                            disabled={monoFont === DEFAULT_MONO_FONT}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.varin.visual.actions.resetCodeFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}

                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') || shouldShow('editorFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.interfaceFontSize')}
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={fontSize}
                                                onValueChange={setFontSize}
                                                min={50}
                                                max={200}
                                                step={5}
                                                aria-label={t('settings.varin.visual.field.fontSizePercentageAria')}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setFontSize(100)}
                                                disabled={fontSize === 100}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.varin.visual.actions.resetFontSizeAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.terminalFontSize')}
                                        settingsItem="appearance.terminal-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={terminalFontSize}
                                                onValueChange={setTerminalFontSize}
                                                min={9}
                                                max={52}
                                                step={1}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setTerminalFontSize(13)}
                                                disabled={terminalFontSize === 13}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.varin.visual.actions.resetTerminalFontSizeAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('editorFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.editorFontSize')}
                                        settingsItem="appearance.editor-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={editorFontSize}
                                                onValueChange={setEditorFontSize}
                                                min={9}
                                                max={32}
                                                step={1}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setEditorFontSize(13)}
                                                disabled={editorFontSize === 13}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.varin.visual.actions.resetEditorFontSizeAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}

                        {shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile) ? (
                            <SettingsTwoColumn>
                                {shouldShow('spacing') && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.spacingDensity')}
                                        settingsItem="appearance.spacing-density"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={padding}
                                                onValueChange={setPadding}
                                                min={50}
                                                max={200}
                                                step={5}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setPadding(100)}
                                                disabled={padding === 100}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.varin.visual.actions.resetSpacingAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('inputBarOffset') && isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.varin.visual.field.inputBarOffset')}
                                        info={t('settings.varin.visual.field.inputBarOffsetTooltip')}
                                        settingsItem="appearance.input-bar-offset"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={inputBarOffset}
                                                onValueChange={setInputBarOffset}
                                                min={0}
                                                max={100}
                                                step={5}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setInputBarOffset(0)}
                                                disabled={inputBarOffset === 0}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.varin.visual.actions.resetInputBarOffsetAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}
                    </SettingsSection>
                )}

                {shouldShow('fileEditorPreferences') && !isMobile ? <FileEditorPreferencesSettings /> : null}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <SettingsSection title={t('settings.varin.visual.section.navigation')} contentClassName="space-y-4">
                        {shouldShow('fileEditorKeymap') && (
                            <SettingsControlGroup
                                title={t('settings.varin.visual.field.fileEditorKeymap')}
                                settingsItem="appearance.file-editor-keymap"
                            >
                                <SettingsRadioGroup aria-label={t('settings.varin.visual.field.fileEditorKeymap')}>
                                    {(['default', 'vim'] as const).map((keymap) => (
                                        <SettingsRadioOption
                                            key={keymap}
                                            selected={fileEditorKeymap === keymap}
                                            onSelect={() => setFileEditorKeymap(keymap)}
                                            label={t(`settings.varin.visual.option.fileEditorKeymap.${keymap}`)}
                                            ariaLabel={t(`settings.varin.visual.option.fileEditorKeymap.${keymap}`)}
                                        />
                                    ))}
                                </SettingsRadioGroup>
                            </SettingsControlGroup>
                        )}
                        <div className={SETTINGS_OPTION_STACK_CLASS}>
                            {shouldShow('autoSaveEnabled') && (
                                <SettingsCheckboxRow
                                    checked={autoSaveEnabled}
                                    onChange={setAutoSaveEnabled}
                                    label={t('settings.varin.visual.field.autoSaveEnabled')}
                                    ariaLabel={t('settings.varin.visual.field.autoSaveEnabledAria')}
                                    info={t('settings.varin.visual.field.autoSaveEnabledInfo')}
                                    settingsItem="appearance.auto-save-enabled"
                                />
                            )}
                            {shouldShow('expandedEditorToolbar') && (
                                <SettingsCheckboxRow
                                    checked={expandedEditorToolbar}
                                    onChange={handleExpandedEditorToolbarChange}
                                    label={t('settings.varin.visual.field.expandedEditorToolbar')}
                                    ariaLabel={t('settings.varin.visual.field.expandedEditorToolbarAria')}
                                    settingsItem="appearance.expanded-editor-toolbar"
                                />
                            )}
                            {shouldShow('terminalQuickKeys') && !isMobile && (
                                <SettingsCheckboxRow
                                    checked={showTerminalQuickKeysOnDesktop}
                                    onChange={setShowTerminalQuickKeysOnDesktop}
                                    label={t('settings.varin.visual.field.terminalQuickKeys')}
                                    ariaLabel={t('settings.varin.visual.field.terminalQuickKeysAria')}
                                    settingsItem="appearance.terminal-quick-keys"
                                    info={t('settings.varin.visual.field.terminalQuickKeysTooltip')}
                                />
                            )}
                            {showTerminalShellSetting && (
                                <SettingsStackedField
                                    label={t('settings.varin.visual.field.terminalShell')}
                                    info={t('settings.varin.visual.field.terminalShellHint')}
                                    settingsItem="appearance.terminal-shell"
                                    className="pt-2"
                                >
                                    <Select value={terminalShell} onValueChange={(value) => { if (isTerminalShell(value)) setTerminalShell(value); }}>
                                        <SelectTrigger aria-label={t('settings.varin.visual.field.terminalShellAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="auto">{t('settings.varin.visual.option.terminalShell.auto')}</SelectItem>
                                            {terminalShellOptions.map((shell) => (
                                                <SelectItem key={shell.id} value={shell.id}>{shell.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingsStackedField>
                            )}
                            {showTerminalShellSetting && terminalShellSupportsLogin && (
                                <SettingsCheckboxRow
                                    checked={terminalLoginShellEnabled}
                                    onChange={setTerminalLoginShellEnabled}
                                    label={t('settings.varin.visual.field.terminalLoginShell')}
                                    ariaLabel={t('settings.varin.visual.field.terminalLoginShell')}
                                    settingsItem="appearance.terminal-login-shell"
                                />
                            )}
                        </div>
                    </SettingsSection>
                )}


            </div>
    );
};
