import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { externalAttachmentSupported } from './externalAttachments';
import { VARIN_CONVERSATION_SLOTS } from '@varin/extension-contract';
import React from 'react';
import type { InteractionRange } from '@/components/chat/composer/editor/interactionRanges';
import { registerUiComposer } from '@/lib/interactive-ui/compose';
import { flushSync } from 'react-dom';
import { getRuntimeEndpointGeneration, type ThreadDraftSkillOptions, type ThreadsAPI, type ThreadIdentity, type ThreadSource, type ThreadModelInfo, type ThreadThinkingLevel } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SwapIcon } from '@/components/motion/SwapIcon';
import { SwapText } from '@/components/motion/SwapText';
import { INSTANT_TRANSITION, springTransition } from '@/lib/motion/tokens';
import { useComposerHeightGlide } from './useComposerHeightGlide';
import { useFileDropField } from '../conversation/useFileDropField';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import type { ComposerReference } from '@/components/chat/composer/editor/references';
import { useWorkbenchCommandRegistrations } from '@/lib/commands/surface-command-registry';
import type { ComposerCommandAction, ComposerCommandDraftContext, WorkbenchCommandExecutionContext } from '@/lib/commands/surface-command-types';
import { FileMentionAutocomplete, type ComposerAttachmentCandidate, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { resolveAutocompleteTrigger, type FileMentionAutocompleteInputSource, type AutocompleteTrigger } from '@/components/chat/composer/language/triggers';
import { useMessageHistory } from '@/components/chat/composer/state/useMessageHistory';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isIMECompositionEvent } from '@/lib/ime';
import { WorkbenchContributionSlot } from '@/lib/extensions/workbench-registry';
import { externalThinkingOptions } from './externalSessionChoice';
import { ExternalModelControls, ExternalModeControls, ExternalOptionMenu, ExternalChoiceValidation, type ExternalComposerOptions } from './ExternalComposerControls';
import { ThreadPermissionControl } from './ThreadPermissionControl';

