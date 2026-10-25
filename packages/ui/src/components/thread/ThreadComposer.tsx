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
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SwapIcon } from '@/components/motion/SwapIcon';
import { SwapText } from '@/components/motion/SwapText';
import { INSTANT_TRANSITION, springTransition } from '@/lib/motion/tokens';
import { useComposerHeightGlide } from './useComposerHeightGlide';
import { useFileDropField } from '../conversation/useFileDropField';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from '@/components/chat/SkillAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { resolveAutocompleteTrigger, type FileMentionAutocompleteInputSource } from '@/components/chat/composer/language/triggers';
import { useMessageHistory } from '@/components/chat/composer/state/useMessageHistory';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isIMECompositionEvent } from '@/lib/ime';
import { WorkbenchContributionSlot } from '@/lib/extensions/workbench-registry';
import { ThreadPermissionControl } from './ThreadPermissionControl';

export function ThreadComposer({ editorRef, value, onChange, models, providerId, modelId, thinkingLevel, onModelChange,
  modelDisabled, attachmentDisabled, imageDisabled, sendDisabled, pending, active, retrying, delivery, onDeliveryChange, suggestion, suggestionError, onSuggestionConsumed,
  allowNextRun, onFiles, onAttachImages, onAttachPdfs, onStop, onGoal, goalArmed, children, attachmentNames, skills, hasInput, onWorkspace, workspaceLabel, workspacePath, permissionWorkspacePath, identityKey, messageHistory: sentMessageHistory = [], placement = 'bottom', queue, onCompact, onOpenHistory, agentControls }: {
  editorRef: React.Ref<ComposerEditorHandle>; value: string; onChange(value: string): void;
  suggestion?: string; suggestionError?: string; onSuggestionConsumed?(): void;
  identityKey?: string; messageHistory?: readonly string[]; placement?: 'center' | 'bottom'; queue?: React.ReactNode; onCompact?(): void; onOpenHistory?(): void;
  models: ThreadModelInfo[]; providerId: string; modelId: string; thinkingLevel: ThreadThinkingLevel;
  onModelChange(provider: string, model: string, thinking: ThreadThinkingLevel): void;
  modelDisabled: boolean; attachmentDisabled: boolean; imageDisabled: boolean; sendDisabled: boolean;
  pending: boolean; active: boolean; retrying: boolean; allowNextRun: boolean;
  delivery: 'boundary' | 'interrupt' | 'next_run'; onDeliveryChange(value: 'boundary' | 'interrupt' | 'next_run'): void;
  onFiles(files: File[]): void; onAttachImages(): void; onAttachPdfs(): void; onStop?(): void; onGoal(): void;
  hasInput: boolean; onWorkspace(): void; workspaceLabel: string;
  goalArmed?: boolean;
  workspacePath?: string;
  permissionWorkspacePath?: string;
  children?: React.ReactNode; attachmentNames: string[]; skills: string[];
  agentControls?: React.ReactNode;
}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const motionId = React.useId();
  const isMobile = useUIStore(state => state.isMobile);
  const isExpandedInput = useUIStore(state => state.isExpandedInput);
  const toggleExpandedInput = useUIStore(state => state.toggleExpandedInput);
  const goalEnabled = useUIStore(state => state.sessionGoalEnabled);
  const spellCheck = useUIStore(state => state.inputSpellcheckEnabled);
  const shortcuts = useUIStore(state => state.shortcutOverrides);
  const modelPickerOpen = useUIStore(state => state.isModelSelectorOpen);
  const setModelPickerOpen = useUIStore(state => state.setModelSelectorOpen);
  const inputRef = React.useRef<ComposerEditorHandle | null>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const inputFrameRef = React.useRef<HTMLDivElement>(null);
  const inputContentRef = React.useRef<HTMLDivElement>(null);
  useComposerHeightGlide(inputFrameRef, inputContentRef, value === '');
  // Files dragged over the conversation raise the drop field; anywhere in it takes them.
  useFileDropField(inputFrameRef, { disabled: attachmentDisabled, onFiles });
  const bindEditor = React.useCallback((handle: ComposerEditorHandle | null) => {
    inputRef.current = handle;
    if (typeof editorRef === 'function') editorRef(handle); else if (editorRef) editorRef.current = handle;
  }, [editorRef]);
  const [autocomplete, setAutocomplete] = React.useState<{ kind: 'command' | 'mention' | 'skill'; query: string } | null>(null);
  const [knownAgentNames, setKnownAgentNames] = React.useState<Set<string>>(() => new Set());
  const [confirmedMentions, setConfirmedMentions] = React.useState<Set<string>>(() => new Set());
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const skillRef = React.useRef<SkillAutocompleteHandle>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const pendingHistoryTextRef = React.useRef<string | null>(null);
  const messageHistory = useMessageHistory(sentMessageHistory);
  const resetHistory = messageHistory.reset;
  React.useEffect(() => {
    setAutocomplete(null); setKnownAgentNames(new Set()); setConfirmedMentions(new Set());
    pendingHistoryTextRef.current = null; resetHistory();
  }, [identityKey, resetHistory]);
  const sending = pending;
  const loading = false;
  const busy = active;
  const aborting = false;
  const availableSuggestion = !active && !pending && !retrying ? suggestion : undefined;
  const ghostSuggestion = !hasInput && value.length === 0 ? availableSuggestion : undefined;
  const canSend = hasInput || Boolean(ghostSuggestion);
  const composerActions = { primary: active && !hasInput && !retrying ? 'stop' : 'send', showSecondaryStop: active && hasInput && Boolean(onStop) };
  const primaryBusy = loading || (composerActions.primary === 'stop' ? aborting : sending);
  const primaryIcon = { name: primaryBusy ? 'loader-4' : composerActions.primary === 'stop' ? 'stop' : 'arrow-up', spin: primaryBusy } as const;
  const footerIconButtonClass = 'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35';
  const handleAbort = () => onStop?.();
  const acceptSuggestion = () => {
    if (!availableSuggestion || !inputRef.current) return;
    inputRef.current.insertText(availableSuggestion);
    onSuggestionConsumed?.();
    setAutocomplete(null);
  };
  const submit = () => {
    if (sendDisabled) return;
    if (ghostSuggestion) flushSync(acceptSuggestion);
    else {
      if (value.trim() === '/tree' && onOpenHistory) { setAutocomplete(null); onOpenHistory(); onChange(''); return; }
      if (value.trim() === '/compact' && onCompact) { setAutocomplete(null); onCompact(); onChange(''); return; }
    }
    messageHistory.reset(); frameRef.current?.closest('form')?.requestSubmit();
  };
  const insertTranscript = (text: string) => { onChange([value.trimEnd(), text.trim()].filter(Boolean).join('\n')); requestAnimationFrame(() => inputRef.current?.focus()); };
  const submitText = (text: string) => { flushSync(() => insertTranscript(text)); frameRef.current?.closest('form')?.requestSubmit(); };
  const selected = models.find(model => model.providerId === providerId && model.modelId === modelId);
  const varinCommands = React.useMemo<readonly CommandInfo[]>(() => [...(onCompact ? [{ id: 'compact', name: 'compact', source: 'varin' as const, description: t('chat.commandAutocomplete.command.compactDescription') }] : []), ...(onOpenHistory ? [{ id: 'tree', name: 'tree', source: 'varin' as const, description: t('chat.timeline.description') }] : [])], [onCompact, onOpenHistory, t]);
  const languageContext = React.useMemo(() => ({ inputMode: 'normal' as const, knownAgentNames, confirmedMentions,
    knownSlashNames: new Set([...skills.map(name => `skill:${name}`), ...varinCommands.map(command => command.name)]), attachmentFilenames: attachmentNames }), [knownAgentNames, confirmedMentions, skills, varinCommands, attachmentNames]);
  const modelControls = <div className="conversation-composer-configuration flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
        {(selected?.thinkingLevels?.length ?? 0) > 1 && <DropdownMenu><DropdownMenuTrigger asChild>
          <button type="button" disabled={modelDisabled} className="flex items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover" aria-label={t('chat.modelControls.thinking')}>
            <Icon name="brain" className="size-3.5" /><SwapText text={t(`settings.agents.thinking.${thinkingLevel}`)} hold={0} resize />
          </button>
        </DropdownMenuTrigger><DropdownMenuContent side="top" align="end">
          {selected!.thinkingLevels!.map(level => <DropdownMenuItem key={level} onSelect={() => onModelChange(providerId, modelId, level)}>{t(`settings.agents.thinking.${level}`)}{level === thinkingLevel && <Icon name="check" className="ml-auto size-3.5" />}</DropdownMenuItem>)}
        </DropdownMenuContent></DropdownMenu>}
        {selected?.thinkingLevels?.length === 1 && thinkingLevel !== 'off' ? <span className="flex items-center gap-1.5 px-2 typography-meta text-muted-foreground"><Icon name="brain" className="size-3.5" />{t(`settings.agents.thinking.${thinkingLevel}`)}</span> : null}
        <ModelSelector providerId={providerId} modelId={modelId} variant="composer" disabled={modelDisabled} allowNone={false}
          open={modelPickerOpen} onOpenChange={setModelPickerOpen}
          placeholder={t('chat.modelControls.selectModel')} dropdownPortalToBody
          onChange={(provider, model) => {
            const levels = models.find(item => item.providerId === provider && item.modelId === model)?.thinkingLevels ?? ['off'];
            onModelChange(provider, model, levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? 'off');
          }} />
        {agentControls}
  </div>;
  const updateAutocomplete = React.useCallback((
    value: string,
    cursorPosition: number,
    inputSource: FileMentionAutocompleteInputSource = 'manual',
    insertedText?: string,
  ) => {
    const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
      inputMode: 'normal',
      inputSource,
      ...(insertedText === undefined ? {} : { insertedText }),
    });
    if (trigger && (trigger.kind !== 'skill' || value.slice(0, cursorPosition).trimStart().startsWith('/'))) {
      setAutocomplete({ kind: trigger.kind, query: trigger.query });
      return;
    }
    setAutocomplete(null);
  }, []);

  const handleCommandSelect = React.useCallback((command: CommandInfo) => {
    const value = `/${command.name} `;
    onChange(value);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelection(value.length);
    });
  }, [onChange]);

  const handleSkillSelect = React.useCallback((invocation: string) => {
    const input = inputRef.current;
    const cursorPosition = input?.getSelection().end ?? value.length;
    const slashIndex = value.slice(0, cursorPosition).lastIndexOf('/');
    const startIndex = slashIndex === -1 ? cursorPosition : slashIndex;
    const inserted = `${value.slice(0, startIndex)}/${invocation} ${value.slice(cursorPosition)}`;
    onChange(inserted);
    setAutocomplete(null);
    const nextCursor = startIndex + invocation.length + 2;
    requestAnimationFrame(() => {
      const editor = inputRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(nextCursor);
    });
  }, [value, onChange]);

  const applyMention = React.useCallback((mention: string, kind: 'agent' | 'file') => {
    const cursor = inputRef.current?.getSelection().start ?? value.length;
    const insertion = (() => {
      const start = value.slice(0, cursor).lastIndexOf('@');
      const insertion = `@${mention} `;
      const from = start < 0 ? cursor : start;
      return { text: value.slice(0, from) + insertion + value.slice(cursor), cursor: from + insertion.length };
    })();
    if (kind === 'agent') {
      setKnownAgentNames((current) => new Set(current).add(mention.toLowerCase()));
    } else {
      setConfirmedMentions((current) => new Set(current).add(mention));
    }
    onChange(insertion.text);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(insertion.cursor);
    });
  }, [value, onChange]);

  const handleFileSelect = React.useCallback((file: {
    name: string;
    path: string;
    relativePath?: string;
  }) => {
    const mention = file.relativePath?.trim() || file.path.replace(/\\/g, '/') || file.name;
    applyMention(mention, 'file');
  }, [applyMention]);

  const handleAgentSelect = React.useCallback((agentName: string) => {
    applyMention(agentName, 'agent');
  }, [applyMention]);

  const applyHistoryText = React.useCallback((value: string) => {
    pendingHistoryTextRef.current = value;
    onChange(value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(value.length);
    });
  }, [onChange]);

  const handleEditorKeyDown = (event: KeyboardEvent): boolean => {
    // IME confirmation belongs to the editor, including while suggestions are open.
    if (isIMECompositionEvent(event)) return false;
    if (autocomplete?.kind === 'command'
      && event.key === 'Enter'
      && !event.shiftKey
      && !isIMECompositionEvent(event)
      && value.trim() === '/compact') {
      setAutocomplete(null);
      if (canSend && !sending && !loading) void submit();
      return true;
    }
    if (
      autocomplete !== null
      && (event.key === 'Enter'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'Escape'
        || event.key === 'Tab')
    ) {
      if (autocomplete.kind === 'command') commandRef.current?.handleKeyDown(event.key);
      else if (autocomplete.kind === 'skill') skillRef.current?.handleKeyDown(event.key);
      else mentionRef.current?.handleKeyDown(event.key);
      return true;
    }
    if (
      !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && !isIMECompositionEvent(event)
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      const selection = inputRef.current?.getSelection();
      if (selection && selection.start === selection.end) {
        const recalled = event.key === 'ArrowUp' && selection.start === 0
          ? messageHistory.older(value)
          : event.key === 'ArrowDown'
            && selection.end === value.length
            && messageHistory.isBrowsing
            ? messageHistory.newer()
            : null;
        if (recalled !== null) {
          applyHistoryText(recalled);
          return true;
        }
      }
    }
    if (availableSuggestion && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'Tab') { acceptSuggestion(); return true; }
      if (event.key === 'Escape') { onSuggestionConsumed?.(); return true; }
    }
    if (eventMatchesShortcut(event, getEffectiveShortcutCombo('submit_message', shortcuts)) && !isIMECompositionEvent(event)) { submit(); return true; }
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || isIMECompositionEvent(event)
    ) return false;
    if (canSend && !sending && !loading) void submit();
    return true;
  };

  return (
    <motion.div ref={frameRef} layout={reducedMotion ? false : 'position'} layoutId={motionId}
      layoutDependency={`${placement}:${isExpandedInput}:${attachmentNames.length}`}
      initial={false} transition={{ layout: reducedMotion ? INSTANT_TRANSITION : springTransition('travel') }}
      className={cn(
      'bottom-safe-area varin-mobile-composer shrink-0 bg-background pb-3',
      isExpandedInput && 'fixed inset-0 z-40 flex items-end bg-background/95',
    )} data-conversation-composer-shell="true">
      <div className={cn('chat-input-column', isExpandedInput && 'flex h-full flex-col justify-end py-6')}>
        {queue}

        <div
          ref={inputFrameRef}
          className={cn(
            'relative flex flex-col overflow-visible rounded-xl border border-border bg-muted',
            sending && 'opacity-80',
          )}
          data-conversation-composer-input-frame="true"
          data-startup-part="composer"
          onDragOver={(event) => {
            if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            onFiles(files);
          }}
        >
        {/* Measured by the height glide; the frame around it is what animates. */}
        <div ref={inputContentRef} className="flex min-w-0 shrink-0 flex-col" data-conversation-composer-input-content="true">
        {children}

          {isMobile ? (
            <div className="flex min-w-0 items-center justify-end border-b border-border/40 px-2 py-1">
              {modelControls}
            </div>
          ) : null}
          <ComposerEditor
            key={identityKey}
            ref={bindEditor}
            value={value}
            onChange={(change) => {
              if (pendingHistoryTextRef.current === change.value) {
                pendingHistoryTextRef.current = null;
                return;
              }
              pendingHistoryTextRef.current = null;
              if (messageHistory.isBrowsing) messageHistory.reset();
              onChange(change.value);
              updateAutocomplete(
                change.value,
                change.selection.end,
                change.fromPaste ? 'paste' : 'manual',
                change.insertedText,
              );
            }}
            onSelectionChange={(selection) => {
              if (messageHistory.isBrowsing) {
                setAutocomplete(null);
                return;
              }
              updateAutocomplete(value, selection.end);
            }}
            onPaste={(event) => {
              const files = event.clipboardData ? [...event.clipboardData.files] : [];
              if (!files.some((file) => file.type.startsWith('image/'))) return;
              event.preventDefault();
              onFiles(files);
            }}
            onKeyDown={handleEditorKeyDown}
            spellCheck={spellCheck}
            aria-label={t('chat.chatInput.placeholder.task')}
            languageContext={languageContext}
            placeholder={t('chat.chatInput.placeholder.task')}
            suggestion={ghostSuggestion}
            className={cn(
              'min-h-[48px] w-full px-3 pb-1 pt-3 typography-markdown text-foreground md:typography-ui-label',
              isExpandedInput ? 'min-h-[40vh]' : 'max-h-[40vh]',
            )}
            maxLines={isExpandedInput ? 24 : 9}
          />

          <div className="conversation-composer-hints" data-empty={!value.trim()} data-suggestion={availableSuggestion || suggestionError ? 'true' : undefined}>
            <p className="min-h-0 overflow-hidden px-3 typography-micro text-muted-foreground" aria-live="polite">
              {availableSuggestion ? <button type="button" className="text-muted-foreground/65 transition-colors hover:text-muted-foreground"
                title={availableSuggestion} aria-label={`${t('chat.suggestion.applyAria')}: ${availableSuggestion}`}
                onMouseDown={event => event.preventDefault()} onClick={() => { acceptSuggestion(); inputRef.current?.focus(); }}>
                {isMobile ? t('chat.suggestion.applyAria') : t(ghostSuggestion ? 'chat.suggestion.acceptAndSendHint' : 'chat.suggestion.insertHint')}
              </button> : suggestionError ? <span title={suggestionError} className="text-muted-foreground/65">{t(suggestionError === 'next-step-model-unconfigured' ? 'chat.suggestion.configureModel' : 'chat.suggestion.unavailable')}</span>
                : t('chat.composer.hint')}
            </p>
          </div>

          {autocomplete?.kind === 'command' ? (
            <CommandAutocomplete
              ref={commandRef}
              additionalCommands={varinCommands}
              cwd={workspacePath}
              sessionId={identityKey}
              searchQuery={autocomplete.query}
              onCommandSelect={handleCommandSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'mention' ? (
            <FileMentionAutocomplete
              ref={mentionRef}
              searchQuery={autocomplete.query}
              onAgentSelect={handleAgentSelect}
              workspacePath={workspacePath}
              onFileSelect={handleFileSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'skill' ? (
            <SkillAutocomplete
              ref={skillRef}
              cwd={workspacePath}
              sessionId={identityKey}
              searchQuery={autocomplete.query}
              onSkillSelect={handleSkillSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}


          <div data-chat-input-footer="true" className="conversation-composer-footer px-2 pb-2 pt-0.5">
            <div className="conversation-composer-options">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={footerIconButtonClass}
                    aria-label={t('chat.chatInput.actions.addAttachment')}
                    title={t('chat.chatInput.actions.addAttachment')}
                  >
                    <Icon name="add" className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="min-w-48">
                  <DropdownMenuItem disabled={attachmentDisabled || imageDisabled} onClick={onAttachImages} className="gap-2.5 py-1.5">
                    <Icon name="attachment-2" className="size-4" />
                    {t('chat.fileAttachment.actions.chooseImages')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={attachmentDisabled} onClick={onAttachPdfs} className="gap-2.5 py-1.5">
                    <Icon name="file-pdf" className="size-4" />{t('chat.fileAttachment.actions.attachPdfs')}
                  </DropdownMenuItem>
                  {onOpenHistory && <DropdownMenuItem onClick={onOpenHistory}><Icon name="git-branch" className="size-4" />{t('chat.timeline.title')}</DropdownMenuItem>}
                  <DropdownMenuItem onClick={toggleExpandedInput} className="gap-2.5 py-1.5">
                    <Icon name={isExpandedInput ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                    {isExpandedInput ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ThreadPermissionControl workspacePath={permissionWorkspacePath} className={footerIconButtonClass} />
              {goalEnabled && <button type="button" className={cn(footerIconButtonClass, goalArmed && 'text-primary bg-primary/10')} onClick={onGoal} aria-pressed={Boolean(goalArmed)} aria-label={t('chat.draftPresets.craftGoal.label')}><Icon name="target" className="size-4" /></button>}
              <button type="button" onClick={onWorkspace} className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover" title={workspaceLabel}><Icon name="folder" className="size-3.5" /><span className="max-w-28 truncate">{workspaceLabel}</span></button>
              <WorkbenchContributionSlot kind="composer-action" slot="chat.composer.actions.leading" props={{ identityKey, workspacePath, text: value, onChange, onSend: submit }} />
            </div>

            {!isMobile ? <div className="conversation-composer-models">{modelControls}</div> : null}
            {busy ? <div className="conversation-composer-send-mode">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" disabled={sending} title={t('settings.varin.visual.field.followUpBehaviorDescription')}
                    className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40"
                    aria-label={t('settings.chat.busySend')}>
                    <SwapIcon swapKey={delivery === 'next_run' ? 'time' : 'arrow-up'} className="shrink-0">
                      <Icon name={delivery === 'next_run' ? 'time' : 'arrow-up'} className="size-3" />
                    </SwapIcon>
                    <SwapText text={t(delivery === 'next_run' ? 'thread.composer.afterRun' : delivery === 'interrupt' ? 'thread.composer.interrupt' : 'thread.composer.boundary')} hold={0} resize />

                    <Icon name="arrow-down-s" className="size-3 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-64" portalToBody>
                  {(['boundary', 'interrupt', ...(allowNextRun ? ['next_run'] : [])] as const).map(mode => <DropdownMenuItem key={mode}
                    onSelect={() => onDeliveryChange(mode as typeof delivery)} className="gap-2">
                    <Icon name={mode === 'next_run' ? 'time' : 'arrow-up'} className="size-3.5 shrink-0" />
                    <span className="flex-1">{t(mode === 'next_run' ? 'thread.composer.afterRun' : mode === 'interrupt' ? 'thread.composer.interrupt' : 'thread.composer.boundary')}</span>
                    {mode === delivery ? <Icon name="check" className="size-3.5" /> : null}
                  </DropdownMenuItem>)}
                  <p className="border-t border-border/50 px-2 py-2 typography-micro text-muted-foreground">
                    {t('settings.varin.visual.field.followUpBehaviorDescription')}
                  </p>
                </DropdownMenuContent>
              </DropdownMenu>
            </div> : null}
            <div className="conversation-composer-actions">
              <WorkbenchContributionSlot kind="composer-action" slot="chat.composer.actions.trailing" props={{ identityKey, workspacePath, text: value, onChange, onSend: submit }} />
              <ComposerDictation
                key={identityKey}
                disabled={sending}
                footerIconButtonClass={footerIconButtonClass}
                footerPaddingClass="px-3 pb-2.5"
                iconSizeClass="size-4"
                isMobile={isMobile}
                onInsert={insertTranscript}
                onInsertAndSend={submitText}
                radius="1rem"
                sendIconSizeClass="size-4"
              />
              {composerActions.showSecondaryStop && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={aborting}
                      onClick={() => void handleAbort()}
                      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-50"
                      aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                      data-conversation-composer-secondary-stop="true"
                    >
                      <Icon
                        name={aborting ? 'loader-4' : 'stop'}
                        className={cn('size-3.5', aborting && 'animate-spin')}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('chat.chatInput.actions.stopGeneratingAria')}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      if (composerActions.primary === 'stop') void handleAbort();
                      else void submit();
                    }}
                    disabled={composerActions.primary === 'stop' ? !onStop : sendDisabled}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-full transition-colors',
                      composerActions.primary === 'stop'
                        ? aborting
                          ? 'cursor-wait bg-primary/70 text-primary-foreground'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : canSend && !sending && !loading
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'cursor-not-allowed bg-transparent text-muted-foreground/35',
                    )}
                    aria-label={loading ? t('common.loading') : composerActions.primary === 'stop'
                      ? t('chat.chatInput.actions.stopGeneratingAria')
                      : t(retrying ? 'chat.messages.retry' : 'chat.chatInput.actions.sendMessageAria')}
                    aria-busy={loading || (composerActions.primary === 'stop' ? aborting : undefined)}
                    data-conversation-composer-primary-action={composerActions.primary}
                  >
                    {/* The arrow rises out as it is sent; Stop drops in once the run starts. */}
                    <SwapIcon swapKey={primaryIcon.name} enter={primaryIcon.name === 'stop' ? 'settle' : 'glide'}>
                      <Icon name={primaryIcon.name} className={cn('size-4', primaryIcon.spin && 'animate-spin')} />
                    </SwapIcon>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {loading ? t('common.loading') : composerActions.primary === 'stop'
                    ? t('chat.chatInput.actions.stopGeneratingAria')
                    : t(retrying ? 'chat.messages.retry' : 'chat.chatInput.actions.sendMessageAria')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
        </div>
      </div>
    </motion.div>
  );
};
