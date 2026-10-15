import React from 'react';
import { flushSync } from 'react-dom';
import type { ThreadModelInfo, ThreadThinkingLevel } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { useThreadAutocomplete } from './useThreadAutocomplete';

const iconButton = 'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-40';

export function ThreadComposer({ editorRef, value, onChange, models, providerId, modelId, thinkingLevel, onModelChange,
  modelDisabled, attachmentDisabled, imageDisabled, sendDisabled, pending, active, retrying, delivery, onDeliveryChange,
  allowNextRun, onFiles, onAttachImages, onAttachPdfs, onStop, onGoal, goalArmed, children, attachmentNames, skills, hasInput, onWorkspace, workspaceLabel, workspacePath }: {
  editorRef: React.Ref<ComposerEditorHandle>; value: string; onChange(value: string): void;
  models: ThreadModelInfo[]; providerId: string; modelId: string; thinkingLevel: ThreadThinkingLevel;
  onModelChange(provider: string, model: string, thinking: ThreadThinkingLevel): void;
  modelDisabled: boolean; attachmentDisabled: boolean; imageDisabled: boolean; sendDisabled: boolean;
  pending: boolean; active: boolean; retrying: boolean; allowNextRun: boolean;
  delivery: 'boundary' | 'interrupt' | 'next_run'; onDeliveryChange(value: 'boundary' | 'interrupt' | 'next_run'): void;
  onFiles(files: File[]): void; onAttachImages(): void; onAttachPdfs(): void; onStop?(): void; onGoal(): void;
  hasInput: boolean; onWorkspace(): void; workspaceLabel: string;
  goalArmed?: boolean;
  workspacePath?: string;
  children?: React.ReactNode; attachmentNames: string[]; skills: string[];
}) {
  const { t } = useI18n();
  const isMobile = useUIStore(state => state.isMobile);
  const goalEnabled = useUIStore(state => state.sessionGoalEnabled);
  const expanded = useUIStore(state => state.isExpandedInput);
  const toggleExpanded = useUIStore(state => state.toggleExpandedInput);
  const modelPickerOpen = useUIStore(state => state.isModelSelectorOpen);
  const setModelPickerOpen = useUIStore(state => state.setModelSelectorOpen);
  const root = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const bindEditor = React.useCallback((handle: ComposerEditorHandle | null) => {
    editor.current = handle;
    if (typeof editorRef === 'function') editorRef(handle); else if (editorRef) editorRef.current = handle;
  }, [editorRef]);
  const autocomplete = useThreadAutocomplete({ value, editor, workspacePath, skills });
  const languageContext = React.useMemo(() => ({ inputMode: 'normal' as const, knownAgentNames: new Set<string>(),
    confirmedMentions: autocomplete.confirmed, knownSlashNames: new Set(skills.map(name => `skill:${name}`)), attachmentFilenames: attachmentNames }), [skills, attachmentNames, autocomplete.confirmed]);
  const selected = models.find(model => model.providerId === providerId && model.modelId === modelId);
  const send = () => { if (!sendDisabled) root.current?.closest('form')?.requestSubmit(); };
  const stopPrimary = active && !hasInput && !retrying;
  const deliveryLabel = delivery === 'interrupt' ? t('thread.composer.interrupt') : t('thread.composer.boundary');
  return <div ref={root} className="thread-composer relative rounded-2xl border border-border bg-[var(--surface-elevated)] shadow-sm"
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); onFiles(files); } }}>
    {children}
    {autocomplete.popup}
    <ComposerEditor ref={bindEditor} value={value} onChange={change => { onChange(change.value); autocomplete.setCaret(change.selection.end); }} languageContext={languageContext}
      onSelectionChange={selection => autocomplete.setCaret(selection.end)} onBlur={autocomplete.close}
      aria-label={t('chat.chatInput.placeholder.task')} placeholder={t('chat.chatInput.placeholder.task')}
      className={cn('w-full px-3 pb-2 pt-3 typography-markdown md:typography-ui-label', expanded ? 'min-h-[35vh]' : 'min-h-16')}
      maxLines={expanded ? 24 : 9}
      onPaste={event => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); onFiles(files); } }}
      onKeyDown={event => {
        if (autocomplete.onKeyDown(event)) return true;
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
        event.preventDefault(); send(); return true;
      }} />
    <div data-chat-input-footer="true" className="flex flex-wrap items-center gap-1 px-2 pb-2">
      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={t('chat.chatInput.actions.addAttachment')}>
        <Icon name="add" className="size-4" />
      </button></DropdownMenuTrigger><DropdownMenuContent side="top" align="start">
        <DropdownMenuItem disabled={attachmentDisabled || imageDisabled} onSelect={onAttachImages}><Icon name="file-image" className="size-4" />{t('thread.composer.images')}</DropdownMenuItem>
        <DropdownMenuItem disabled={attachmentDisabled} onSelect={onAttachPdfs}><Icon name="file-pdf" className="size-4" />{t('chat.fileAttachment.actions.attachPdfs')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleExpanded}><Icon name={expanded ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />{t(expanded ? 'filesView.editor.exitFullscreen' : 'filesView.editor.fullscreen')}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      {goalEnabled && <button type="button" className={cn(iconButton, goalArmed && 'bg-primary/10 text-primary')} onClick={onGoal} aria-pressed={Boolean(goalArmed)} aria-label={t('chat.draftPresets.craftGoal.label')} title={t('chat.draftPresets.craftGoal.label')}><Icon name="target" className="size-4" /></button>}
      <button type="button" onClick={onWorkspace} className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover" title={workspaceLabel}><Icon name="folder" className="size-3.5" /><span className="max-w-28 truncate">{workspaceLabel}</span></button>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
        {(selected?.thinkingLevels?.length ?? 0) > 1 && <DropdownMenu><DropdownMenuTrigger asChild>
          <button type="button" disabled={modelDisabled} className="flex items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover" aria-label={t('chat.modelControls.thinking')}>
            <Icon name="brain" className="size-3.5" />{t(`settings.agents.thinking.${thinkingLevel}`)}
          </button>
        </DropdownMenuTrigger><DropdownMenuContent side="top" align="end">
          {selected!.thinkingLevels!.map(level => <DropdownMenuItem key={level} onSelect={() => onModelChange(providerId, modelId, level)}>{t(`settings.agents.thinking.${level}`)}{level === thinkingLevel && <Icon name="check" className="ml-auto size-3.5" />}</DropdownMenuItem>)}
        </DropdownMenuContent></DropdownMenu>}
        <ModelSelector providerId={providerId} modelId={modelId} variant="composer" disabled={modelDisabled} allowNone={false}
          open={modelPickerOpen} onOpenChange={setModelPickerOpen}
          placeholder={t('chat.modelControls.selectModel')} dropdownPortalToBody
          onChange={(provider, model) => {
            const levels = models.find(item => item.providerId === provider && item.modelId === model)?.thinkingLevels ?? ['off'];
            onModelChange(provider, model, levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? 'off');
          }} />
        {active && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={deliveryLabel} title={deliveryLabel}><Icon name="time" className="size-3.5" /></button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">{(['boundary', 'interrupt', ...(allowNextRun ? ['next_run'] : [])] as const).map(mode => <DropdownMenuItem key={mode} onSelect={() => onDeliveryChange(mode as typeof delivery)}>
            {mode === 'interrupt' ? t('thread.composer.interrupt') : mode === 'next_run' ? t('thread.composer.afterRun') : t('thread.composer.boundary')}
            {mode === delivery && <Icon name="check" className="ml-auto size-3.5" />}
          </DropdownMenuItem>)}</DropdownMenuContent>
        </DropdownMenu>}
        <ComposerDictation isMobile={isMobile} disabled={pending} footerIconButtonClass={iconButton} footerPaddingClass="px-3 pb-2"
          iconSizeClass="size-4" sendIconSizeClass="size-4" radius="1rem"
          onInsert={transcript => onChange([value, transcript].filter(Boolean).join('\n'))}
          onInsertAndSend={transcript => { flushSync(() => onChange([value, transcript].filter(Boolean).join('\n'))); root.current?.closest('form')?.requestSubmit(); }} />
        {active && !stopPrimary && onStop && <button type="button" className={iconButton} onClick={onStop} aria-label={t('chat.chatInput.actions.stopGeneratingAria')}><Icon name="stop" className="size-3.5" /></button>}
        <button type={stopPrimary ? 'button' : 'submit'} onClick={stopPrimary ? onStop : undefined}
          disabled={stopPrimary ? !onStop : sendDisabled}
          aria-label={stopPrimary ? t('chat.chatInput.actions.stopGeneratingAria') : retrying ? t('settings.harness.retry') : t(active ? 'chat.chatInput.actions.queueMessageAria' : 'chat.chatInput.actions.sendMessageAria')}
          className={cn('flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35', stopPrimary || !sendDisabled ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-muted-foreground')}>
          <Icon name={stopPrimary ? 'stop' : pending ? 'loader-4' : 'arrow-up'} className={cn('size-4', pending && !stopPrimary && 'animate-spin')} />
        </button>
      </div>
    </div>
  </div>;
}
