import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, type MonoFontOption } from '@/lib/fontOptions';
import { updateDesktopSettings } from '@/lib/persistence';
import type { FileEditorAccessibilitySupport, FileEditorLineNumbers, FileEditorProfileToggle, FileEditorWhitespace } from '@/lib/file-editor-settings';
import { Btn, LinkRow, Note, NumField, Page, Row, Section, Seg, Select, Sw, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { TerminalShellSettings } from '@/components/sections/varin/TerminalShellSettings';

function CodeSample({ size, font }: { size: number; font: string }) {
  return <pre className="sk-mono" style={{ margin: 0, padding: '14px 16px', fontSize: size, lineHeight: 1.7, fontFamily: font, color: 'var(--sk-fg)', overflowX: 'auto' }}>
    <span style={{ color: 'var(--chart-1)' }}>export function</span> Welcome() {'{'}{'\n'}
    {'  '}<span style={{ color: 'var(--chart-1)' }}>const</span> message = <span style={{ color: 'var(--chart-2)' }}>"Ready"</span>;{'\n'}
    {'  '}<span style={{ color: 'var(--chart-1)' }}>return</span> {'<h1>{message}</h1>'};{'\n'}
    {'}'}
  </pre>;
}

/** 编辑器: fonts, display and editing behaviour when you open a file. */
export function EditorPage() {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const settings = useUIStore(state => state.fileEditorSettings);
  const update = useUIStore(state => state.updateFileEditorSettings);
  const reset = useUIStore(state => state.resetFileEditorSettings);
  const monoFont = useUIStore(state => state.monoFont);
  const setMonoFont = useUIStore(state => state.setMonoFont);
  const editorFontSize = useUIStore(state => state.editorFontSize);
  const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
  const keymap = useUIStore(state => state.fileEditorKeymap);
  const setKeymap = useUIStore(state => state.setFileEditorKeymap);
  const autoSave = useUIStore(state => state.autoSaveEnabled);
  const setAutoSave = useUIStore(state => state.setAutoSaveEnabled);
  const toolbar = useUIStore(state => state.expandedEditorToolbar);
  const setToolbar = useUIStore(state => state.setExpandedEditorToolbar);
  const stack = CODE_FONT_OPTIONS.find(option => option.id === monoFont)?.stack ?? 'var(--font-mono)';
  const follow = (key: 'wordWrap' | 'minimap' | 'stickyScroll', label: string, item: string) => <Row label={label} item={item}>
    <Seg value={settings[key]} label={label} onChange={(value: FileEditorProfileToggle) => update({ [key]: value })}
      options={[{ value: 'profile', label: t('settings.kit.followUi') }, { value: 'on', label: t('settings.kit.on') }, { value: 'off', label: t('settings.kit.off') }]} />
  </Row>;
  return <Page title={t('settings.page.editor.title')} description={t('settings.editorx.description')} scope={<SettingsScopeLabel kind="device" />}
    actions={<Btn kind="ghost" sm onClick={reset}>{t('settings.editorx.resetAll')}</Btn>}>
    <Section><CodeSample size={editorFontSize} font={stack} /></Section>
    <Section title={t('settings.editorx.fonts')}>
      <Row label={t('settings.varin.visual.field.codeFont')} item="editor.code-font">
        <Select value={monoFont} label={t('settings.varin.visual.field.selectCodeFontAria')} onChange={value => setMonoFont(value as MonoFontOption)}
          options={CODE_FONT_OPTIONS.map(option => ({ value: option.id, text: option.label, label: <span style={{ fontFamily: option.stack }}>{option.label}</span> }))} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={monoFont === DEFAULT_MONO_FONT} onClick={() => setMonoFont(DEFAULT_MONO_FONT)} />
      </Row>
      <Row label={t('settings.editorx.fontSize')} item="appearance.editor-font-size">
        <NumField value={editorFontSize} unit="px" integer min={9} max={32} label={t('settings.editorx.fontSize')} onCommit={value => { if (value) setEditorFontSize(value); }} />
      </Row>
      <Row label={t('settings.editorx.ligatures')} description={t('settings.editorx.ligaturesHint')}>
        <Sw checked={settings.fontLigatures} label={t('settings.editorx.ligatures')} onChange={fontLigatures => update({ fontLigatures })} />
      </Row>
    </Section>
    <Section title={t('settings.editorx.display')} description={t('settings.editorx.displayHint')} item="appearance.file-editor">
      {follow('wordWrap', t('settings.varin.editor.field.wordWrap'), 'editor.word-wrap')}
      {follow('minimap', t('settings.varin.editor.field.minimap'), 'editor.minimap')}
      {follow('stickyScroll', t('settings.varin.editor.field.stickyScroll'), 'editor.sticky-scroll')}
      <Row label={t('settings.varin.editor.field.lineNumbers')}>
        <Select width="ws" value={settings.lineNumbers} label={t('settings.varin.editor.field.lineNumbers')} onChange={(value: FileEditorLineNumbers) => update({ lineNumbers: value })}
          options={[{ value: 'profile', label: t('settings.kit.followUi') }, { value: 'on', label: t('settings.kit.on') }, { value: 'off', label: t('settings.kit.off') }, { value: 'relative', label: t('settings.varin.editor.option.relative') }]} />
      </Row>
      <Row label={t('settings.varin.editor.field.whitespace')}>
        <Select width="ws" value={settings.renderWhitespace} label={t('settings.varin.editor.field.whitespace')} onChange={(value: FileEditorWhitespace) => update({ renderWhitespace: value })}
          options={(['none', 'selection', 'boundary', 'trailing', 'all'] as const).map(value => ({ value, label: t(`settings.varin.editor.option.whitespace.${value}`) }))} />
      </Row>
      <Row label={t('settings.editorx.toolbar')} description={t('settings.editorx.toolbarHint')} item="appearance.expanded-editor-toolbar">
        <Sw checked={toolbar} label={t('settings.editorx.toolbar')} onChange={value => { setToolbar(value); void updateDesktopSettings({ expandedEditorToolbar: value }); }} />
      </Row>
      <Row label={t('settings.varin.editor.field.accessibility')}>
        <Select width="ws" value={settings.accessibilitySupport} label={t('settings.varin.editor.field.accessibility')} onChange={(value: FileEditorAccessibilitySupport) => update({ accessibilitySupport: value })}
          options={[{ value: 'auto', label: t('settings.kit.auto') }, { value: 'on', label: t('settings.kit.on') }, { value: 'off', label: t('settings.kit.off') }]} />
      </Row>
    </Section>
    <Section title={t('settings.varin.editor.group.indentation')}>
      <Row label={t('settings.editorx.detect')}><Sw checked={settings.detectIndentation} label={t('settings.editorx.detect')} onChange={detectIndentation => update({ detectIndentation })} /></Row>
      <Row label={t('settings.editorx.tabSize')} description={t('settings.editorx.tabSizeHint')}>
        <NumField value={settings.tabSize} unit={t('settings.editorx.spaces')} integer min={1} max={16} label={t('settings.editorx.tabSize')} onCommit={value => { if (value) update({ tabSize: value }); }} />
      </Row>
      <Row label={t('settings.editorx.insertSpaces')}><Sw checked={settings.insertSpaces} label={t('settings.editorx.insertSpaces')} onChange={insertSpaces => update({ insertSpaces })} /></Row>
    </Section>
    <Section title={t('settings.editorx.editing')}>
      <Row label={t('settings.editorx.keymap')} item="appearance.file-editor-keymap">
        <Select width="ws" value={keymap} label={t('settings.editorx.keymap')} onChange={(value: 'default' | 'vim') => setKeymap(value)}
          options={(['default', 'vim'] as const).map(value => ({ value, label: t(`settings.varin.visual.option.fileEditorKeymap.${value}`) }))} />
      </Row>
      <Row label={t('settings.varin.visual.field.autoSaveEnabled')} description={t('settings.varin.visual.field.autoSaveEnabledInfo')} item="appearance.auto-save-enabled">
        <Sw checked={autoSave} label={t('settings.varin.visual.field.autoSaveEnabled')} onChange={setAutoSave} />
      </Row>
      <Row label={t('settings.editorx.autoClosing')}>
        <Sw checked={settings.autoClosingBrackets && settings.autoClosingQuotes && settings.autoSurround} label={t('settings.editorx.autoClosing')}
          onChange={enabled => update({ autoClosingBrackets: enabled, autoClosingQuotes: enabled, autoSurround: enabled })} />
      </Row>
      <Row label={t('settings.editorx.folding')}><Sw checked={settings.folding} label={t('settings.editorx.folding')} onChange={folding => update({ folding })} /></Row>
      <Row label={t('settings.editorx.smooth')}><Sw checked={settings.smoothScrolling} label={t('settings.editorx.smooth')} onChange={smoothScrolling => update({ smoothScrolling })} /></Row>
      <Row label={t('settings.editorx.formatOnType')}><Sw checked={settings.formatOnType} label={t('settings.editorx.formatOnType')} onChange={formatOnType => update({ formatOnType })} /></Row>
      <Row label={t('settings.editorx.formatOnSave')} description={t('settings.editorx.formatOnSaveHint')}><Sw checked={settings.formatOnSave} label={t('settings.editorx.formatOnSave')} onChange={formatOnSave => update({ formatOnSave })} /></Row>
    </Section>
    {isMobile ? <Note>{t('settings.editorx.mobileNote')}</Note> : null}
  </Page>;
}

/** 终端: fonts and the shell for terminals you open yourself. */
export function TerminalPage() {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const shell = useSettingsShell();
  const size = useUIStore(state => state.terminalFontSize);
  const setSize = useUIStore(state => state.setTerminalFontSize);
  const monoFont = useUIStore(state => state.monoFont);
  const quickKeys = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
  const setQuickKeys = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
  const stack = CODE_FONT_OPTIONS.find(option => option.id === monoFont)?.stack ?? 'var(--font-mono)';
  return <Page title={t('settings.page.terminal.title')} description={t('settings.terminalx.description')} scope={<SettingsScopeLabel kind="device" />}>
    <Section>
      <pre className="sk-mono" style={{ margin: 0, padding: '14px 16px', fontSize: size, lineHeight: 1.6, fontFamily: stack, background: 'color-mix(in srgb, var(--foreground) 3%, transparent)' }}>
        $ git status{'\n'}On branch main{'\n'}nothing to commit, working tree clean{'\n'}$ <span style={{ background: 'var(--sk-fg)' }}>&nbsp;</span>
      </pre>
    </Section>
    <Section>
      <LinkRow label={t('settings.terminalx.font')} description={t('settings.terminalx.fontHint', { font: CODE_FONT_OPTIONS.find(option => option.id === monoFont)?.label ?? monoFont })} onClick={() => shell.openPage('editor', { item: 'editor.code-font' })} />
      <Row label={t('settings.terminalx.fontSize')} item="appearance.terminal-font-size">
        <NumField value={size} unit="px" integer min={9} max={52} label={t('settings.terminalx.fontSize')} onCommit={value => { if (value) setSize(value); }} />
        <Btn kind="ghost" sm icon="restart" tip={t('settings.common.actions.reset')} disabled={size === 13} onClick={() => setSize(13)} />
      </Row>
      {!isMobile ? <Row label={t('settings.varin.visual.field.terminalQuickKeys')} description={t('settings.varin.visual.field.terminalQuickKeysTooltip')} item="appearance.terminal-quick-keys">
        <Sw checked={quickKeys} label={t('settings.varin.visual.field.terminalQuickKeys')} onChange={setQuickKeys} />
      </Row> : null}
    </Section>
    <Section title={t('settings.terminalx.shell')} description={t('settings.terminalx.shellHint')}
      after={<Note>{t('settings.terminalx.agentShell')} <button type="button" className="sk-link" onClick={() => shell.openPage('harness-tools')}>{t('settings.page.harness.page.tools.title')}</button></Note>}>
      <TerminalShellSettings />
    </Section>
    <Section>
      <LinkRow label={t('settings.terminalx.shortcuts')} description={t('settings.terminalx.shortcutsHint')} onClick={() => shell.openPage('shortcuts')} />
    </Section>
  </Page>;
}
