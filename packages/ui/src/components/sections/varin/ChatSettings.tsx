import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/useUIStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { updateDesktopSettings } from '@/lib/persistence';
import { setDirectoryShowHidden, useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { SettingsSection, SettingsFieldRow, SettingsChipGroup } from '../shared/SettingsSection';
import { SettingsInfoHint } from '../shared/SettingsInfoHint';
import { ChatWidthSettings } from './ChatWidthSettings';

const Toggle: React.FC<{
  label: string; checked: boolean; onChange: (value: boolean) => void; item?: string; info?: string;
}> = ({ label, checked, onChange, item, info }) => {
  const id = React.useId();
  return <div data-settings-item={item} className="flex min-h-11 items-center gap-3 py-2">
    <label htmlFor={id} className="flex-1 cursor-pointer typography-ui-label">{label}</label>
    {info ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
    <Switch id={id} checked={checked} onCheckedChange={onChange} />
  </div>;
};

export const ChatSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const state = useUIStore(useShallow(s => ({
    chatRenderMode: s.chatRenderMode, activityRenderMode: s.activityRenderMode,
    userMessageRenderingMode: s.userMessageRenderingMode, collapsibleUserMessages: s.collapsibleUserMessages,
    stickyUserHeader: s.stickyUserHeader, promptNavigatorEnabled: s.promptNavigatorEnabled,
    showReasoningTraces: s.showReasoningTraces, collapsibleThinkingBlocks: s.collapsibleThinkingBlocks,
    showExpandedBashTools: s.showExpandedBashTools, showExpandedEditTools: s.showExpandedEditTools,
    codeBlockLineWrap: s.codeBlockLineWrap, diffLayoutPreference: s.diffLayoutPreference,
    mermaidRenderingMode: s.mermaidRenderingMode, showToolFileIcons: s.showToolFileIcons,
    showTurnChangedFiles: s.showTurnChangedFiles,
    draftStartersVisible: s.draftStartersVisible,
    persistChatDraft: s.persistChatDraft, inputSpellcheckEnabled: s.inputSpellcheckEnabled,
  })));
  const actions = useUIStore.getState();
  const followUpBehavior = useMessageQueueStore(s => s.followUpBehavior);
  const setFollowUpBehavior = useMessageQueueStore(s => s.setFollowUpBehavior);
  const directoryShowHidden = useDirectoryShowHidden();
  const previewFiles = usePreferencesStore(s => s.settingsDefaultFileViewerPreview);
  const changePreviewFiles = (enabled: boolean) => {
    usePreferencesStore.getState().setSettingsDefaultFileViewerPreview(enabled);
    void updateDesktopSettings({ defaultFileViewerPreview: enabled });
    window.dispatchEvent(new CustomEvent('varin:file-viewer-preview-mode-changed', { detail: { enabled } }));
  };
  const save = <K extends keyof typeof state>(key: K, value: (typeof state)[K], setter: (value: (typeof state)[K]) => void) => {
    setter(value);
    void updateDesktopSettings({ [key]: value });
  };

  return <div>
    <SettingsSection divider={false} title={t('settings.chat.reading')} settingsItem="chat.message-appearance" contentClassName="space-y-4">
      <ChatWidthSettings />
      <SettingsFieldRow label={t('settings.chat.userFormat')}>
        <SettingsChipGroup aria-label={t('settings.chat.userFormat')} value={state.userMessageRenderingMode}
          onChange={value => save('userMessageRenderingMode', value, actions.setUserMessageRenderingMode)}
          options={[{ value: 'plain', label: t('settings.varin.visual.option.userMessageRendering.plain.label') }, { value: 'markdown', label: 'Markdown' }]} />
      </SettingsFieldRow>
      <div className="divide-y divide-border/40">
        <Toggle label={t('settings.chat.collapseUser')} item="chat.collapsible-user-messages" checked={state.collapsibleUserMessages}
          onChange={v => save('collapsibleUserMessages', v, actions.setCollapsibleUserMessages)} />
        <Toggle label={t('settings.chat.stickyUser')} item="chat.sticky-user-header" checked={state.stickyUserHeader}
          info={t('settings.chat.stickyUserHint')} onChange={v => save('stickyUserHeader', v, actions.setStickyUserHeader)} />
        <Toggle label={t('settings.chat.navigator')} item="chat.prompt-navigator" checked={state.promptNavigatorEnabled}
          onChange={v => save('promptNavigatorEnabled', v, actions.setPromptNavigatorEnabled)} />
      </div>
    </SettingsSection>

    <SettingsSection title={t('settings.chat.execution')} settingsItem="chat.activity-display" contentClassName="space-y-5">
      <div data-settings-item="chat.render-mode" role="group" aria-label={t('settings.chat.replyLayout')}
        className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        {(['live', 'sorted'] as const).map(mode => <button key={mode} type="button"
          aria-pressed={state.chatRenderMode === mode} onClick={() => save('chatRenderMode', mode, actions.setChatRenderMode)}
          className={cn('rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            state.chatRenderMode === mode ? 'border-primary/65 bg-interactive-selection' : 'border-border/60 hover:bg-interactive-hover')}>
          <span className="flex items-center gap-2 typography-ui-label font-medium"><Icon name={mode === 'live' ? 'list-check-2' : 'stack'} className="size-4" />
            {t(mode === 'live' ? 'settings.chat.live' : 'settings.chat.sorted')}
            {state.chatRenderMode === mode ? <Icon name="check" className="ml-auto size-4" /> : null}
          </span>
          <span className="mt-2 block typography-meta text-muted-foreground">{t(mode === 'live' ? 'settings.chat.liveHint' : 'settings.chat.sortedHint')}</span>
        </button>)}
      </div>
      {state.chatRenderMode === 'sorted' ? <SettingsFieldRow label={t('settings.chat.activity')}>
        <SettingsChipGroup aria-label={t('settings.chat.activity')} value={state.activityRenderMode}
          onChange={v => save('activityRenderMode', v, actions.setActivityRenderMode)}
          options={[{ value: 'collapsed', label: t('settings.chat.collapsed') }, { value: 'summary', label: t('settings.chat.expanded') }]} />
      </SettingsFieldRow> : null}
      <div data-settings-item="chat.reasoning" className="divide-y divide-border/40">
        <Toggle label={t('settings.chat.thinking')} item="chat.reasoning-traces" checked={state.showReasoningTraces}
          onChange={actions.setShowReasoningTraces} />
        {state.showReasoningTraces ? <div className="pl-5"><Toggle label={t('settings.chat.collapseThinking')} checked={state.collapsibleThinkingBlocks}
          onChange={actions.setCollapsibleThinkingBlocks} /></div> : null}
      </div>
      <div data-settings-item="chat.expanded-tools" className="rounded-lg bg-muted/20 px-4 py-1">
        <Toggle label={t('settings.chat.expandCommands')} checked={state.showExpandedBashTools}
          onChange={v => save('showExpandedBashTools', v, actions.setShowExpandedBashTools)} />
        <Toggle label={t('settings.chat.expandEdits')} checked={state.showExpandedEditTools}
          onChange={v => save('showExpandedEditTools', v, actions.setShowExpandedEditTools)} />
      </div>
    </SettingsSection>

    <SettingsSection title={t('settings.chat.input')} settingsItem="chat.composer" contentClassName="space-y-4">
      <div data-settings-item="chat.follow-up-behavior" className="space-y-3">
        <div className="typography-ui-label">{t('settings.chat.busySend')}</div>
        <SettingsChipGroup aria-label={t('settings.chat.busySend')} value={followUpBehavior} onChange={setFollowUpBehavior}
          options={[{ value: 'queue', label: t('settings.varin.visual.option.followUpBehavior.queue.label') }, { value: 'steer', label: t('settings.varin.visual.option.followUpBehavior.steer.label') }]} />
        <p className="typography-meta text-muted-foreground">{t(followUpBehavior === 'queue' ? 'settings.chat.queueHint' : 'settings.chat.steerHint')}</p>
      </div>
      <div className="divide-y divide-border/40">
        <Toggle label={t('settings.chat.keepDraft')} item="chat.persist-drafts" checked={state.persistChatDraft}
          onChange={actions.setPersistChatDraft} />
        {!isMobile ? <Toggle label={t('settings.chat.spellcheck')} item="chat.spellcheck" checked={state.inputSpellcheckEnabled}
          onChange={v => save('inputSpellcheckEnabled', v, actions.setInputSpellcheckEnabled)} /> : null}
        <Toggle label={t('settings.chat.starters')} item="chat.draft-starters-visible" checked={state.draftStartersVisible}
          onChange={v => save('draftStartersVisible', v, actions.setDraftStartersVisible)} />
      </div>
    </SettingsSection>

    <SettingsSection title={t('settings.chat.files')} settingsItem="chat.tools-and-files" contentClassName="space-y-4">
      <SettingsFieldRow label={t('settings.chat.diff')} settingsItem="editor.diff-layout">
        <SettingsChipGroup aria-label={t('settings.chat.diff')} value={state.diffLayoutPreference} onChange={actions.setDiffLayoutPreference}
          options={[{ value: 'dynamic', label: t('settings.varin.visual.option.diffLayout.dynamic.label') }, { value: 'inline', label: t('settings.varin.visual.option.diffLayout.inline.label') }, { value: 'side-by-side', label: t('settings.varin.visual.option.diffLayout.sideBySide.label') }]} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.chat.diagrams')} settingsItem="chat.diagram-format">
        <SettingsChipGroup aria-label={t('settings.chat.diagrams')} value={state.mermaidRenderingMode}
          onChange={v => save('mermaidRenderingMode', v, actions.setMermaidRenderingMode)}
          options={[{ value: 'svg', label: t('settings.chat.graphic') }, { value: 'ascii', label: t('settings.chat.textDiagram') }]} />
      </SettingsFieldRow>
      <div className="divide-y divide-border/40">
        <Toggle label={t('settings.chat.wrapCode')} item="chat.code-block-line-wrap" checked={state.codeBlockLineWrap} onChange={actions.setCodeBlockLineWrap} />
        <Toggle label={t('settings.chat.fileIcons')} item="chat.tool-file-icons" checked={state.showToolFileIcons}
          onChange={v => save('showToolFileIcons', v, actions.setShowToolFileIcons)} />
        <Toggle label={t('settings.chat.changedFiles')} item="chat.changed-files" checked={state.showTurnChangedFiles}
          onChange={v => save('showTurnChangedFiles', v, actions.setShowTurnChangedFiles)} />
        <Toggle label={t('settings.varin.defaults.field.openFilesPreview')} item="chat.file-viewer-preview" checked={previewFiles} onChange={changePreviewFiles} />
        <Toggle label={t('settings.varin.visual.field.showDotfiles')} item="chat.dotfiles" checked={directoryShowHidden} onChange={setDirectoryShowHidden} />
      </div>
    </SettingsSection>
  </div>;
};