export function ThreadComposer({ editorRef, value, onChange, interactions, models, providerId, modelId, thinkingLevel, onModelChange,
  modelDisabled, attachmentDisabled, imageDisabled, sendDisabled, pending, active, retrying, suggestion, suggestionError, onSuggestionDismiss, prepareSendMode,
  onFiles, onAttachImages, onAttachPdfs, onStop, onGoal, goalArmed, children, attachmentNames, imageReferences, skills, hasInput, onWorkspace, workspaceLabel, workspacePath, permissionWorkspacePath, identityKey, messageHistory: sentMessageHistory = [], placement = 'bottom', queue, onCompact, onOpenHistory, onOpenRecovery, agentControls, backendControls, api, identity, source, references, commandActions, onReferenceSelect, backendCommands, referenceScope, pendingSource, attachmentCandidates, backendIdentity, external, connectionStatus }: {
  editorRef: React.Ref<ComposerEditorHandle>; value: string; onChange(value: string, references?: readonly ComposerReference[], interactions?: readonly InteractionRange[]): void;
  interactions?: readonly InteractionRange[];
  referenceScope?: string; references?: readonly ComposerReference[]; api?: ThreadsAPI; identity?: ThreadIdentity; source?: ThreadSource; pendingSource?: ThreadDraftSkillOptions['source'];
  external?: ExternalComposerOptions; connectionStatus?: React.ReactNode;
  backendIdentity?: string; attachmentCandidates?: readonly ComposerAttachmentCandidate[];
  backendCommands?: Array<{ name: string; description: string; inputHint?: string }>;
  commandActions?: Record<string, ComposerCommandAction | undefined>;
  onReferenceSelect?(reference: ComposerReference): void;
  suggestion?: string; suggestionError?: string; onSuggestionDismiss?(): void;
  prepareSendMode?(mode: 'boundary' | 'next_run' | undefined): void;
  identityKey?: string; messageHistory?: readonly string[]; placement?: 'center' | 'bottom'; queue?: React.ReactNode; onCompact?(): void | Promise<void>; onOpenHistory?(): void;
  onOpenRecovery?(): void;
  models: ThreadModelInfo[]; providerId: string; modelId: string; thinkingLevel: ThreadThinkingLevel;
  onModelChange(provider: string, model: string, thinking: ThreadThinkingLevel): void | Promise<void>;
  modelDisabled: boolean; attachmentDisabled: boolean; imageDisabled: boolean; sendDisabled: boolean;
  pending: boolean; active: boolean; retrying: boolean;
  onFiles(files: File[]): void; onAttachImages(): void; onAttachPdfs(): void; onStop?(): void; onGoal?(): void;
  hasInput: boolean; onWorkspace?(): void; workspaceLabel: string;
  goalArmed?: boolean;
  workspacePath?: string;
  permissionWorkspacePath?: string;
  children?: React.ReactNode; attachmentNames: string[]; imageReferences?: readonly number[]; skills: string[];
  agentControls?: React.ReactNode;
  backendControls?: React.ReactNode;
}) {
  const { t } = useI18n();
  const botWorkbench = useWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
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
  useFileDropField(inputFrameRef, { disabled: attachmentDisabled || Boolean(external && !external.capabilities?.files && !external.capabilities?.images), onFiles: files => acceptFiles(files) });
  const acceptFiles = (files: File[]) => {
    if (attachmentDisabled) return;
    if (external && files.some(file => !externalAttachmentSupported(external.capabilities, file))) { setCommandError(t(external.capabilities ? 'external.filesUnsupported' : 'external.capabilitiesUnknown')); return; }
    onFiles(files);
  };
  const bindEditor = React.useCallback((handle: ComposerEditorHandle | null) => {
    inputRef.current = handle;
    if (typeof editorRef === 'function') editorRef(handle); else if (editorRef) editorRef.current = handle;
  }, [editorRef]);
  React.useLayoutEffect(() => {
    if (identityKey && inputRef.current) return registerUiComposer(identityKey, inputRef.current);
  }, [identityKey]);
  const [autocomplete, setAutocomplete] = React.useState<AutocompleteTrigger | null>(null);
  const [knownAgentNames, setKnownAgentNames] = React.useState<Set<string>>(() => new Set());
  const [confirmedMentions, setConfirmedMentions] = React.useState<Set<string>>(() => new Set());
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const registrations = useWorkbenchCommandRegistrations();
  const [layer, setLayer] = React.useState<CommandInfo>();
  const [commandError, setCommandError] = React.useState<string>();
  const [commandBusy, setCommandBusy] = React.useState(false);
  const commandPending = React.useRef(false);
  const [activeOption, setActiveOption] = React.useState<string>();
  const menuId = React.useId();
  const dismissed = React.useRef<string | undefined>(undefined);
  const scope = JSON.stringify([getRuntimeEndpointGeneration(), identityKey, source, pendingSource, workspacePath, referenceScope, backendIdentity]);
  const currentIdentity = React.useRef(scope); currentIdentity.current = scope;
  const latestDraft = React.useRef({ value, references }); latestDraft.current = { value, references };
  const closeMenu = React.useCallback(() => { dismissed.current = inputRef.current?.getValue() ?? value; setAutocomplete(null); setLayer(undefined); setCommandError(undefined); }, [value]);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const pendingHistoryTextRef = React.useRef<string | null>(null);
  const messageHistory = useMessageHistory(sentMessageHistory);
  const resetHistory = messageHistory.reset;
  React.useLayoutEffect(() => {
    setAutocomplete(null); setLayer(undefined); setCommandError(undefined); dismissed.current = undefined; setKnownAgentNames(new Set()); setConfirmedMentions(new Set());
    pendingHistoryTextRef.current = null; resetHistory();
  }, [scope, resetHistory]);
  const sending = pending;
  const loading = false;
  const aborting = false;
  const [insertedSuggestion, setInsertedSuggestion] = React.useState<{ text: string; identity?: string }>();
  React.useEffect(() => {
    if (insertedSuggestion && (!value.length || insertedSuggestion.text !== suggestion || insertedSuggestion.identity !== identityKey)) setInsertedSuggestion(undefined);
  }, [insertedSuggestion, value, suggestion, identityKey]);
  const alreadyInserted = value.length > 0 && insertedSuggestion?.text === suggestion && insertedSuggestion?.identity === identityKey;
  const availableSuggestion = !active && !pending && !retrying && !alreadyInserted ? suggestion : undefined;
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
    setInsertedSuggestion({ text: availableSuggestion, identity: identityKey });
    setAutocomplete(null);
  };
  const submit = (mode?: 'boundary' | 'next_run') => {
    if (references?.some(reference => reference.target.kind === 'backend-command' && value.slice(reference.from, reference.to) === reference.text && (reference.target.backend !== backendIdentity || reference.host !== getRuntimeEndpointGeneration()))) { setCommandError(t('composer.scope.changed')); return; }
    const backend = references?.some(reference => reference.target.kind === 'backend-command' && reference.target.backend === backendIdentity && reference.host === getRuntimeEndpointGeneration() && value.slice(reference.from, reference.to) === reference.text && value.trim() === `/${reference.target.name}`);
    const exact = !backend && (external ? varinCommands : knownCommands).find(command => value.trim() === `/${command.name}` && !command.isSkill && command.source !== 'backend');
    if (exact) { void runCommand(exact, { kind: 'command', query: exact.name, from: value.indexOf('/'), to: value.trimEnd().length }); return; }
    if (sendDisabled) return;
    if (ghostSuggestion) flushSync(acceptSuggestion);
    prepareSendMode?.(mode);
    messageHistory.reset(); frameRef.current?.closest('form')?.requestSubmit();
  };
  const insertTranscript = (text: string) => { onChange([value.trimEnd(), text.trim()].filter(Boolean).join('\n')); requestAnimationFrame(() => inputRef.current?.focus()); };
  const submitText = (text: string) => { flushSync(() => insertTranscript(text)); frameRef.current?.closest('form')?.requestSubmit(); };
  const selected = models.find(model => model.providerId === providerId && model.modelId === modelId);
  const settings = (section?: string) => { const ui = useUIStore.getState(); ui.setSettingsDialogOpen(true); if (section) ui.setSettingsPage(section as Parameters<typeof ui.setSettingsPage>[0]); };
  const chooseModel = async (provider: string, model: string, thinking: ThreadThinkingLevel, complete = false) => {
    const capturedScope = scope;
    try { await onModelChange(provider, model, thinking); if (complete && capturedScope === currentIdentity.current) consumeFragment(); }
    catch (cause) { if (capturedScope === currentIdentity.current) setCommandError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const actions: Record<string, ComposerCommandAction | undefined> = {
    settings: { run: () => settings() }, shortcuts: { run: () => settings('shortcuts') },
    skills: backendControls === undefined ? { run: () => settings('skills') } : undefined,
    ...(onCompact ? { compact: { run: onCompact } } : {}), ...(onOpenHistory ? { tree: { run: onOpenHistory } } : {}),
    ...(onGoal && backendControls === undefined ? { goal: { run: onGoal } } : {}),
    attachments: { content: <div>{children || <p>{t('composer.emptyAttachments')}</p>}</div> },
    ...(backendControls === undefined ? {
      model: { disabled: modelDisabled ? t('composer.menu.unavailable') : undefined, value: selected?.name ?? modelId,
        content: <div className="space-y-2"><p className="typography-meta text-muted-foreground">{t('composer.model.scope')}</p>{models.map(model => <button type="button" key={`${model.providerId}:${model.modelId}`} className="flex w-full items-center justify-between rounded px-2 py-2 text-left hover:bg-interactive-hover" disabled={modelDisabled}
          onClick={() => { const levels = model.thinkingLevels ?? ['off']; void chooseModel(model.providerId, model.modelId, levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? 'off', true); }}><span>{model.name ?? model.modelId} · {model.providerId}</span>{model.providerId === providerId && model.modelId === modelId && '✓'}</button>)}</div> },
      thinking: { disabled: modelDisabled ? t('composer.menu.unavailable') : undefined, value: t(`settings.agents.thinking.${thinkingLevel}`),
        content: <div className="space-y-2"><p className="typography-meta text-muted-foreground">{t('composer.model.scope')}</p>{(selected?.thinkingLevels?.length ?? 0) > 1 ? selected!.thinkingLevels!.map(level => <button type="button" key={level} disabled={modelDisabled} className="flex w-full justify-between rounded px-2 py-2 hover:bg-interactive-hover" onClick={() => { void chooseModel(providerId, modelId, level, true); }}>{t(`settings.agents.thinking.${level}`)}{thinkingLevel === level && '✓'}</button>) : <p>{t('composer.model.noThinking')}</p>}</div> },
      permissions: { content: <ThreadPermissionControl workspacePath={permissionWorkspacePath} embedded /> },
    } : {}),
    ...(external ? {
      model: { content: (complete: () => void) => <ExternalOptionMenu options={external} kind="model" onComplete={complete} /> },
      ...(externalThinkingOptions(external.choice, external.capabilities).levels?.length || external.capabilities?.modelsError && external.choice.thinking ? { thinking: { content: (complete: () => void) => <ExternalOptionMenu options={external} kind="thinking" onComplete={complete} /> } } : {}),
      ...(external.capabilities?.modes?.length ? { mode: { content: (complete: () => void) => <ExternalOptionMenu options={external} kind="mode" onComplete={complete} /> } } : {}),
    } : {}),
    ...commandActions,
  };
  const commandContext: WorkbenchCommandExecutionContext = { currentDirectory: workspacePath ?? null, isMobile,
    composer: { host: getRuntimeEndpointGeneration(), identity, source, actions } };
  const knownCommands: CommandInfo[] = registrations.filter(item => item.meta.composer)
    .map(item => { const meta = item.meta.composer!; const builtin = item.contributionId.startsWith('varin.builtin.'); const action = builtin ? actions[meta.name] : undefined; return { id: item.contributionId, name: builtin ? meta.name : `ext:${encodeURIComponent(item.contributionId)}:${meta.name}`, sourceLabel: builtin ? undefined : item.contributionId, label: builtin && meta.name === 'schedule' && botWorkbench ? t('arrangements.title') : item.meta.titleKey ? t(item.meta.titleKey) : item.meta.title,
      searchAliases: [meta.name, ...item.meta.keywords], source: item.contributionId.startsWith('varin.builtin.') ? 'varin' : 'extension',
      group: t(`composer.group.${meta.group}`), icon: item.meta.icon, next: Boolean(action?.content), disabled: action?.disabled ?? (item.implementation.isAvailable && !item.implementation.isAvailable(commandContext) ? t('composer.menu.unavailable') : undefined), value: action?.value }; });
  if (external && actions.mode) knownCommands.push({ id: 'varin.external.mode', name: 'mode', label: t('external.mode'), source: 'varin', group: t('composer.group.execution'), next: true, icon: 'shield-user' });
  const varinCommands = knownCommands.filter(command => actions[command.name] || command.source === 'extension');
  for (const command of backendCommands ?? []) varinCommands.push({ id: `backend:${command.name}`, name: command.name.replace(/^\//, ''), label: `/${command.name.replace(/^\//, '')}`, description: command.description,
    source: 'backend', group: t('composer.group.backend') });
  function consumeFragment(fragment = autocomplete) {
    if (!fragment) return;
    if (inputRef.current?.getValue() === value) inputRef.current.replaceRange(fragment.from, fragment.to, '');
    closeMenu(); inputRef.current?.focus();
  }
  async function runCommand(command: CommandInfo, fragment = autocomplete) {
    if (scope !== currentIdentity.current || commandContext.composer?.host !== getRuntimeEndpointGeneration() || commandPending.current) return;
    if (command.disabled) { setCommandError(command.disabled); return; }
    const action = command.source === 'varin' ? actions[command.name] : undefined;
    if (action?.content) { if (external && ['model', 'thinking', 'mode'].includes(command.name)) external.onInteract('menu'); if (fragment) setAutocomplete(fragment); dismissed.current = undefined; setLayer(command); setCommandError(undefined); return; }
    const registration = registrations.find(item => item.contributionId === command.id);
    if (!registration) { setCommandError(t('composer.menu.unavailable')); return; }
    const capturedScope = scope, host = getRuntimeEndpointGeneration(), originalText = value, originalReferences = references;
    commandPending.current = true; setCommandBusy(true); setCommandError(undefined);
    try {
      await registration.implementation.execute(commandContext);
      if (capturedScope === currentIdentity.current && host === getRuntimeEndpointGeneration()) {
        if (inputRef.current) consumeFragment(fragment);
        else if (fragment && latestDraft.current.value === originalText && JSON.stringify(latestDraft.current.references) === JSON.stringify(originalReferences)) onChange(originalText.slice(0, fragment.from) + originalText.slice(fragment.to), originalReferences?.filter(item => item.to <= fragment.from || item.from >= fragment.to).map(item => item.from >= fragment.to ? { ...item, from: item.from - (fragment.to - fragment.from), to: item.to - (fragment.to - fragment.from) } : item));
      }
    } catch (error) { if (capturedScope === currentIdentity.current && host === getRuntimeEndpointGeneration()) setCommandError(error instanceof Error ? error.message : String(error)); }
    finally { commandPending.current = false; setCommandBusy(false); }
  }
  const languageContext = React.useMemo(() => ({ inputMode: 'normal' as const, knownAgentNames, confirmedMentions,
    knownSlashNames: new Set([...skills.map(name => `skill:${name}`), ...varinCommands.map(command => command.name)]), attachmentFilenames: attachmentNames, imageReferences }), [knownAgentNames, confirmedMentions, skills, varinCommands, attachmentNames, imageReferences]);
  const modelControls = <div className="conversation-composer-configuration flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
        {external && <ExternalModelControls key={backendIdentity} options={external} />}
        {backendControls ?? <>
        {(selected?.thinkingLevels?.length ?? 0) > 1 && <DropdownMenu><DropdownMenuTrigger asChild>
          <button type="button" disabled={modelDisabled} className="flex items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover" aria-label={t('chat.modelControls.thinking')}>
            <Icon name="brain" className="size-3.5" /><SwapText text={t(`settings.agents.thinking.${thinkingLevel}`)} hold={0} resize />
          </button>
        </DropdownMenuTrigger><DropdownMenuContent side="top" align="end">
          {selected!.thinkingLevels!.map(level => <DropdownMenuItem key={level} onSelect={() => void chooseModel(providerId, modelId, level)}>{t(`settings.agents.thinking.${level}`)}{level === thinkingLevel && <Icon name="check" className="ml-auto size-3.5" />}</DropdownMenuItem>)}
        </DropdownMenuContent></DropdownMenu>}
        {selected?.thinkingLevels?.length === 1 && thinkingLevel !== 'off' ? <span className="flex items-center gap-1.5 px-2 typography-meta text-muted-foreground"><Icon name="brain" className="size-3.5" />{t(`settings.agents.thinking.${thinkingLevel}`)}</span> : null}
        <ModelSelector providerId={providerId} modelId={modelId} variant="composer" disabled={modelDisabled} allowNone={false}
          open={modelPickerOpen} onOpenChange={setModelPickerOpen}
          placeholder={t('chat.modelControls.selectModel')} dropdownPortalToBody
          onChange={(provider, model) => {
            const levels = models.find(item => item.providerId === provider && item.modelId === model)?.thinkingLevels ?? ['off'];
            void chooseModel(provider, model, levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? 'off');
          }} />
        {agentControls}
        </>}
  </div>;
  const updateAutocomplete = React.useCallback((next: string, cursorPosition: number, inputSource: FileMentionAutocompleteInputSource = 'manual', insertedText?: string) => {
    if (dismissed.current === next && next === value) return;
    dismissed.current = undefined;
    const trigger = resolveAutocompleteTrigger(next, cursorPosition, { inputMode: 'normal', inputSource, insertedText, active: autocomplete });
    setAutocomplete(trigger);
    if (!trigger) setLayer(undefined);
  }, [autocomplete, value]);
  const handleCommandSelect = (command: CommandInfo, mode: 'confirm' | 'complete') => {
    if (!autocomplete || commandBusy || scope !== currentIdentity.current || commandContext.composer?.host !== getRuntimeEndpointGeneration() || inputRef.current?.getValue() !== value) return;
    if (command.source === 'backend') {
      if (!backendIdentity) { setCommandError(t('composer.menu.unavailable')); return; }
      inputRef.current?.insertReference(autocomplete.from, autocomplete.to, `/${command.name}`, { id: crypto.randomUUID(), host: commandContext.composer!.host, target: { kind: 'backend-command', name: command.name, backend: backendIdentity } }); closeMenu(); inputRef.current?.focus(); return;
    }
    if (command.skill) {
      inputRef.current?.insertReference(autocomplete.from, autocomplete.to, `/${command.skill.invocation}`, {
        id: crypto.randomUUID(), host: commandContext.composer!.host, target: { kind: 'skill', resourceId: command.skill.resourceId, version: command.skill.version, locator: command.skill.locator },
      }); closeMenu(); inputRef.current?.focus(); return;
    }
    if (mode === 'complete') { inputRef.current?.replaceRange(autocomplete.from, autocomplete.to, `/${command.name} `); closeMenu(); inputRef.current?.focus(); return; }
    void runCommand(command);
  };
  const applyReference = (text: string, target: ComposerReference['target']) => {
    if (!autocomplete || scope !== currentIdentity.current || commandContext.composer?.host !== getRuntimeEndpointGeneration() || inputRef.current?.getValue() !== value) return;
    const reference = { id: crypto.randomUUID(), host: commandContext.composer!.host, target, from: autocomplete.from, to: autocomplete.from + text.length, text };
    onReferenceSelect?.(reference);
    inputRef.current?.insertReference(autocomplete.from, autocomplete.to, text, reference);
    closeMenu(); inputRef.current?.focus();
  };
  const handleFileSelect = (file: { name: string; path: string; relativePath?: string; directory?: boolean }) => {
    applyReference(`@${file.relativePath || file.name}`, { kind: file.directory ? 'directory' : 'file', path: file.path, workspacePath: workspacePath ?? '', sourceKey: referenceScope ?? scope });
  };
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
    if (isIMECompositionEvent(event) || (event.shiftKey && (event.key === 'Enter' || event.key === 'Tab'))) return false;
    if (autocomplete !== null && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
      && ['Enter', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab'].includes(event.key)) {
      const controller = autocomplete.kind === 'command' ? commandRef.current : mentionRef.current;
      if (controller?.handleKeyDown(event.key)) return true;
      // An empty menu never inserts the unrelated next-step suggestion.
      if (event.key === 'Tab') return false;
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
      if (event.key === 'Escape') { onSuggestionDismiss?.(); return true; }
    }
    if (prepareSendMode && active && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'Enter' && !isIMECompositionEvent(event)) {
      if (canSend && !sending) submit('next_run');
      return true;
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
            'relative flex flex-col overflow-visible corner-continuous rounded-composer border border-border bg-muted',
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
            acceptFiles(files);
          }}
        >
        {/* Measured by the height glide; the frame around it is what animates. */}
        <div ref={inputContentRef} className="flex min-w-0 shrink-0 flex-col" data-conversation-composer-input-content="true">
        {children}
        {external && <ExternalChoiceValidation key={backendIdentity} options={external} />}

          {isMobile ? (
            <div className="flex min-w-0 items-center justify-end border-b border-border/40 px-2 py-1">
              {modelControls}
            </div>
          ) : null}
          <ComposerEditor
            key={identityKey}
            ref={bindEditor}
            value={value}
            references={references}
            autocomplete={autocomplete && !layer ? { id: menuId, activeId: activeOption } : undefined}
            interactions={interactions}
            onFocus={() => external?.onInteract('focus')}
            onChange={(change) => {
              external?.onInteract('input');
              latestDraft.current = { value: change.value, references: change.references };
              if (pendingHistoryTextRef.current === change.value) {
                pendingHistoryTextRef.current = null;
                return;
              }
              pendingHistoryTextRef.current = null;
              if (messageHistory.isBrowsing) messageHistory.reset();
              onChange(change.value, change.references, change.interactions);
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
              if (!files.length || attachmentDisabled) return;
              event.preventDefault();
              acceptFiles(files);
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
            <div className="conversation-composer-hint-row min-h-0 overflow-hidden px-3 typography-micro">
              <p>{backendControls === undefined ? t(botWorkbench ? 'chat.composer.botHint' : 'chat.composer.hint') : t('external.inputHint')}</p>
              <p aria-live="polite">
              {availableSuggestion && !autocomplete ? <button type="button" className="text-inherit transition-colors hover:text-primary"
                title={availableSuggestion} aria-label={`${t('chat.suggestion.applyAria')}: ${availableSuggestion}`}
                onMouseDown={event => event.preventDefault()} onClick={() => { acceptSuggestion(); inputRef.current?.focus(); }}>
                {isMobile ? t('chat.suggestion.applyAria') : t(ghostSuggestion ? 'chat.suggestion.acceptAndSendHint' : 'chat.suggestion.insertHint')}
              </button> : suggestionError ? <span title={suggestionError} className="text-muted-foreground/65">{t(suggestionError === 'next-step-model-unconfigured' ? 'chat.suggestion.configureModel' : 'chat.suggestion.unavailable')}</span> : null}
              </p>
            </div>
          </div>

          {commandError && <p role="alert" className="px-3 py-2 typography-meta text-destructive">{commandError}</p>}
          <AnimatePresence initial={false}>
          {autocomplete?.kind === 'command' ? <CommandAutocomplete key="command" ref={commandRef} additionalCommands={varinCommands}
            api={api} identity={identity} source={source} pendingSource={pendingSource} native={backendControls === undefined}
            cwd={workspacePath} sessionId={identityKey} searchQuery={autocomplete.query} menuId={menuId} onActive={setActiveOption}
            onCommandSelect={handleCommandSelect} onClose={closeMenu} title={layer?.label} onBack={() => { setLayer(undefined); setCommandError(undefined); inputRef.current?.focus(); }}>
              {layer ? typeof actions[layer.name]?.content === 'function' ? (actions[layer.name]!.content as (complete: () => void, context?: ComposerCommandDraftContext) => React.ReactNode)(() => { if (scope === currentIdentity.current) consumeFragment(); }, { text: value.slice(0, autocomplete.from) + value.slice(autocomplete.to), selectedText: (() => { const selection = inputRef.current?.getSelection(); return selection ? value.slice(selection.start, selection.end) : ''; })() }) : actions[layer.name]?.content as React.ReactNode : undefined}
            </CommandAutocomplete> : null}
          {autocomplete?.kind === 'mention' ? <FileMentionAutocomplete key="mention" ref={mentionRef} searchQuery={autocomplete.query}
            api={backendControls === undefined ? api : undefined} identity={identity} source={source} pendingSource={pendingSource} menuId={menuId} onActive={setActiveOption} workspacePath={workspacePath}
            attachments={attachmentCandidates} fileSelectionDisabled={backendControls === undefined ? undefined : t('external.attachments')}
            onAttachmentSelect={candidate => { if (candidate.attachment) applyReference(`@${candidate.name}`, { kind: 'attachment', attachment: candidate.attachment }); else if (candidate.fileId) applyReference(`@${candidate.name}`, { kind: 'draft-file', fileId: candidate.fileId }); }}
            onThreadSelect={(target, name) => applyReference(`@${name}`, { kind: 'thread', identity: target })}
            onFileSelect={handleFileSelect} onClose={closeMenu} /> : null}
          </AnimatePresence>

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
                  <DropdownMenuItem disabled={attachmentDisabled || imageDisabled} title={external && imageDisabled ? t(external.capabilities ? 'external.imagesUnsupported' : 'external.capabilitiesUnknown') : undefined} onClick={onAttachImages} className="gap-2.5 py-1.5">
                    <Icon name="attachment-2" className="size-4" />
                    {t('chat.fileAttachment.actions.chooseImages')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={attachmentDisabled || Boolean(external && !external.capabilities?.files)} title={external && !external.capabilities?.files ? t(external.capabilities ? 'external.filesUnsupported' : 'external.capabilitiesUnknown') : undefined} onClick={onAttachPdfs} className="gap-2.5 py-1.5">
                    <Icon name="file" className="size-4" />{t('chat.attachments.choose')}
                  </DropdownMenuItem>
                  {onOpenHistory && <DropdownMenuItem onClick={onOpenHistory}><Icon name="git-branch" className="size-4" />{t('chat.timeline.title')}</DropdownMenuItem>}
                  {onOpenRecovery && <DropdownMenuItem onClick={onOpenRecovery}><Icon name="history" className="size-4" />{t('chat.recovery.title')}</DropdownMenuItem>}
                  <DropdownMenuItem onClick={toggleExpandedInput} className="gap-2.5 py-1.5">
                    <Icon name={isExpandedInput ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                    {isExpandedInput ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {external && <ExternalModeControls key={backendIdentity} options={external} />}
              {backendControls === undefined && <ThreadPermissionControl workspacePath={permissionWorkspacePath} className={footerIconButtonClass} />}
              {backendControls === undefined && goalEnabled && onGoal && <button type="button" className={cn(footerIconButtonClass, goalArmed && 'text-primary bg-primary/10')} onClick={onGoal} aria-pressed={Boolean(goalArmed)} aria-label={t('chat.draftPresets.craftGoal.label')}><Icon name="target" className="size-4" /></button>}

              <WorkbenchContributionSlot kind="composer-action" slot={VARIN_CONVERSATION_SLOTS.composerLeading} props={{ identityKey, workspacePath, text: value, onChange, onSend: submit }} />
            </div>

            {!isMobile ? <div className="conversation-composer-models">{modelControls}</div> : null}
            <div className="conversation-composer-actions">
              <WorkbenchContributionSlot kind="composer-action" slot={VARIN_CONVERSATION_SLOTS.composerTrailing} props={{ identityKey, workspacePath, text: value, onChange, onSend: submit }} />
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
              {prepareSendMode && active && hasInput && !retrying ? <DropdownMenu>
                <DropdownMenuTrigger asChild><button type="button" className={footerIconButtonClass} disabled={pending} aria-label={t('bot.workspace.sendOptions')}><Icon name="arrow-down-s" className="size-3.5" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => submit('boundary')}><Icon name="arrow-up" className="size-4" />{t('bot.workspace.sendNow')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => submit('next_run')}><Icon name="time" className="size-4" />{t('bot.workspace.sendLater')}<span className="ml-auto typography-micro text-muted-foreground">Alt ↵</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu> : null}
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
        {(onWorkspace || connectionStatus) && <div className="flex min-w-0 items-center justify-between gap-2 px-1 pt-1" data-conversation-composer-status="true">
          <div className="min-w-0">{onWorkspace && <button type="button" onClick={onWorkspace} className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover" title={workspaceLabel}><Icon name="folder" className="size-3.5" /><span className="max-w-28 truncate">{workspaceLabel}</span></button>}</div>
          {connectionStatus}
        </div>}
      </div>
    </motion.div>
  );
};
