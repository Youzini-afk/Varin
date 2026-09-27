import React from 'react';
import type {
  ImageAttachment,
  SessionSnapshot,
  SessionWorkspaceBinding,
  ThinkingLevel,
} from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
  type CommandInfo,
} from '@/components/chat/CommandAutocomplete';
import {
  SkillAutocomplete,
  type SkillAutocompleteHandle,
} from '@/components/chat/SkillAutocomplete';
import {
  SnippetAutocomplete,
  type SnippetAutocompleteHandle,
} from '@/components/chat/SnippetAutocomplete';
import {
  FileMentionAutocomplete,
  type FileMentionHandle,
} from '@/components/chat/FileMentionAutocomplete';
import {
  resolveAutocompleteTrigger,
  type FileMentionAutocompleteInputSource,
} from '@/components/chat/composer/language/triggers';
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { MAGIC_PROMPT_COMMANDS } from '@/components/chat/composer/submit/slashCommands';
import { getInlineCommentDraftKey, useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { getRuntimeKey, runtimeFetch } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getMagicPromptDefinition } from '@/lib/magicPrompts';
import type { Snippet } from '@/types/snippet';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { PiActiveEditorContextSuggestion } from './PiActiveEditorContextSuggestion';
import { EditorContextAttachmentChips } from '@/components/workbench/EditorContextAttachmentChips';
import { PiGoalButton } from './PiGoalControls';
import { WorkbenchContributionSlot } from '@/lib/extensions/workbench-registry';
import { PiComposerModelControls } from './PiComposerModelControls';
import type { PiComposerModelSelection } from './piComposerSessionConfig';
import { insertPiComposerMention } from './piComposerMentions';
import { PiComposerAgentControl } from './PiComposerAgentControl';
import type { PiComposerAgentSelection } from '@/lib/pi-runtime/composerAgent';
import { useMessageHistory } from '@/components/chat/composer/state/useMessageHistory';
import { isPiAbortError } from '@/lib/pi-runtime/abort';
import { projectPiComposerActions } from './piComposerActions';
import { parsePiLocalCommand } from './piLocalCommands';
import type { WorkFocusId } from '@varin/protocol';
import { PiWorkFocusControl } from './PiWorkFocusControl';
import {
  isSamePiComposerAttachmentTarget,
  isPiComposerPdfUploadUnsupportedForSession,
  splitPiComposerAttachmentFiles,
  uploadPiComposerPdfFiles,
  type PiComposerAttachmentTarget,
} from './piComposerPdfAttachments';

interface PiComposerProps {
  active: boolean;
  allowModelInheritance: boolean;
  cwd: string;
  draft: string;
  effectiveModel?: PiComposerModelSelection;
  effectiveThinkingLevel?: ThinkingLevel;
  followUpBehavior: FollowUpBehavior;
  images: ImageAttachment[];
  messageHistory: readonly string[];
  onAbort?(): Promise<void> | void;
  onClearQueue?(): Promise<void> | void;
  onChangeAgent(value: PiComposerAgentSelection | undefined): void;
  onChangeDraft(value: string): void;
  onChangeImages(value: ImageAttachment[]): void;
  onChangeModel(value: PiComposerModelSelection | undefined): Promise<void> | void;
  onChangeThinkingLevel(value: ThinkingLevel | undefined): Promise<void> | void;
  onChangeWorkFocus(value: WorkFocusId | undefined): Promise<void> | void;
  onSend(): Promise<void> | void;
  onSendText(value: string): Promise<void> | void;
  selectedModel?: PiComposerModelSelection;
  selectedAgent?: PiComposerAgentSelection;
  selectedThinkingLevel?: ThinkingLevel;
  sending: boolean;
  sessionId?: string | null;
  snapshot?: SessionSnapshot;
  workspace?: SessionWorkspaceBinding;
  workFocus: WorkFocusId;
  defaultWorkFocus?: WorkFocusId;
  inheritedWorkFocus?: boolean;
}

const attachmentUrl = (attachment: ImageAttachment): string => (
  `data:${attachment.mimeType};base64,${attachment.data}`
);

const fileToAttachment = (file: File): Promise<ImageAttachment> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) {
      reject(new Error(`Could not decode ${file.name}`));
      return;
    }
    resolve({
      data: value.slice(separator + 1),
      mimeType: file.type || 'application/octet-stream',
    });
  };
  reader.readAsDataURL(file);
});

