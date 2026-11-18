import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_CHAT_CONTENT_WIDTH, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { fetchWebSettings, updateDesktopSettings } from '@/lib/persistence';
import { setDirectoryShowHidden, useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useHarnessSettings } from '@/components/sections/harness/useHarnessSettings';
import { Note, NumField, OptionCards, Page, PageHeader, Row, Section, Seg, Sw, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { ChatSettingsPreview, type ChatPreviewScene } from '@/components/sections/varin/ChatSettingsPreview';
import { PreviewLayout, ReadingArt } from './PreviewLayout';

const WIDTHS = [768, 960, 1152, 0] as const;

/** 聊天: how replies read, how the composer behaves, and how code and files show. The example follows each setting. */
export function ChatPage() {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const shell = useSettingsShell();
  const [scene, setScene] = React.useState<ChatPreviewScene>('conversation');
  const s = useUIStore(useShallow(state => ({
    chatRenderMode: state.chatRenderMode, activityRenderMode: state.activityRenderMode,
    userMessageRenderingMode: state.userMessageRenderingMode, collapsibleUserMessages: state.collapsibleUserMessages,
    stickyUserHeader: state.stickyUserHeader, promptNavigatorEnabled: state.promptNavigatorEnabled,
    showReasoningTraces: state.showReasoningTraces, collapsibleThinkingBlocks: state.collapsibleThinkingBlocks,
    showGenerationSpeed: state.showGenerationSpeed, showExpandedBashTools: state.showExpandedBashTools, showExpandedEditTools: state.showExpandedEditTools,
    codeBlockLineWrap: state.codeBlockLineWrap, diffLayoutPreference: state.diffLayoutPreference, mermaidRenderingMode: state.mermaidRenderingMode,
    showToolFileIcons: state.showToolFileIcons, showTurnChangedFiles: state.showTurnChangedFiles, draftStartersVisible: state.draftStartersVisible,
    persistChatDraft: state.persistChatDraft, inputSpellcheckEnabled: state.inputSpellcheckEnabled, chatContentWidth: state.chatContentWidth,
    showDeletionDialog: state.showDeletionDialog,
  })));
  const ui = useUIStore.getState();
  const save = <K extends string>(key: K, value: unknown, apply: (value: never) => void) => { apply(value as never); void updateDesktopSettings({ [key]: value } as never); };
  const followUp = useMessageQueueStore(state => state.followUpBehavior);
  const setFollowUp = useMessageQueueStore(state => state.setFollowUpBehavior);
  const botFollowUp = useMessageQueueStore(state => state.botFollowUpBehavior);
  const setBotFollowUp = useMessageQueueStore(state => state.setBotFollowUpBehavior);
  const hiddenFiles = useDirectoryShowHidden();
  const filePreview = usePreferencesStore(state => state.settingsDefaultFileViewerPreview);
  const setFilePreview = (enabled: boolean) => {
    usePreferencesStore.getState().setSettingsDefaultFileViewerPreview(enabled);
    void updateDesktopSettings({ defaultFileViewerPreview: enabled });
    window.dispatchEvent(new CustomEvent('varin:file-viewer-preview-mode-changed', { detail: { enabled } }));
  };
  const harness = useHarnessSettings();
  const nextStepOn = Boolean(harness.harness && harness.harness.nextStep.enabled && harness.harness.models.nextStep?.enabled !== false);
  const inactivity = useBotInactivity();

  const widthPreset = (WIDTHS as readonly number[]).includes(s.chatContentWidth) ? String(s.chatContentWidth) : 'custom';
  const [customWidth, setCustomWidth] = React.useState(widthPreset === 'custom');
  const showCustom = customWidth || widthPreset === 'custom';
  const applyWidth = (value: number) => { ui.setChatContentWidth(value); void updateDesktopSettings({ chatContentWidth: value }); };
  const sceneFor = (next: ChatPreviewScene) => ({ onFocusCapture: () => setScene(next), onPointerDownCapture: () => setScene(next) });

  const form = <>
    <div {...sceneFor('conversation')}>
      <Section title={t('settings.chatx.replies')} item="chat.render-mode" raw after={<div className="sk-panel" style={{ marginTop: 10 }}>
        {s.chatRenderMode === 'dialogue' ? <Note inPanel>{t('settings.chatx.dialogueNote')}</Note> : null}
        {s.chatRenderMode === 'sorted' ? <Row label={t('settings.chat.activity')} item="chat.activity-display">
          <Seg value={s.activityRenderMode} label={t('settings.chat.activity')} onChange={value => save('activityRenderMode', value, ui.setActivityRenderMode)}
            options={[{ value: 'collapsed', label: t('settings.chatx.collapsedByDefault') }, { value: 'summary', label: t('settings.chatx.expandedByDefault') }]} />
        </Row> : null}
        <Row label={t('settings.chatx.showThinking')} item="chat.reasoning-traces"><Sw checked={s.showReasoningTraces} label={t('settings.chatx.showThinking')} onChange={ui.setShowReasoningTraces} /></Row>
        <Row label={t('settings.chatx.autoExpandThinking')} description={t('settings.chatx.autoExpandThinkingHint')} sub dim={!s.showReasoningTraces} item="chat.reasoning">
          <Sw checked={!s.collapsibleThinkingBlocks} disabled={!s.showReasoningTraces} label={t('settings.chatx.autoExpandThinking')} onChange={value => ui.setCollapsibleThinkingBlocks(!value)} />
        </Row>
        <Row label={t('settings.chatx.expandCommands')} item="chat.expanded-tools"><Sw checked={s.showExpandedBashTools} label={t('settings.chatx.expandCommands')} onChange={value => save('showExpandedBashTools', value, ui.setShowExpandedBashTools)} /></Row>
        <Row label={t('settings.chatx.expandEdits')}><Sw checked={s.showExpandedEditTools} label={t('settings.chatx.expandEdits')} onChange={value => save('showExpandedEditTools', value, ui.setShowExpandedEditTools)} /></Row>
        <Row label={t('settings.chatx.speed')} description={t('settings.chatx.speedHint')} item="chat.generation-speed"><Sw checked={s.showGenerationSpeed} label={t('settings.chatx.speed')} onChange={ui.setShowGenerationSpeed} /></Row>
      </div>}>
        <OptionCards value={s.chatRenderMode} label={t('settings.chatx.replies')} onChange={value => save('chatRenderMode', value, ui.setChatRenderMode)}
          options={[
            { value: 'dialogue', label: t('settings.chatx.dialogue'), description: t('settings.chatx.dialogueHint'), art: <ReadingArt kind="dialogue" /> },
            { value: 'live', label: t('settings.chatx.live'), description: t('settings.chatx.liveHint'), art: <ReadingArt kind="live" /> },
            { value: 'sorted', label: t('settings.chatx.sorted'), description: t('settings.chatx.sortedHint'), art: <ReadingArt kind="sorted" /> },
          ]} />
      </Section>

      <Section title={t('settings.chat.reading')} item="chat.message-appearance">
        <Row label={t('settings.chat.width.title')} description={t('settings.chatx.widthHint')} item="chat.content-width">
          <Seg value={showCustom ? 'custom' : widthPreset} label={t('settings.chat.width.title')}
            onChange={value => { if (value === 'custom') { setCustomWidth(true); if (!s.chatContentWidth) applyWidth(DEFAULT_CHAT_CONTENT_WIDTH); return; } setCustomWidth(false); applyWidth(Number(value)); }}
            options={[
              { value: '768', label: t('settings.chat.width.compact') }, { value: '960', label: t('settings.chat.width.comfortable') },
              { value: '1152', label: t('settings.chat.width.wide') }, { value: '0', label: t('settings.chat.width.full') }, { value: 'custom', label: t('settings.chatx.custom') },
            ]} />
        </Row>
        {showCustom ? <Row label={t('settings.chatx.customWidth')} sub>
          <NumField value={s.chatContentWidth || DEFAULT_CHAT_CONTENT_WIDTH} unit="px" integer min={320} label={t('settings.chatx.customWidth')} onCommit={value => { if (value) applyWidth(value); }} />
        </Row> : null}
        <Row label={t('settings.chatx.mine')}>
          <Seg value={s.userMessageRenderingMode} label={t('settings.chatx.mine')} onChange={value => save('userMessageRenderingMode', value, ui.setUserMessageRenderingMode)}
            options={[{ value: 'plain', label: t('settings.varin.visual.option.userMessageRendering.plain.label') }, { value: 'markdown', label: 'Markdown' }]} />
        </Row>
        <Row label={t('settings.chatx.collapseMine')} item="chat.collapsible-user-messages"><Sw checked={s.collapsibleUserMessages} label={t('settings.chatx.collapseMine')} onChange={value => save('collapsibleUserMessages', value, ui.setCollapsibleUserMessages)} /></Row>
        <Row label={t('settings.chatx.sticky')} description={t('settings.chatx.stickyHint')} item="chat.sticky-user-header"><Sw checked={s.stickyUserHeader} label={t('settings.chatx.sticky')} onChange={value => save('stickyUserHeader', value, ui.setStickyUserHeader)} /></Row>
        <Row label={t('settings.chatx.navigator')} description={t('settings.chatx.navigatorHint')} item="chat.prompt-navigator"><Sw checked={s.promptNavigatorEnabled} label={t('settings.chatx.navigator')} onChange={value => save('promptNavigatorEnabled', value, ui.setPromptNavigatorEnabled)} /></Row>
      </Section>
    </div>

    <div {...sceneFor('input')}>
      <Section title={t('settings.chat.input')} item="chat.composer">
        <Row label={t('settings.chatx.botBusy')} description={t('settings.chatx.botBusyHint')} item="chat.bot-follow-up-behavior">
          <Seg value={botFollowUp} label={t('settings.chatx.botBusy')} onChange={setBotFollowUp}
            options={[{ value: 'steer', label: t('settings.chatx.steer') }, { value: 'queue', label: t('settings.chatx.queue') }]} />
        </Row>
        <Row label={t('settings.chatx.workbenchBusy')} description={t('settings.chatx.workbenchBusyHint')} item="chat.follow-up-behavior">
          <Seg value={followUp} label={t('settings.chatx.workbenchBusy')} onChange={setFollowUp}
            options={[{ value: 'steer', label: t('settings.chatx.steer') }, { value: 'queue', label: t('settings.chatx.queue') }]} />
        </Row>
        <Row label={t('settings.chatx.nextStep')} item="harness.next-step"
          description={<>{t('settings.chatx.nextStepHint')} <button type="button" className="sk-link" onClick={() => shell.openPage('model-roles', { item: 'harness.models.nextStep' })}>{t('settings.roles.title')}</button></>}
          error={harness.error ?? undefined}>
          <Sw checked={nextStepOn} disabled={!harness.harness} label={t('settings.chatx.nextStep')}
            onChange={enabled => harness.update({ nextStep: { enabled }, models: { nextStep: { enabled } } })} />
        </Row>
        <Row label={t('settings.chatx.idle')} description={t('settings.chatx.idleHint')} item="chat.bot-task-inactivity" error={inactivity.error ? t('settings.chat.botInactivityError') : undefined}>
          <NumField value={inactivity.minutes ? inactivity.minutes : null} allowEmpty integer min={1} placeholder={t('settings.chatx.idleOff')} unit={t('settings.chat.botInactivityMinutes')}
            disabled={inactivity.minutes === undefined || inactivity.saving} label={t('settings.chatx.idle')} onCommit={value => void inactivity.save(value ?? 0)} />
        </Row>
        <Row label={t('settings.chatx.keepDraft')} item="chat.persist-drafts"><Sw checked={s.persistChatDraft} label={t('settings.chatx.keepDraft')} onChange={ui.setPersistChatDraft} /></Row>
        {!isMobile ? <Row label={t('settings.chatx.spellcheck')} item="chat.spellcheck"><Sw checked={s.inputSpellcheckEnabled} label={t('settings.chatx.spellcheck')} onChange={value => save('inputSpellcheckEnabled', value, ui.setInputSpellcheckEnabled)} /></Row> : null}
        <Row label={t('settings.chatx.starters')} item="chat.draft-starters-visible"><Sw checked={s.draftStartersVisible} label={t('settings.chatx.starters')} onChange={value => save('draftStartersVisible', value, ui.setDraftStartersVisible)} /></Row>
      </Section>
    </div>

    <div {...sceneFor('files')}>
      <Section title={t('settings.chatx.files')} item="chat.tools-and-files">
        <Row label={t('settings.chatx.diff')} description={t('settings.chatx.diffHint')} item="editor.diff-layout">
          <Seg value={s.diffLayoutPreference} label={t('settings.chatx.diff')} onChange={ui.setDiffLayoutPreference}
            options={[{ value: 'dynamic', label: t('settings.kit.auto') }, { value: 'inline', label: t('settings.varin.visual.option.diffLayout.inline.label') }, { value: 'side-by-side', label: t('settings.varin.visual.option.diffLayout.sideBySide.label') }]} />
        </Row>
        <Row label={t('settings.chatx.diagrams')} item="chat.diagram-format">
          <Seg value={s.mermaidRenderingMode} label={t('settings.chatx.diagrams')} onChange={value => save('mermaidRenderingMode', value, ui.setMermaidRenderingMode)}
            options={[{ value: 'svg', label: t('settings.chat.graphic') }, { value: 'ascii', label: t('settings.chat.textDiagram') }]} />
        </Row>
        <Row label={t('settings.chatx.wrap')} item="chat.code-block-line-wrap"><Sw checked={s.codeBlockLineWrap} label={t('settings.chatx.wrap')} onChange={ui.setCodeBlockLineWrap} /></Row>
        <Row label={t('settings.chatx.icons')} item="chat.tool-file-icons"><Sw checked={s.showToolFileIcons} label={t('settings.chatx.icons')} onChange={value => save('showToolFileIcons', value, ui.setShowToolFileIcons)} /></Row>
        <Row label={t('settings.chatx.changed')} item="chat.changed-files"><Sw checked={s.showTurnChangedFiles} label={t('settings.chatx.changed')} onChange={value => { setScene('conversation'); save('showTurnChangedFiles', value, ui.setShowTurnChangedFiles); }} /></Row>
        <Row label={t('settings.chatx.preview')} description={t('settings.chatx.previewHint')} item="chat.file-viewer-preview"><Sw checked={filePreview} label={t('settings.chatx.preview')} onChange={setFilePreview} /></Row>
        <Row label={t('settings.chatx.dotfiles')} item="chat.dotfiles"><Sw checked={hiddenFiles} label={t('settings.chatx.dotfiles')} onChange={setDirectoryShowHidden} /></Row>
      </Section>
    </div>

    <Section title={t('settings.chatx.confirm')} item="sessions.deletion-dialog">
      <Row label={t('settings.chatx.confirmDelete')}><Sw checked={s.showDeletionDialog} label={t('settings.chatx.confirmDelete')} onChange={ui.setShowDeletionDialog} /></Row>
    </Section>
  </>;

  return <Page wide header={false} title={t('settings.page.chat.title')}>
    <PreviewLayout preview={<ChatSettingsPreview scene={scene} onSceneChange={setScene} />}>
      <PageHeader title={t('settings.page.chat.title')} description={t('settings.chatx.description')} scope={<SettingsScopeLabel kind="mixed" />} />
      {form}
    </PreviewLayout>
  </Page>;
}

/** Host-wide reminder when a Bot's delegated task stops making progress; 0 turns it off. */
function useBotInactivity() {
  const [minutes, setMinutes] = React.useState<number>();
  const [error, setError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const generation = React.useRef(0);
  React.useEffect(() => {
    let closed = false;
    const load = async () => {
      const current = ++generation.current; setMinutes(undefined); setSaving(false);
      const settings = await fetchWebSettings();
      if (closed || current !== generation.current) return;
      if (!settings) { setError(true); return; }
      setMinutes(settings.botTaskInactivityMinutes ?? 20); setError(false);
    };
    void load();
    const dispose = subscribeRuntimeEndpointChanged(() => void load());
    return () => { closed = true; generation.current += 1; dispose(); };
  }, []);
  const save = async (value: number) => {
    const current = generation.current;
    setSaving(true);
    const saved = await updateDesktopSettings({ botTaskInactivityMinutes: value });
    if (current !== generation.current) return;
    setSaving(false); setError(!saved);
    if (saved) setMinutes(value);
  };
  return { minutes, error, saving, save };
}
