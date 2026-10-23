import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/useUIStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useI18n } from '@/lib/i18n';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ChatTimelineEntryList, ChatTurnUserMessage } from '@/components/conversation/ChatTimelineEntries';
import { ChatTurnAssistantChrome } from '@/components/conversation/ChatTurnAssistantChrome';
import { ConversationContext, ConversationPreviewContext } from '@/components/conversation/ConversationContext';
import { projectChatTimeline } from '@/components/conversation/chatTimelineProjection';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import './chat-settings-preview.css';
import { createChatPreviewEntries, createDialoguePreview, CHAT_PREVIEW_CODE } from './chatSettingsPreviewData';

export type ChatPreviewScene = 'conversation' | 'files' | 'input';
const BEFORE = 'export const validate = (input: string) => {\n  if (!input) return true;\n  return input.trim().length > 0;\n};\n';
const AFTER = BEFORE.replace('return true', 'return false');

export function ChatSettingsPreview({ scene, onSceneChange }: { scene: ChatPreviewScene; onSceneChange(scene: ChatPreviewScene): void }) {
  const { t } = useI18n();
  const state = useUIStore(useShallow(s => ({ width: s.chatContentWidth, sticky: s.stickyUserHeader, navigator: s.promptNavigatorEnabled,
    layout: s.chatRenderMode, activity: s.activityRenderMode, commands: s.showExpandedBashTools, edits: s.showExpandedEditTools,
    fontSize: s.fontSize, padding: s.padding, diff: s.diffLayoutPreference, wrap: s.codeBlockLineWrap, icons: s.showToolFileIcons,
    persistDraft: s.persistChatDraft, spellcheck: s.inputSpellcheckEnabled, starters: s.draftStartersVisible })));
  const filePreview = usePreferencesStore(s => s.settingsDefaultFileViewerPreview);
  const followUp = useMessageQueueStore(s => s.followUpBehavior);
  const hiddenFiles = useDirectoryShowHidden();
  const [folded, setFolded] = React.useState(false);
  const [reset, setReset] = React.useState(0);
  const [fileOpen, setFileOpen] = React.useState(true);
  const [busy, setBusy] = React.useState(true);
  const [draft, setDraft] = React.useState('');
  const [sent, setSent] = React.useState<{ text: string; mode: 'sent' | 'queued' | 'steered' }>();
  const viewport = React.useRef<HTMLDivElement>(null);
  const [activityStep, setActivityStep] = React.useState(0);
  const dialogueExample = React.useMemo(() => state.layout === 'dialogue' ? createDialoguePreview(t, activityStep) : undefined, [state.layout, t, activityStep]);
  const entries = React.useMemo(() => dialogueExample?.entries ?? createChatPreviewEntries(t), [t, dialogueExample]);
  const projection = React.useMemo(() => projectChatTimeline(entries), [entries]);
  const item = projection.items[0];
  const turn = item?.kind === 'turn' ? item.turn : undefined;
  const bodyId = React.useId();
  const tabs = React.useRef<Partial<Record<ChatPreviewScene, HTMLButtonElement>>>({});
  const resetExample = () => { setReset(value => value + 1); setActivityStep(0); setDraft(''); setSent(undefined); setBusy(true); setFileOpen(false); onSceneChange('conversation'); viewport.current?.scrollTo({ top: 0 }); };
  const diagram = `\`\`\`mermaid\nflowchart LR\n  A["${t('settings.chat.preview.diagram')}"] --> B["${t('settings.chat.preview.diagramCheck')}"] --> C["${t('settings.chat.preview.diagramValid')}"]\n\`\`\``;

  return <aside className="settings-chat-preview" aria-label={t('settings.chat.preview.title')}>
    <header className="flex min-h-12 items-center gap-2 border-b border-border/60 px-4">
      <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />
      <strong className="typography-meta font-medium">{t('settings.chat.preview.title')}</strong>
      <span className="hidden typography-micro text-muted-foreground @sm:inline">{t('settings.chat.preview.subtitle')}</span>
      <Button type="button" variant="ghost" size="icon" className="ml-auto size-7" aria-label={t('settings.chat.preview.disclosure')} aria-controls={bodyId} aria-expanded={!folded} onClick={() => setFolded(value => !value)}>
        <Icon name={folded ? 'arrow-down-s' : 'arrow-up-s'} className="size-4" />
      </Button>
    </header>
    <div id={bodyId} hidden={folded}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border/50 bg-muted/20 p-2" role="tablist" aria-label={t('settings.chat.preview.title')}>
        {(['conversation', 'files', 'input'] as const).map(value => <button key={value} type="button" role="tab" id={`${bodyId}-${value}`} aria-controls={`${bodyId}-scene`} aria-selected={scene === value} tabIndex={scene === value ? 0 : -1}
          ref={node => { if (node) tabs.current[value] = node; }}
          onKeyDown={event => {
            const scenes: ChatPreviewScene[] = ['conversation', 'files', 'input'];
            const next = event.key === 'Home' ? scenes[0] : event.key === 'End' ? scenes[2] : event.key === 'ArrowRight' ? scenes[(scenes.indexOf(value) + 1) % 3] : event.key === 'ArrowLeft' ? scenes[(scenes.indexOf(value) + 2) % 3] : undefined;
            if (next) { event.preventDefault(); onSceneChange(next); tabs.current[next]?.focus(); }
          }}
          className={cn('rounded-md px-2.5 py-1.5 typography-meta', scene === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          onClick={() => { onSceneChange(value); viewport.current?.scrollTo({ top: 0 }); }}>{t(`settings.chat.preview.${value}`)}</button>)}
        {scene === 'conversation' && <span className="ml-auto px-1 typography-micro tabular-nums text-muted-foreground">{state.width ? `${state.width} px` : t('settings.chat.width.full')}</span>}
      </div>
      <div ref={viewport} className="settings-chat-preview-viewport" id={`${bodyId}-scene`} role="tabpanel" aria-labelledby={`${bodyId}-${scene}`}>
        {/* Explicitly shadow any enclosing live owner. No extension renderer or real file action runs here. */}
        <ConversationContext.Provider value={null}><ConversationPreviewContext.Provider value>
          {scene === 'conversation' && turn ? <div className="relative px-4 py-5" style={{ fontSize: `${state.fontSize}%`, paddingBlock: `${20 * state.padding / 100}px` }}>
            {dialogueExample && <div className="mb-3 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setActivityStep(value => (value + 1) % 3)}>{t('settings.chat.preview.nextActivity')}</Button></div>}
            <div className="mx-auto space-y-4 transition-[width]" style={{ width: state.width ? `${Math.min(100, Math.max(30, state.width / 1152 * 100))}%` : '100%' }}>
              <div className={cn(state.sticky && 'sticky top-0 z-10 rounded-lg bg-background/95 py-1 backdrop-blur-sm')}>
                <ChatTurnUserMessage key={`user:${reset}`} cwd="" entry={turn.userEntry} message={turn.user} />
              </div>
              <ChatTurnAssistantChrome turn={turn} />
              <ChatTimelineEntryList key={`${reset}:${state.layout}:${state.activity}:${state.commands}:${state.edits}`} cwd="" sessionId={`settings-preview:${reset}`} entries={turn.entries} projectedResultByCallId={turn.resultByCallId} toolExecutions={dialogueExample?.executions ?? {}} turnActive={dialogueExample?.active} />
            </div>
            {state.navigator && <button type="button" aria-label={t('settings.chat.preview.jump')} className="sticky bottom-2 float-right flex flex-col items-center gap-1 rounded px-2 py-3 text-foreground hover:bg-muted/40"
              onClick={() => viewport.current?.scrollTo({ top: 0, behavior: 'smooth' })}><span className="h-5 w-1 rounded-full bg-current" /><span className="typography-micro">1</span></button>}
          </div> : null}
          {scene === 'files' && <div className="space-y-5 p-4">
            <p className="flex items-center gap-2 typography-meta font-medium">{state.icons && <FileTypeIcon filePath="src/validate.ts" className="size-4" />}src/validate.ts</p>
            <div className="min-w-0 overflow-hidden rounded-lg border border-border/60"><PierreDiffViewer original={BEFORE} modified={AFTER} language="typescript" fileName="validate.ts"
              renderSideBySide={state.diff === 'side-by-side'} wrapLines={state.wrap} layout="inline" enableComments={false} /></div>
            <MarkdownRenderer content={CHAT_PREVIEW_CODE} messageId="settings-preview:code" enableFileReferences={false} />
            <MarkdownRenderer content={diagram} messageId="settings-preview:diagram" enableFileReferences={false} />
            <div className="border-t border-border/50 pt-3">
              <button type="button" className="flex w-full items-center gap-2 rounded p-2 text-left typography-meta hover:bg-muted/40" aria-expanded={fileOpen} onClick={() => setFileOpen(value => !value)}>
                {state.icons && <FileTypeIcon filePath="README.md" className="size-4" />}<span>README.md</span><Icon name="arrow-down-s" className="ml-auto size-4" />
              </button>
              {hiddenFiles && <p className="flex items-center gap-2 p-2 typography-meta text-muted-foreground">{state.icons && <Icon name="folder" className="size-4" />}.varin</p>}
              {fileOpen && <div className="rounded-lg border border-border/60 p-3">{filePreview ? <MarkdownRenderer content={t('settings.chat.preview.readme')} messageId="settings-preview:readme" enableFileReferences={false} /> : <pre className="whitespace-pre-wrap font-mono typography-meta">{t('settings.chat.preview.readme')}</pre>}</div>}
            </div>
          </div>}
          {scene === 'input' && <div className="space-y-5 p-4">
            <div className="flex justify-center gap-2">{[false, true].map(value => <Button type="button" key={String(value)} variant={busy === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={busy === value} onClick={() => { setBusy(value); setSent(undefined); }}>{t(value ? 'settings.chat.preview.busy' : 'settings.chat.preview.new')}</Button>)}</div>
            <p className="py-3 text-center typography-ui-label">{t(busy ? 'settings.chat.preview.working' : 'settings.appearance.preview.greeting')}</p>
            {!busy && state.starters && <Button type="button" variant="outline" size="sm" onClick={() => setDraft(t('settings.appearance.preview.prompt'))}>{t('settings.appearance.preview.prompt')}</Button>}
            {sent && <div role="status" className="rounded-lg border border-border/60 bg-muted/20 p-3"><p className="typography-meta text-muted-foreground">{t(`settings.chat.preview.${sent.mode}`)}</p><p className="mt-2 whitespace-pre-wrap typography-meta">{sent.text}</p></div>}
            <form className="overflow-hidden rounded-xl border border-border/80" onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; setSent({ text: draft, mode: !busy ? 'sent' : followUp === 'queue' ? 'queued' : 'steered' }); setDraft(''); }}>
              <Textarea aria-label={t('settings.chat.preview.placeholder')} placeholder={t('settings.chat.preview.placeholder')} value={draft} spellCheck={state.spellcheck} onInput={event => setDraft(event.currentTarget.value)} className="min-h-24 resize-y border-0 bg-transparent shadow-none focus-visible:ring-0" />
              <div className="flex items-center justify-end gap-2 border-t border-border/50 p-2"><Button type="submit" size="sm" disabled={!draft.trim()}>{t(!busy ? 'settings.chat.preview.send' : followUp === 'queue' ? 'settings.varin.visual.option.followUpBehavior.queue.label' : 'settings.varin.visual.option.followUpBehavior.steer.label')}<Icon name="arrow-up" className="size-3.5" /></Button></div>
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2 typography-micro text-muted-foreground"><span>{t(state.persistDraft ? 'settings.chat.preview.keepDraft' : 'settings.chat.preview.clearDraft')}</span><button type="button" className="underline-offset-4 hover:underline" onClick={() => { if (!state.persistDraft) setDraft(''); setSent(undefined); }}>{t('settings.chat.preview.revisit')}</button></div>
          </div>}
        </ConversationPreviewContext.Provider></ConversationContext.Provider>
      </div>
      <footer className="flex items-start gap-3 border-t border-border/50 px-3 py-2.5 typography-micro text-muted-foreground"><p className="flex-1">{t('settings.chat.preview.description')}</p><button type="button" className="shrink-0 hover:text-foreground" onClick={resetExample}>{t('settings.chat.preview.reset')}</button></footer>
    </div>
  </aside>;
}