const MAGIC_VARIN_COMMANDS: readonly CommandInfo[] = MAGIC_PROMPT_COMMANDS.map((command) => ({
  description: getMagicPromptDefinition(command.visiblePrompt).description,
  id: `varin:${command.name}`,
  name: command.name,
  source: 'varin',
}));

type PiComposerAutocomplete = {
  kind: 'command' | 'mention' | 'skill' | 'snippet';
  query: string;
} | null;

export const PiComposer: React.FC<PiComposerProps> = ({
  active,
  allowModelInheritance,
  cwd,
  draft,
  effectiveModel,
  effectiveThinkingLevel,
  followUpBehavior,
  images,
  messageHistory: sentMessageHistory,
  onAbort,
  onClearQueue,
  onChangeAgent,
  onChangeDraft,
  onChangeImages,
  onChangeModel,
  onChangeThinkingLevel,
  onChangeWorkFocus,
  onSend,
  onSendText,
  selectedModel,
  selectedAgent,
  selectedThinkingLevel,
  sending,
  sessionId,
  snapshot,
  workspace,
  workFocus,
  defaultWorkFocus,
  inheritedWorkFocus,
}) => {
  const { t } = useI18n();
  const { documents, workspace: workspaceApi } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const parentSessionId = usePiSessionStore((state) => (
    sessionId
      ? state.summaries.find((summary) => summary.id === sessionId)?.parentId ?? null
      : null
  ));
  const pendingPdfScopeRef = React.useRef<{ cwd: string; runtimeKey: string; scopeId: string } | null>(null);
  if (!sessionId && (
    !pendingPdfScopeRef.current
    || pendingPdfScopeRef.current.cwd !== cwd
    || pendingPdfScopeRef.current.runtimeKey !== runtimeKey
  )) {
    pendingPdfScopeRef.current = {
      cwd,
      runtimeKey,
      scopeId: `pending-${crypto.randomUUID()}`,
    };
  }
  const attachmentTarget: PiComposerAttachmentTarget = {
    cwd,
    runtimeKey,
    scopeId: sessionId ?? pendingPdfScopeRef.current?.scopeId ?? `pending-${crypto.randomUUID()}`,
    sessionId: sessionId ?? null,
    parentSessionId,
    ...(workspace ? { workspace } : {}),
  };
  const latestAttachmentRef = React.useRef({ target: attachmentTarget, draft, onChangeDraft });
  latestAttachmentRef.current = { target: attachmentTarget, draft, onChangeDraft };
  const inputRef = React.useRef<ComposerEditorHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const skillRef = React.useRef<SkillAutocompleteHandle>(null);
  const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const pendingHistoryTextRef = React.useRef<string | null>(null);
  const [autocomplete, setAutocomplete] = React.useState<PiComposerAutocomplete>(null);
  const [confirmedMentions, setConfirmedMentions] = React.useState<ReadonlySet<string>>(() => new Set());
  const [knownAgentNames, setKnownAgentNames] = React.useState<ReadonlySet<string>>(() => new Set());
  const [aborting, setAborting] = React.useState(false);
  const [clearingQueue, setClearingQueue] = React.useState(false);
  const messageHistory = useMessageHistory(sentMessageHistory);
  const varinCommands = React.useMemo<readonly CommandInfo[]>(() => [
    ...MAGIC_VARIN_COMMANDS,
    ...(sessionId
      ? [{
          description: t('chat.commandAutocomplete.command.compactDescription'),
          id: 'varin:compact',
          name: 'compact',
          source: 'varin' as const,
        }]
      : []),
    {
      description: t('chat.timeline.description'),
      id: 'varin:tree',
      name: 'tree',
      source: 'varin',
    },
  ], [sessionId, t]);
  const isMobile = useUIStore((state) => state.isMobile);
  const isExpandedInput = useUIStore((state) => state.isExpandedInput);
  const toggleExpandedInput = useUIStore((state) => state.toggleExpandedInput);
  const busy = snapshot ? projectPiSessionActivity(snapshot).isWorking : false;
  const inlineDraftKey = snapshot && sessionId
    ? getInlineCommentDraftKey(getRuntimeKey(), cwd, sessionId)
    : null;
  const inlineDraftCount = useInlineCommentDraftStore((state) => (
    inlineDraftKey ? state.drafts[inlineDraftKey]?.length ?? 0 : 0
  ));
  const canSend = draft.trim().length > 0 || images.length > 0 || inlineDraftCount > 0;
  const composerActions = projectPiComposerActions({
    aborting,
    busy,
    canAbort: Boolean(onAbort),
    canSend,
    sending,
  });
  const footerIconButtonClass = 'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35';
  const snippets = useSnippetsStore((state) => state.snippets);
  const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
    attachmentFilenames: [],
    confirmedMentions,
    inputMode: 'normal',
    knownAgentNames,
    knownSlashNames: new Set(varinCommands.map((command) => command.name.toLowerCase())),
    knownSnippetTriggers: new Set(snippets.flatMap((snippet) => [snippet.name, ...snippet.aliases]).map((value) => value.toLowerCase())),
  }), [confirmedMentions, knownAgentNames, varinCommands, snippets]);
  const modelControls = (
    <div className="flex min-w-0 items-center justify-end gap-2.5">
      <PiComposerModelControls
        active={active}
        allowInherit={allowModelInheritance}
        cwd={cwd}
        disabled={sending}
        effectiveModel={effectiveModel}
        effectiveThinkingLevel={effectiveThinkingLevel}
        onModelChange={onChangeModel}
        onThinkingChange={onChangeThinkingLevel}
        selectedModel={selectedModel}
        selectedThinkingLevel={selectedThinkingLevel}
      />
      <PiComposerAgentControl
        active={active}
        cwd={cwd}
        disabled={sending}
        onChange={onChangeAgent}
        selectedAgent={selectedAgent}
        sessionId={sessionId}
      />
      <PiWorkFocusControl
        value={workFocus}
        state={snapshot?.workFocus}
        projectDefault={defaultWorkFocus}
        inherited={inheritedWorkFocus}
        disabled={sending}
        onChange={onChangeWorkFocus}
      />
    </div>
  );

  React.useEffect(() => {
    if (autocomplete?.kind === 'command' && !draft.startsWith('/')) setAutocomplete(null);
    if (autocomplete?.kind === 'skill' && !draft.includes('/')) setAutocomplete(null);
    if (autocomplete?.kind === 'snippet' && !draft.includes('#')) setAutocomplete(null);
    if (autocomplete?.kind === 'mention' && !draft.includes('@')) setAutocomplete(null);
  }, [autocomplete?.kind, draft]);

  const addImageFiles = React.useCallback(async (files: Iterable<File>) => {
    const imageFiles = [...files].filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    try {
      const attachments = await Promise.all(imageFiles.map(fileToAttachment));
      onChangeImages([...images, ...attachments]);
    } catch (error) {
      console.error('Failed to attach image to Pi prompt:', error);
      toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
    }
  }, [images, onChangeImages, t]);

  const addPdfFiles = React.useCallback(async (files: Iterable<File>) => {
    const pdfFiles = [...files];
    if (pdfFiles.length === 0) return;
    if (!workspaceApi) {
      toast.error(t('chat.piComposer.pdfAttachment.unsupported'));
      return;
    }
    const target = latestAttachmentRef.current.target;
    const isCurrentTarget = (): boolean => (
      getRuntimeKey() === target.runtimeKey
      && usePiSessionStore.getState().currentSessionId === target.sessionId
      && isSamePiComposerAttachmentTarget(latestAttachmentRef.current.target, target)
    );
    try {
      const result = await uploadPiComposerPdfFiles(pdfFiles, {
        documents,
        isCurrentTarget,
        randomUUID: () => crypto.randomUUID(),
        target,
        workspaceApi,
        isSessionUnsupported: () => isPiComposerPdfUploadUnsupportedForSession({
          fetchThreads: (path) => runtimeFetch(path, { cache: 'no-store' }),
          parentSessionId: target.parentSessionId,
          sessionId: target.sessionId,
        }),
      });
      if (result.status === 'stale') return;
      if (result.status === 'unsupported') {
        toast.error(t('chat.piComposer.pdfAttachment.unsupported'));
        return;
      }
      if (result.references.length > 0 && isCurrentTarget()) {
        const current = latestAttachmentRef.current;
        const separator = current.draft.length === 0 || current.draft.endsWith('\n') ? '' : '\n';
        current.onChangeDraft(`${current.draft}${separator}${result.references.join('\n')}`);
      }
      for (const failure of result.failures) {
        console.error(`Failed to attach PDF to Pi prompt (${failure.name}):`, failure.error);
        toast.error(t('chat.piComposer.pdfAttachment.uploadFailed', { name: failure.name }));
      }
    } catch (error) {
      console.error('Failed to attach PDF to Pi prompt:', error);
      toast.error(t('chat.piComposer.pdfAttachment.uploadFailed', { name: pdfFiles[0]?.name ?? '' }));
    }
  }, [documents, t, workspaceApi]);

  const addFiles = React.useCallback(async (files: Iterable<File>) => {
    const classified = splitPiComposerAttachmentFiles(files);
    await Promise.all([
      addImageFiles(classified.images),
      addPdfFiles(classified.pdfs),
    ]);
  }, [addImageFiles, addPdfFiles]);

  const steeringQueue = snapshot?.steering ?? [];
  const followUpQueue = snapshot?.followUp ?? [];
  const queuedMessageCount = steeringQueue.length + followUpQueue.length;

  const handleClearQueue = React.useCallback(async () => {
    if (!onClearQueue || clearingQueue) return;
    setClearingQueue(true);
    try {
      await onClearQueue();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setClearingQueue(false);
    }
  }, [clearingQueue, onClearQueue]);

  const handleAbort = React.useCallback(async () => {
    if (!onAbort || aborting) return;
    setAborting(true);
    try {
      await onAbort();
    } catch (error) {
      if (!isPiAbortError(error)) toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAborting(false);
    }
  }, [aborting, onAbort]);

  const insertTranscript = React.useCallback((text: string) => {
    const next = [draft.trimEnd(), text.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    onChangeDraft(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, onChangeDraft]);

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
    if (trigger) {
      setAutocomplete({ kind: trigger.kind, query: trigger.query });
      return;
    }
    setAutocomplete(null);
  }, []);

  const handleCommandSelect = React.useCallback((command: CommandInfo) => {
    const value = `/${command.name} `;
    onChangeDraft(value);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelection(value.length);
    });
  }, [onChangeDraft]);

  const handleSnippetSelect = React.useCallback((_snippet: Snippet, trigger: string) => {
    const input = inputRef.current;
    const cursorPosition = input?.getSelection().end ?? draft.length;
    const hashIndex = draft.slice(0, cursorPosition).lastIndexOf('#');
    const startIndex = hashIndex === -1 ? cursorPosition : hashIndex;
    const value = `${draft.slice(0, startIndex)}#${trigger} ${draft.slice(cursorPosition)}`;
    onChangeDraft(value);
    setAutocomplete(null);
    const nextCursor = startIndex + trigger.length + 2;
    requestAnimationFrame(() => {
      const editor = inputRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(nextCursor);
    });
  }, [draft, onChangeDraft]);

  const handleSkillSelect = React.useCallback((invocation: string) => {
    const input = inputRef.current;
    const cursorPosition = input?.getSelection().end ?? draft.length;
    const slashIndex = draft.slice(0, cursorPosition).lastIndexOf('/');
    const startIndex = slashIndex === -1 ? cursorPosition : slashIndex;
    const value = `${draft.slice(0, startIndex)}/${invocation} ${draft.slice(cursorPosition)}`;
    onChangeDraft(value);
    setAutocomplete(null);
    const nextCursor = startIndex + invocation.length + 2;
    requestAnimationFrame(() => {
      const editor = inputRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(nextCursor);
    });
  }, [draft, onChangeDraft]);

  const applyMention = React.useCallback((mention: string, kind: 'agent' | 'file') => {
    const cursor = inputRef.current?.getSelection().start ?? draft.length;
    const insertion = insertPiComposerMention(draft, cursor, mention);
    if (kind === 'agent') {
      setKnownAgentNames((current) => new Set(current).add(mention.toLowerCase()));
    } else {
      setConfirmedMentions((current) => new Set(current).add(mention));
    }
    onChangeDraft(insertion.text);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(insertion.cursor);
    });
  }, [draft, onChangeDraft]);

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
    onChangeDraft(value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(value.length);
    });
  }, [onChangeDraft]);

  const submit = React.useCallback(() => {
    messageHistory.reset();
    return onSend();
  }, [messageHistory, onSend]);

  const submitText = React.useCallback((value: string) => {
    messageHistory.reset();
    return onSendText(value);
  }, [messageHistory, onSendText]);

  const handleEditorKeyDown = React.useCallback((event: KeyboardEvent): boolean => {
    if (autocomplete?.kind === 'command'
      && event.key === 'Enter'
      && !event.shiftKey
      && !isIMECompositionEvent(event)
      && parsePiLocalCommand(draft)?.kind === 'compact') {
      setAutocomplete(null);
      if (canSend && !sending) void submit();
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
      else if (autocomplete.kind === 'snippet') snippetRef.current?.handleKeyDown(event.key);
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
          ? messageHistory.older(draft)
          : event.key === 'ArrowDown'
            && selection.end === draft.length
            && messageHistory.isBrowsing
            ? messageHistory.newer()
            : null;
        if (recalled !== null) {
          applyHistoryText(recalled);
          return true;
        }
      }
    }
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || isIMECompositionEvent(event)
    ) return false;
    if (canSend && !sending) void submit();
    return true;
  }, [applyHistoryText, autocomplete, canSend, draft, messageHistory, sending, submit]);

  return (
    <div className={cn(
      'bottom-safe-area oc-mobile-composer shrink-0 bg-background pb-3',
      isExpandedInput && 'fixed inset-0 z-40 flex items-end bg-background/95',
    )} data-pi-composer-shell="true">
      <div className={cn('chat-input-column', isExpandedInput && 'flex h-full flex-col justify-end py-6')}>
        {queuedMessageCount > 0 && (
          <section
            className="mb-2 overflow-hidden rounded-xl border border-border/60 bg-muted/15"
            data-pi-runtime-queue="true"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
              <span className="typography-meta font-medium text-foreground">
                {t('chat.queuedMessage.title')} · {queuedMessageCount}
              </span>
              {onClearQueue ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={clearingQueue}
                      onClick={() => void handleClearQueue()}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
                      aria-label={t('chat.queuedMessage.removeAria')}
                    >
                      <Icon
                        name={clearingQueue ? 'loader-4' : 'close'}
                        className={cn('size-3.5', clearingQueue && 'animate-spin')}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('chat.queuedMessage.removeAria')}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="divide-y divide-border/40">
              {steeringQueue.map((message, index) => (
                <div key={`steer:${index}:${message}`} className="flex items-start gap-2 px-3 py-2">
                  <span className="mt-0.5 shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 typography-micro font-medium text-primary">
                    {t('settings.varin.visual.option.followUpBehavior.steer.label')}
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words typography-meta text-foreground">
                    {message || t('chat.queuedMessage.empty')}
                  </p>
                </div>
              ))}
              {followUpQueue.map((message, index) => (
                <div key={`follow-up:${index}:${message}`} className="flex items-start gap-2 px-3 py-2">
                  <span className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 py-0.5 typography-micro font-medium text-muted-foreground">
                    {t('settings.varin.visual.option.followUpBehavior.queue.label')}
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words typography-meta text-foreground">
                    {message || t('chat.queuedMessage.empty')}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <div key={`${image.mimeType}:${index}`} className="group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
                <img src={attachmentUrl(image)} alt={image.mimeType} className="size-20 object-cover" />
                <button
                  type="button"
                  onClick={() => onChangeImages(images.filter((_, candidate) => candidate !== index))}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
                  aria-label={t('chat.fileAttachment.actions.removeImage')}
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {snapshot ? <EditorContextAttachmentChips sessionId={snapshot.sessionId} /> : null}
        {snapshot ? <PiActiveEditorContextSuggestion snapshot={snapshot} /> : null}

        <div
          className={cn(
            'relative flex flex-col overflow-visible rounded-xl border border-border bg-[var(--surface-elevated)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--interactive-border-focus)] focus-within:ring-1 focus-within:ring-[var(--interactive-focus-ring)]',
            sending && 'opacity-80',
          )}
          data-pi-composer-input-frame="true"
          onDragOver={(event) => {
            if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
        >
          {isMobile ? (
            <div className="flex min-w-0 items-center justify-end border-b border-border/40 px-2 py-1">
              {modelControls}
            </div>
          ) : null}
          <ComposerEditor
            ref={inputRef}
            value={draft}
            onChange={(change) => {
              if (pendingHistoryTextRef.current === change.value) {
                pendingHistoryTextRef.current = null;
                return;
              }
              pendingHistoryTextRef.current = null;
              if (messageHistory.isBrowsing) messageHistory.reset();
              onChangeDraft(change.value);
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
              updateAutocomplete(draft, selection.end);
            }}
            onPaste={(event) => {
              const files = event.clipboardData ? [...event.clipboardData.files] : [];
              if (!files.some((file) => file.type.startsWith('image/'))) return;
              event.preventDefault();
              void addImageFiles(files);
            }}
            onKeyDown={handleEditorKeyDown}
            languageContext={languageContext}
            placeholder={t('chat.chatInput.placeholder.chat')}
            className={cn(
              'min-h-[48px] w-full px-3 pb-1 pt-3 typography-markdown text-foreground md:typography-ui-label',
              isExpandedInput ? 'min-h-[40vh]' : 'max-h-[40vh]',
            )}
            maxLines={isExpandedInput ? 24 : 9}
          />

          {autocomplete?.kind === 'command' ? (
            <CommandAutocomplete
              ref={commandRef}
              additionalCommands={varinCommands}
              cwd={cwd}
              sessionId={sessionId}
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
              onFileSelect={handleFileSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'skill' ? (
            <SkillAutocomplete
              ref={skillRef}
              cwd={cwd}
              sessionId={sessionId}
              searchQuery={autocomplete.query}
              onSkillSelect={handleSkillSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'snippet' ? (
            <SnippetAutocomplete
              ref={snippetRef}
              searchQuery={autocomplete.query}
              onSnippetSelect={handleSnippetSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          <div data-chat-input-footer="true" className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pb-2 pt-0.5">
            <div className="flex min-w-0 items-center gap-0.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,application/pdf"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files;
                  if (files) void addFiles(files);
                  event.target.value = '';
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={footerIconButtonClass}
                    aria-label={t('chat.piComposer.options')}
                    title={t('chat.piComposer.options')}
                  >
                    <Icon name="add" className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="min-w-48">
                  <DropdownMenuItem onClick={() => fileInputRef.current?.click()} className="gap-2.5 py-1.5">
                    <Icon name="attachment-2" className="size-4" />
                    {t('chat.chatInput.actions.attachFiles')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleExpandedInput} className="gap-2.5 py-1.5">
                    <Icon name={isExpandedInput ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                    {isExpandedInput ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <WorkbenchContributionSlot
                kind="composer-action"
                slot="chat.composer.actions.leading"
                props={{ cwd, draft, effectiveModel, effectiveThinkingLevel, footerIconButtonClass, images, onChangeAgent, onChangeDraft, onChangeImages, onChangeModel, onChangeThinkingLevel, onSend: submit, selectedAgent, selectedModel, selectedThinkingLevel, sending, sessionId, snapshot, workspace, workFocus, defaultWorkFocus, inheritedWorkFocus, onChangeWorkFocus }}
              />
              <PiGoalButton footerIconButtonClass={footerIconButtonClass} snapshot={snapshot} />
              {inlineDraftCount > 0 && (
                <span className="truncate px-1 typography-micro text-muted-foreground">
                  {t('chat.piComposer.attachedContext', { count: inlineDraftCount })}
                </span>
              )}
              {busy && (
                <span className="truncate px-1 typography-micro text-muted-foreground">
                  {followUpBehavior === 'queue'
                    ? t('chat.piComposer.queueFollowUp')
                    : t('chat.piComposer.steerCurrentRun')}
                </span>
              )}
            </div>

            <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
              {!isMobile ? modelControls : null}
              <WorkbenchContributionSlot
                kind="composer-action"
                slot="chat.composer.actions.trailing"
                props={{ cwd, draft, effectiveModel, effectiveThinkingLevel, images, onChangeAgent, onChangeDraft, onChangeImages, onChangeModel, onChangeThinkingLevel, onSend: submit, selectedAgent, selectedModel, selectedThinkingLevel, sending, sessionId, snapshot, workspace, workFocus, defaultWorkFocus, inheritedWorkFocus, onChangeWorkFocus }}
              />
              <ComposerDictation
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
                      data-pi-composer-secondary-stop="true"
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
                    disabled={composerActions.primary === 'stop' ? aborting : !canSend || sending}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-lg transition-colors',
                      composerActions.primary === 'stop'
                        ? aborting
                          ? 'cursor-wait bg-primary/70 text-primary-foreground'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : canSend && !sending
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'cursor-not-allowed bg-transparent text-muted-foreground/35',
                    )}
                    aria-label={composerActions.primary === 'stop'
                      ? t('chat.chatInput.actions.stopGeneratingAria')
                      : t('chat.chatInput.actions.sendMessageAria')}
                    aria-busy={composerActions.primary === 'stop' ? aborting : undefined}
                    data-pi-composer-primary-action={composerActions.primary}
                  >
                    <Icon
                      name={composerActions.primary === 'stop'
                        ? aborting ? 'loader-4' : 'stop'
                        : sending ? 'loader-4' : 'arrow-up'}
                      className={cn(
                        'size-4',
                        ((composerActions.primary === 'stop' && aborting)
                          || (composerActions.primary === 'send' && sending))
                          && 'animate-spin',
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {composerActions.primary === 'stop'
                    ? t('chat.chatInput.actions.stopGeneratingAria')
                    : t('chat.chatInput.actions.sendMessageAria')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
