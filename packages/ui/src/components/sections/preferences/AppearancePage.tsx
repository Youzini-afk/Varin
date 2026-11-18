import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { normalizeCustomColor, type CustomColorField } from '@/lib/theme/customColors';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { CODE_FONT_OPTIONS, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type UiFontOption } from '@/lib/fontOptions';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive, isDesktopShell, usesFramelessElectronChrome, type DesktopWindowControlsPosition, type DesktopWindowControlsStyle } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import type { MotionPreference } from '@/lib/motion/preference';
import type { Theme } from '@/types/theme';
import { After, Area, Btn, Disclosure, LinkRow, Note, NumField, OptionCards, Page, Pad, PageHeader, Row, Section, Seg, Select, Sw, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { ThemePicker } from '@/components/sections/varin/ThemePicker';
import { ChatSettingsPreview, type ChatPreviewScene } from '@/components/sections/varin/ChatSettingsPreview';
import { ModeArt, PreviewLayout } from './PreviewLayout';

const surfaces = (theme: Theme | undefined, fallback: { background: string; sidebar: string; foreground: string; accent: string }) => theme
  ? { background: theme.colors.surface.background, sidebar: theme.colors.sidebar?.background ?? theme.colors.surface.muted, foreground: theme.colors.surface.foreground, accent: theme.colors.primary.base }
  : fallback;

/** 外观: color mode, themes, fonts and motion. The example on the right follows each change. */
export function AppearancePage() {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const shell = useSettingsShell();
  const theme = useThemeSystem();
  const [scene, setScene] = React.useState<ChatPreviewScene>('conversation');
  const fontSize = useUIStore(state => state.fontSize);
  const setFontSize = useUIStore(state => state.setFontSize);
  const padding = useUIStore(state => state.padding);
  const setPadding = useUIStore(state => state.setPadding);
  const uiFont = useUIStore(state => state.uiFont);
  const setUiFont = useUIStore(state => state.setUiFont);
  const monoFont = useUIStore(state => state.monoFont);
  const inputBarOffset = useUIStore(state => state.inputBarOffset);
  const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
  const motion = useUIStore(state => state.motionPreference);
  const setMotion = useUIStore(state => state.setMotionPreference);
  const motionLevel = useMotionLevel();
  const controlsPosition = useUIStore(state => state.desktopWindowControlsPosition);
  const setControlsPosition = useUIStore(state => state.setDesktopWindowControlsPosition);
  const controlsStyle = useUIStore(state => state.desktopWindowControlsStyle);
  const setControlsStyle = useUIStore(state => state.setDesktopWindowControlsStyle);
  const dockBadge = useUIStore(state => state.dockBadgeEnabled);
  const setDockBadge = useUIStore(state => state.setDockBadgeEnabled);

  const lightThemes = React.useMemo(() => theme.availableThemes.filter(item => item.metadata.variant === 'light'), [theme.availableThemes]);
  const darkThemes = React.useMemo(() => theme.availableThemes.filter(item => item.metadata.variant === 'dark'), [theme.availableThemes]);
  const light = lightThemes.find(item => item.metadata.id === theme.lightThemeId) ?? lightThemes[0];
  const dark = darkThemes.find(item => item.metadata.id === theme.darkThemeId) ?? darkThemes[0];
  const lightSurface = surfaces(light, { background: '#f4f4f4', sidebar: '#e3e3e3', foreground: '#333333', accent: '#4b6fac' });
  const darkSurface = surfaces(dark, { background: '#1b1b1b', sidebar: '#2a2a2a', foreground: '#dddddd', accent: '#7aa7ef' });

  const [themeJson, setThemeJson] = React.useState('');
  const [transferMessage, setTransferMessage] = React.useState('');
  const [importing, setImporting] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const importTheme = async (raw: string) => {
    setImporting(true);
    try { await theme.importTheme(raw); setTransferMessage(t('settings.varin.visual.field.themeImported')); setThemeJson(''); }
    catch (error) { setTransferMessage(error instanceof Error && ['json', 'format', 'unsafe'].includes(error.message) ? t('settings.varin.visual.field.themeInvalid') : t('settings.varin.visual.field.themeStorageError')); }
    finally { setImporting(false); }
  };
  const copyTheme = async () => {
    const json = JSON.stringify(theme.currentTheme, null, 2);
    try { await navigator.clipboard.writeText(json); setTransferMessage(t('settings.appearancex.copied')); }
    catch { setThemeJson(json); setTransferMessage(t('settings.varin.visual.field.themeCopyFallback')); }
  };
  const currentImported = theme.importedThemes.some(item => item.metadata.id === theme.currentTheme.metadata.id);

  const macVibrancySupported = isDesktopShell() && canUseElectronDesktopIPC() && isDesktopLocalOriginActive() && window.__VARIN_ELECTRON__?.macVibrancySupported === true;
  const macVibrancyEnabled = window.__VARIN_ELECTRON__?.macVibrancy === true;
  const [vibrancy, setVibrancy] = React.useState(macVibrancyEnabled);
  const [restarting, setRestarting] = React.useState(false);
  const dockBadgeSupported = isDesktopShell() && (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ === 'darwin';
  const frameless = usesFramelessElectronChrome();

  const colorFields: Array<[CustomColorField, string, string]> = [
    ['accent', t('settings.appearancex.accent'), theme.currentTheme.colors.primary.base],
    ['background', t('settings.appearancex.background'), theme.currentTheme.colors.surface.background],
    ['foreground', t('settings.appearancex.foreground'), theme.currentTheme.colors.surface.foreground],
  ];

  const form = <>
    <Section title={t('settings.appearancex.mode')} raw item="appearance.theme-mode">
      <OptionCards value={theme.themeMode} label={t('settings.appearancex.mode')} onChange={theme.setThemeMode} options={[
        { value: 'light', label: t('settings.varin.visual.option.themeMode.light'), art: <ModeArt {...lightSurface} /> },
        { value: 'dark', label: t('settings.varin.visual.option.themeMode.dark'), art: <ModeArt {...darkSurface} /> },
        { value: 'system', label: t('settings.varin.visual.option.themeMode.system'), art: <ModeArt {...lightSurface} split={darkSurface} /> },
      ]} />
    </Section>

    <Section title={t('settings.appearancex.themes')} description={t('settings.appearancex.themesHint')}>
      <Row label={t('settings.appearancex.lightTheme')} item="appearance.light-theme">
        <ThemePicker themes={lightThemes} selected={light} onChange={theme.setLightThemePreference} label={t('settings.varin.visual.field.selectLightThemeAria')} />
      </Row>
      <Row label={t('settings.appearancex.darkTheme')} item="appearance.dark-theme">
        <ThemePicker themes={darkThemes} selected={dark} onChange={theme.setDarkThemePreference} label={t('settings.varin.visual.field.selectDarkThemeAria')} />
      </Row>
      <Row label={t('settings.appearancex.custom')} description={t('settings.appearancex.customHint')} item="appearance.theme-transfer">
        <Btn sm onClick={() => void copyTheme()}>{t('settings.appearancex.copyTheme')}</Btn>
        <Btn sm icon="upload" disabled={importing} onClick={() => fileInput.current?.click()}>{t('settings.common.actions.import')}</Btn>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) void file.text().then(importTheme).catch(() => setTransferMessage(t('settings.varin.visual.field.themeInvalid')));
        }} />
      </Row>
      <Disclosure label={t('settings.appearancex.pasteTheme')} summary={transferMessage || undefined}>
        <Pad>
          <Area mono rows={5} value={themeJson} placeholder={t('settings.varin.visual.field.pasteTheme')} aria-label={t('settings.varin.visual.field.pasteTheme')} onChange={event => setThemeJson(event.target.value)} />
          <div className="sk-hstack wrap" style={{ marginTop: 10 }}>
            <Btn sm kind="primary" disabled={importing || !themeJson.trim()} onClick={() => void importTheme(themeJson)}>{t('settings.varin.visual.field.importTheme')}</Btn>
            {currentImported ? <Btn sm kind="ghost-danger" disabled={importing} onClick={async () => {
              try { await theme.removeImportedTheme(theme.currentTheme.metadata.id); setTransferMessage(t('settings.varin.visual.field.themeRemoved')); }
              catch { setTransferMessage(t('settings.varin.visual.field.themeStorageError')); }
            }}>{t('settings.varin.visual.field.removeImportedTheme')}</Btn> : null}
            <span className="sk-grow" />
            <Btn sm kind="ghost" icon="restart" busy={reloading} disabled={theme.customThemesLoading || reloading} tip={t('settings.varin.visual.field.themeImportInfoTooltip')}
              onClick={() => { setReloading(true); void theme.reloadCustomThemes().finally(() => window.setTimeout(() => setReloading(false), 400)); }}>
              {reloading ? t('settings.varin.visual.actions.reloadingThemes') : t('settings.varin.visual.actions.reloadThemes')}
            </Btn>
          </div>
          {transferMessage ? <p role="status" className="sk-small sk-muted" style={{ margin: '8px 0 0' }}>{transferMessage}</p> : null}
        </Pad>
      </Disclosure>
    </Section>

    <Section title={t('settings.appearancex.tweaks')} description={t('settings.appearancex.tweaksHint', { theme: theme.currentTheme.metadata.name })}>
      {colorFields.map(([field, label, value]) => {
        const color = normalizeCustomColor(value) ?? '#808080';
        return <Row key={field} label={label} item={`appearance.custom-${field}`}>
          <input key={`${theme.currentTheme.metadata.id}-${field}-${color}`} className="sk-field sk-mono ws" defaultValue={color.toUpperCase()} maxLength={7} spellCheck={false} aria-label={`${label} HEX`}
            onBlur={(event) => { const next = normalizeCustomColor(event.target.value); if (next) theme.setCustomColor(theme.currentTheme.metadata.id, field, next); else event.target.value = color.toUpperCase(); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
          <label className="sk-swatch" style={{ background: color }} title={label}>
            <input type="color" value={color} aria-label={label} onChange={(event) => theme.setCustomColor(theme.currentTheme.metadata.id, field, event.target.value)} />
          </label>
        </Row>;
      })}
      <Row>
        <Btn kind="ghost" sm disabled={!theme.customColors[theme.currentTheme.metadata.id]} onClick={() => theme.resetCustomColors(theme.currentTheme.metadata.id)}>{t('settings.appearancex.resetColors')}</Btn>
      </Row>
    </Section>

    <Section title={t('settings.appearancex.type')}>
      {!isMobile ? <Row label={t('settings.varin.visual.field.interfaceFont')} item="appearance.interface-font">
        <Select value={uiFont} label={t('settings.varin.visual.field.selectInterfaceFontAria')} onChange={(value) => setUiFont(value as UiFontOption)}
          options={UI_FONT_OPTIONS.map(option => ({ value: option.id, text: option.label, label: <span style={{ fontFamily: option.stack }}>{option.label}</span> }))} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={uiFont === DEFAULT_UI_FONT} onClick={() => setUiFont(DEFAULT_UI_FONT)} />
      </Row> : null}
      {!isMobile ? <Row label={t('settings.appearancex.fontSize')} item="appearance.interface-font-size">
        <NumField value={fontSize} unit="%" integer min={50} max={200} label={t('settings.varin.visual.field.fontSizePercentageAria')} onCommit={value => { if (value) setFontSize(value); }} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={fontSize === 100} onClick={() => setFontSize(100)} />
      </Row> : null}
      <Row label={t('settings.appearancex.spacing')} description={t('settings.appearancex.spacingHint')} item="appearance.spacing-density">
        <NumField value={padding} unit="%" integer min={50} max={200} label={t('settings.appearancex.spacing')} onCommit={value => { if (value) setPadding(value); }} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={padding === 100} onClick={() => setPadding(100)} />
      </Row>
      {isMobile ? <Row label={t('settings.varin.visual.field.inputBarOffset')} description={t('settings.varin.visual.field.inputBarOffsetTooltip')} item="appearance.input-bar-offset">
        <NumField value={inputBarOffset} unit="px" integer min={0} max={100} label={t('settings.varin.visual.field.inputBarOffset')} onCommit={value => setInputBarOffset(value ?? 0)} />
      </Row> : null}
      <LinkRow label={t('settings.appearancex.codeFonts')} description={t('settings.appearancex.codeFontsHint', { font: CODE_FONT_OPTIONS.find(option => option.id === monoFont)?.label ?? monoFont })} onClick={() => shell.openPage('editor')} />
    </Section>

    <Section title={t('settings.varin.visual.section.motion')} raw item="appearance.motion" description={t('settings.appearancex.motionHint')}
      after={<>{motion === 'full' && motionLevel === 'reduced' ? <Note>{t('settings.varin.visual.option.motion.systemReduced')}</Note> : null}<After>{t('settings.kit.savedOnDevice')}</After></>}>
      <OptionCards value={motion} label={t('settings.varin.visual.section.motion')} onChange={(value: MotionPreference) => { setMotion(value); void updateDesktopSettings({ motionPreference: value }); }}
        options={[
          { value: 'full', label: t('settings.varin.visual.option.motion.full.label'), description: t('settings.varin.visual.option.motion.full.description') },
          { value: 'reduced', label: t('settings.varin.visual.option.motion.reduced.label'), description: t('settings.varin.visual.option.motion.reduced.description') },
          { value: 'off', label: t('settings.varin.visual.option.motion.off.label'), description: t('settings.varin.visual.option.motion.off.description') },
        ]} />
    </Section>

    {frameless || macVibrancySupported || dockBadgeSupported ? <Section title={t('settings.appearancex.window')}>
      {frameless ? <Row label={t('settings.varin.desktopNetwork.field.windowControlsPosition')} item="sessions.desktop-window-controls-position">
        <Seg value={controlsPosition} label={t('settings.varin.desktopNetwork.field.windowControlsPositionAria')}
          onChange={(value: DesktopWindowControlsPosition) => { setControlsPosition(value); void updateDesktopSettings({ desktopWindowControlsPosition: value }); }}
          options={[{ value: 'left', label: t('settings.varin.desktopNetwork.option.windowControlsLeft') }, { value: 'right', label: t('settings.varin.desktopNetwork.option.windowControlsRight') }]} />
      </Row> : null}
      {frameless ? <Row label={t('settings.varin.desktopNetwork.field.windowControlsStyle')} item="sessions.desktop-window-controls-style">
        <Seg value={controlsStyle} label={t('settings.varin.desktopNetwork.field.windowControlsStyleAria')}
          onChange={(value: DesktopWindowControlsStyle) => { setControlsStyle(value); void updateDesktopSettings({ desktopWindowControlsStyle: value }); }}
          options={[{ value: 'classic', label: t('settings.varin.desktopNetwork.option.windowControlsClassic') }, { value: 'traffic-lights', label: t('settings.varin.desktopNetwork.option.windowControlsTrafficLights') }]} />
      </Row> : null}
      {macVibrancySupported ? <Row label={t('settings.varin.visual.field.macVibrancy')} description={t('settings.varin.visual.field.macVibrancyHint')} item="appearance.window-transparency">
        {vibrancy !== macVibrancyEnabled ? <Btn sm kind="primary" busy={restarting} disabled={restarting} onClick={() => { setRestarting(true); void invokeDesktop('desktop_set_vibrancy', { enabled: vibrancy }).catch(() => setRestarting(false)); }}>
          {restarting ? t('settings.varin.visual.actions.restarting') : t('settings.varin.visual.actions.saveAndRestart')}
        </Btn> : null}
        <Sw checked={vibrancy} disabled={restarting} label={t('settings.varin.visual.field.macVibrancy')} onChange={setVibrancy} />
      </Row> : null}
      {dockBadgeSupported ? <Row label={t('settings.varin.visual.field.dockBadge')} description={t('settings.varin.visual.field.dockBadgeHint')} item="appearance.dock-badge">
        <Sw checked={dockBadge} label={t('settings.varin.visual.field.dockBadge')} onChange={setDockBadge} />
      </Row> : null}
    </Section> : null}
  </>;

  return <Page wide header={false} title={t('settings.page.appearance.title')}>
    <PreviewLayout preview={<ChatSettingsPreview scene={scene} onSceneChange={setScene} />}>
      <PageHeader title={t('settings.page.appearance.title')} description={t('settings.appearancex.description')} scope={<SettingsScopeLabel kind="mixed" />} />
      {form}
    </PreviewLayout>
  </Page>;
}
