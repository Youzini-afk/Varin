import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import { useI18n, type Locale } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { reportSettingsSaveState, updateDesktopSettings } from '@/lib/persistence';
import { readStoredLocale } from '@/lib/i18n/runtime';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getStoredMobileLayoutPreference, setStoredMobileLayoutPreference, type MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import { After, Btn, Chip, CommitField, Page, Row, Section, Seg, Select, Sw, UnitBar } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { useDesktopNetwork } from '@/components/sections/varin/useDesktopNetwork';

const DEFAULT_PWA_INSTALL_NAME = 'Varin - Agent Workspace';
type Orientation = 'system' | 'portrait' | 'landscape';
type PwaWindow = Window & {
  __VARIN_SET_PWA_INSTALL_NAME__?: (value: string) => string;
  __VARIN_SET_PWA_ORIENTATION__?: (value: Orientation) => Orientation;
  __VARIN_UPDATE_PWA_MANIFEST__?: () => void;
};
const orientationOf = (value: unknown): Orientation => (value === 'portrait' || value === 'landscape' ? value : 'system');

/** 通用: language and time formats, how the app starts and how it is installed. */
export function GeneralPage() {
  const { t, locale, locales, setLocale, label } = useI18n();
  const { isMobile } = useDeviceInfo();
  const { browserTab } = usePwaDetection();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const setTimeFormat = useUIStore(state => state.setTimeFormatPreference);
  const weekStart = useUIStore(state => state.weekStartPreference);
  const setWeekStart = useUIStore(state => state.setWeekStartPreference);
  const keyboardMode = useUIStore(state => state.mobileKeyboardMode);
  const setKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
  const desktop = useDesktopNetwork('general');

  const web = isWebRuntime() && !isDesktopShell();
  const showInstallName = web && browserTab;
  const showOrientation = web;
  const showKeyboard = web && supportsMobileKeyboardResizeContent();
  const showMobileLayout = isMobile && web;
  const [mobileLayout, setMobileLayout] = React.useState<MobileLayoutPreference>(() => getStoredMobileLayoutPreference());
  const [installName, setInstallName] = React.useState('');
  const [orientation, setOrientation] = React.useState<Orientation>('system');

  React.useEffect(() => {
    if (!showInstallName && !showOrientation && !showKeyboard) return;
    let cancelled = false;
    void runtimeFetch('/api/config/settings', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(response => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then((settings: Record<string, unknown>) => {
        if (cancelled) return;
        const raw = typeof settings.pwaAppName === 'string' ? settings.pwaAppName.trim().replace(/\s+/g, ' ').slice(0, 64) : '';
        setInstallName(raw || DEFAULT_PWA_INSTALL_NAME);
        setOrientation(orientationOf(settings.pwaOrientation));
        if (showKeyboard) setKeyboardMode(normalizeMobileKeyboardMode(settings.mobileKeyboardMode));
      });
    return () => { cancelled = true; };
  }, [setKeyboardMode, showInstallName, showKeyboard, showOrientation]);

  const applyInstallName = async (value: string) => {
    const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 64);
    await updateDesktopSettings({ pwaAppName: normalized });
    const win = window as PwaWindow;
    if (typeof win.__VARIN_SET_PWA_INSTALL_NAME__ === 'function') { setInstallName(win.__VARIN_SET_PWA_INSTALL_NAME__(normalized)); return; }
    setInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
    win.__VARIN_UPDATE_PWA_MANIFEST__?.();
  };
  const applyOrientation = async (value: Orientation) => {
    setOrientation(value);
    await updateDesktopSettings({ pwaOrientation: value });
    const win = window as PwaWindow;
    if (typeof win.__VARIN_SET_PWA_ORIENTATION__ === 'function') { setOrientation(win.__VARIN_SET_PWA_ORIENTATION__(value)); return; }
    win.__VARIN_UPDATE_PWA_MANIFEST__?.();
  };

  const desktopTag = <Chip tiny>{t('settings.kit.desktopOnly')}</Chip>;
  const startup = desktop.isLocalDesktop && (desktop.launchAtLoginSupported || desktop.minimizeToTraySupported || desktop.isMacDesktop);
  return <Page title={t('settings.page.general.title')} description={t('settings.general.description')} scope={<SettingsScopeLabel kind="mixed" />}>
    <Section title={t('settings.general.region')} after={<After>{t('settings.general.regionScope')}</After>}>
      <Row label={t('settings.appearance.language.label')} item="appearance.language">
        <Select value={locale} label={t('settings.appearance.language.select')}
          options={locales.map(value => ({ value, label: label(value), text: label(value) }))}
          onChange={(value) => { setLocale(value as Locale); reportSettingsSaveState(readStoredLocale() === value ? 'saved' : 'error'); }} />
      </Row>
      <Row label={t('settings.varin.visual.field.timeFormat')} item="appearance.time-format">
        <Seg value={timeFormat} label={t('settings.varin.visual.field.timeFormat')} onChange={(value) => { setTimeFormat(value); void updateDesktopSettings({ timeFormatPreference: value }); }}
          options={[{ value: 'auto', label: t('settings.kit.auto') }, { value: '24h', label: t('settings.general.clock24') }, { value: '12h', label: t('settings.general.clock12') }]} />
      </Row>
      <Row label={t('settings.general.weekStart')} item="appearance.week-start">
        <Seg value={weekStart} label={t('settings.general.weekStart')} onChange={(value) => { setWeekStart(value); void updateDesktopSettings({ weekStartPreference: value }); }}
          options={[{ value: 'auto', label: t('settings.kit.auto') }, { value: 'monday', label: t('settings.varin.visual.option.weekStart.monday.label') }, { value: 'sunday', label: t('settings.varin.visual.option.weekStart.sunday.label') }]} />
      </Row>
    </Section>

    {startup ? <Section title={t('settings.general.startup')}>
      {desktop.launchAtLoginSupported ? <Row label={t('settings.general.launchAtLogin')} tag={desktopTag} item="sessions.desktop-launch-at-login">
        <Sw checked={desktop.launchAtLoginEnabled} disabled={desktop.isSavingLaunchAtLogin} label={t('settings.general.launchAtLogin')} onChange={() => void desktop.handleLaunchAtLoginToggle()} />
      </Row> : null}
      {desktop.minimizeToTraySupported ? <Row label={t('settings.general.tray')} tag={desktopTag} description={t('settings.general.trayHint')} item="sessions.desktop-minimize-to-tray">
        <Sw checked={desktop.minimizeToTrayEnabled} disabled={desktop.isSavingMinimizeToTray} label={t('settings.general.tray')} onChange={() => void desktop.handleMinimizeToTrayToggle()} />
      </Row> : null}
      {desktop.isMacDesktop ? <Row label={t('settings.general.menuBar')} tag={<Chip tiny>macOS</Chip>} description={t('settings.general.menuBarHint')} item="sessions.desktop-mac-menu-bar">
        <Sw checked={desktop.draftMacMenuBarEnabled} disabled={desktop.isLoading || desktop.isSaving} label={t('settings.general.menuBar')} onChange={desktop.setDraftMacMenuBarEnabled} />
      </Row> : null}
      {desktop.isMacDesktop ? <UnitBar dirty={desktop.isDirty} saving={desktop.isSaving} error={desktop.error ?? undefined} saveDisabled={desktop.saveDisabled}
        message={t('settings.general.restartNeeded')} saveLabel={t('settings.varin.desktopNetwork.actions.saveAndRestart')}
        onSave={desktop.handleSaveAndRestart} onCancel={desktop.discard} /> : null}
      {desktop.error && !desktop.isMacDesktop ? <Row description={<span className="sk-faint">{desktop.error}</span>} /> : null}
    </Section> : null}

    {showInstallName || showOrientation ? <Section title={t('settings.general.install')} description={t('settings.general.installHint')}>
      {showInstallName ? <Row label={t('settings.general.appName')} description={t('settings.general.appNameHint')} item="appearance.pwa-install-name">
        <CommitField value={installName} maxLength={64} aria-label={t('settings.varin.visual.field.pwaInstallAppNameAria')} onCommit={(value) => void applyInstallName(value)} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={installName === DEFAULT_PWA_INSTALL_NAME} onClick={() => void applyInstallName('')} />
      </Row> : null}
      {showOrientation ? <Row label={t('settings.general.orientation')} item="appearance.pwa-orientation">
        <Select value={orientation} label={t('settings.general.orientation')} onChange={(value) => void applyOrientation(value)}
          options={[{ value: 'system', label: t('settings.general.followSystem') }, { value: 'portrait', label: t('settings.general.portrait') }, { value: 'landscape', label: t('settings.general.landscape') }]} />
      </Row> : null}
    </Section> : null}

    {showKeyboard || showMobileLayout ? <Section title={t('settings.general.mobile')}>
      {showKeyboard ? <Row label={t('settings.general.keyboard')} item="appearance.mobile-keyboard-mode">
        <Select value={keyboardMode} label={t('settings.general.keyboard')} onChange={(value: MobileKeyboardMode) => { setKeyboardMode(value); void updateDesktopSettings({ mobileKeyboardMode: value }); }}
          options={[
            { value: 'native', label: t('settings.general.keyboardNative') },
            { value: 'resize-content', label: t('settings.general.keyboardResize'), description: t('settings.general.keyboardResizeHint') },
          ]} />
      </Row> : null}
      {showMobileLayout ? <Row label={t('settings.varin.visual.section.mobileLayout')} description={t('settings.general.mobileLayoutHint')}>
        <Seg value={mobileLayout} label={t('settings.varin.visual.section.mobileLayout')}
          onChange={(value) => { setMobileLayout(value); setStoredMobileLayoutPreference(value); window.location.reload(); }}
          options={[{ value: 'default', label: t('settings.varin.visual.option.mobileLayout.default') }, { value: 'new', label: t('settings.varin.visual.option.mobileLayout.new') }]} />
      </Row> : null}
    </Section> : null}
  </Page>;
}
