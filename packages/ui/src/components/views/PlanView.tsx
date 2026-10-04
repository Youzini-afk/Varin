import React from 'react';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
import { PreviewToggleButton } from './PreviewToggleButton';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';

import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { RiCheckLine, RiClipboardLine, RiCodeAiLine, RiLoopRightAiLine } from '@remixicon/react';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { pickWorkspaceRoot } from '@/lib/documents/path';
import { resolveTextDocumentIdentity } from '@/lib/documents/workspace-text';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { EditorView } from '@codemirror/view';
import { copyTextToClipboard } from '@/lib/clipboard';
import { parseProjectPlanMarkdown } from '@/lib/project-config';
import { createPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { createPiWorktreeSession } from '@/lib/pi-runtime/worktreeSession';
import { TodoSendDialog, type TodoSendExecution } from '@/components/session/TodoSendDialog';
import { Icon } from "@/components/icon/Icon";
import { toast } from '@/components/ui';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { actionInstruction } from '@/lib/actionInstructions';
import { useI18n } from '@/lib/i18n';

type PlanViewProps = {
  targetPath?: string | null;
};

type PlanSendAction = 'improve' | 'implement';
type PlanSendTarget = 'session' | 'worktree';

type PendingPlanSend = {
  action: PlanSendAction;
  target: PlanSendTarget;
};

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const buildRepoPlanPath = (directory: string, created: number, slug: string): string => {
  return joinPath(joinPath(joinPath(directory, '.varin'), 'plans'), `${created}-${slug}.md`);
};

const buildHomePlanPath = (created: number, slug: string): string => {
  return `~/.varin/plans/${created}-${slug}.md`;
};

const resolveTilde = (path: string, homeDir: string | null): string => {
  const trimmed = path.trim();
  if (!trimmed.startsWith('~')) return trimmed;
  if (trimmed === '~') return homeDir || trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return homeDir ? `${homeDir}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
};

const toDisplayPath = (resolvedPath: string, options: { currentDirectory: string; homeDirectory: string }): string => {
  const current = normalize(options.currentDirectory);
  const home = normalize(options.homeDirectory);
  const normalized = normalize(resolvedPath);

  if (current && normalized.startsWith(current + '/')) {
    return normalized.slice(current.length + 1);
  }

  if (home && normalized === home) {
    return '~';
  }

  if (home && normalized.startsWith(home + '/')) {
    return `~${normalized.slice(home.length)}`;
  }

  return normalized;
};

const resolveProjectRefForDirectory = (
  directory: string,
  projects: Array<{ id: string; path: string }>,
  activeProjectId: string | null,
): { id: string; path: string } | null => {
  const normalized = normalize(directory.trim());
  if (!normalized) {
    return null;
  }

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) ?? null
    : null;

  if (activeProject?.path) {
    const activePath = normalize(activeProject.path);
    if (normalized === activePath || normalized.startsWith(`${activePath}/`)) {
      return { id: activeProject.id, path: activeProject.path };
    }
  }

  const match = projects
    .filter((project) => {
      const projectPath = normalize(project.path);
      return normalized === projectPath || normalized.startsWith(`${projectPath}/`);
    })
    .sort((left, right) => normalize(right.path).length - normalize(left.path).length)[0];

  return match ? { id: match.id, path: match.path } : null;
};

type SelectedLineRange = {
  start: number;
  end: number;
};

export const PlanView: React.FC<PlanViewProps> = ({ targetPath = null }) => {
  const { t } = useI18n();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const sessionSummary = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.summaries.find((summary) => summary.id === state.currentSessionId)
  ));
  const sessionSnapshot = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]?.snapshot
  ));
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const gitDirectories = useGitStore((state) => state.directories);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const runtimeApis = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const { currentTheme } = useThemeSystem();

  const sessionDirectory = React.useMemo(() => {
    return normalize(sessionSnapshot?.cwd || sessionSummary?.cwd || '');
  }, [sessionSnapshot?.cwd, sessionSummary?.cwd]);
  const projectDirectory = React.useMemo(
    () => normalize(effectiveDirectory || sessionDirectory),
    [effectiveDirectory, sessionDirectory],
  );
  const sessionCreatedAt = sessionSummary ? Date.parse(sessionSummary.createdAt) : Number.NaN;
  const sessionPlanSlug = currentSessionId?.replace(/[^a-zA-Z0-9._-]+/g, '-') ?? '';
  const currentProjectRef = React.useMemo(
    () => resolveProjectRefForDirectory(projectDirectory, projects, activeProjectId),
    [activeProjectId, projectDirectory, projects],
  );
  const canCreateWorktree = React.useMemo(
    () => (currentProjectRef ? gitDirectories.get(currentProjectRef.path)?.isGitRepo === true : false),
    [currentProjectRef, gitDirectories],
  );
  const [pendingPlanSend, setPendingPlanSend] = React.useState<PendingPlanSend | null>(null);
  const [isPlanSendSubmitting, setIsPlanSendSubmitting] = React.useState(false);

  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null);
  const [planIdentity, setPlanIdentity] = React.useState<DocumentIdentity | undefined>(undefined);
  const planRecord = useDocumentRecord(planIdentity);
  const content = planRecord?.buffer ?? '';
  const displayPath = React.useMemo(() => {
    if (!resolvedPath || !sessionDirectory || !homeDirectory) {
      return resolvedPath;
    }
    return toDisplayPath(resolvedPath, { currentDirectory: sessionDirectory, homeDirectory });
  }, [resolvedPath, sessionDirectory, homeDirectory]);
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const showMessageTTSButtons = usePreferencesStore((state) => state.showMessageTTSButtons);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const planFileLabel = React.useMemo(() => {
    return displayPath ? displayPath.split('/').pop() || t('planView.file.defaultName') : t('planView.file.defaultName');
  }, [displayPath, t]);
  const parsedTitle = React.useMemo(() => {
    if (!content.trim()) {
      return t('planView.title.default');
    }
    return parseProjectPlanMarkdown(content).title || t('planView.title.default');
  }, [content, t]);
  const sendPromptTitle = React.useMemo(() => parsedTitle.trim() || t('planView.title.default'), [parsedTitle, t]);
  const [loading, setLoading] = React.useState(false);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('edit');
  const copiedContentTimeoutRef = React.useRef<number | null>(null);

  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);

  const MD_VIEWER_MODE_KEY = 'varin:plan:md-viewer-mode';

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (parsed === 'preview' || parsed === 'edit') {
        setMdViewMode(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  const saveMdViewMode = React.useCallback((mode: 'preview' | 'edit') => {
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, JSON.stringify(mode));
    } catch {
      // ignore
    }
  }, []);
  const isSelectingRef = React.useRef(false);
  const selectionStartRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingRef.current = false;
      selectionStartRef.current = null;
      setIsDragging(false);
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  const extractSelectedCode = React.useCallback((text: string, range: SelectedLineRange): string => {
    const lines = text.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const commentController = useInlineCommentController<SelectedLineRange>({
    source: 'plan',
    fileLabel: planFileLabel,
    language: resolvedPath ? getLanguageFromExtension(resolvedPath) || 'markdown' : 'markdown',
    getCodeForRange: (range) => extractSelectedCode(content, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
  });

  const {
    drafts: planFileDrafts,
    commentText,
    setCommentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = commentController;

  React.useEffect(() => {
    setLineSelection(null);
    reset();
  }, [content, reset]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  const handleCancelComment = React.useCallback(() => {
    setLineSelection(null);
    cancel();
  }, [cancel]);

  const handleSaveComment = React.useCallback((textToSave: string, rangeOverride?: { start: number; end: number }) => {
    if (rangeOverride) {
      setLineSelection(rangeOverride);
    }
    saveComment(textToSave, rangeOverride ?? lineSelection ?? undefined);
    setLineSelection(null);
  }, [lineSelection, saveComment]);

  React.useEffect(() => {
    if (!lineSelection) return;

    if (isMobile && !editingDraftId) {
      // Input handles mobile scroll/focus behavior.
    }

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-comment-card="true"]') ||
        target.closest('[data-comment-input="true"]') ||
        target.closest('.oc-block-widget')
      ) {
        return;
      }

      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      if (!commentText.trim()) {
        setLineSelection(null);
        cancel();
      }
    };

    const timeoutId = window.setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, commentText, editingDraftId, isMobile, lineSelection]);

  const editorFontSize = useUIStore((state) => state.editorFontSize);

  const editorExtensions = React.useMemo(() => {
    // Shiki token colors only for code files; markdown keeps the lezer
    // highlighter (markdown-aware bold headings etc., and no Shiki view to match).
    const shikiLanguage = resolvedPath ? getLanguageFromExtension(resolvedPath) : null;
    const useShiki = Boolean(shikiLanguage) && shikiLanguage !== 'markdown';
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, useShiki ? { syntaxColors: false, fontSize: editorFontSize } : { fontSize: editorFontSize })];
    const language = languageByExtension(resolvedPath || 'plan.md');
    if (language) {
      extensions.push(language);
    }
    if (useShiki && shikiLanguage) {
      extensions.push(shikiHighlightExtension({
        language: shikiLanguage,
        themeName: currentTheme.metadata.id,
        theme: getResolvedShikiTheme(currentTheme),
      }));
    }
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, resolvedPath, editorFontSize]);

  React.useEffect(() => {
    // Saved project plans opened via context panel should work even when session plan mode is off.
    if (!planModeEnabled && !targetPath) {
      setResolvedPath(null);
      setPlanIdentity(undefined);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const openPlan = async (path: string): Promise<DocumentIdentity> => {
      const root = pickWorkspaceRoot(path, [sessionDirectory, homeDirectory, effectiveDirectory]);
      if (!root) {
        throw new Error(t('filesView.document.outsideWorkspace'));
      }
      const identity = await resolveTextDocumentIdentity(runtimeApis.documents, root, path);
      const record = await getDocumentRegistry().open(identity);
      if (record.status === 'missing' && !record.dirty) {
        throw new Error(t('filesView.error.readFileFailed'));
      }
      if (record.status === 'error' || record.status === 'binary' || record.status === 'unsupported-encoding') {
        throw new Error(record.errorMessage ?? t('filesView.error.readFileFailed'));
      }
      return identity;
    };

    const run = async () => {
      setResolvedPath(null);
      setPlanIdentity(undefined);
      setSaveError(null);

      if (targetPath) {
        setLoading(true);
        try {
          const identity = await openPlan(targetPath);
          if (cancelled) return;
          setResolvedPath(targetPath);
          setPlanIdentity(identity);
        } catch {
          if (cancelled) return;
          setResolvedPath(null);
          setPlanIdentity(undefined);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      if (!sessionPlanSlug || !Number.isFinite(sessionCreatedAt) || !sessionDirectory) {
        setResolvedPath(null);
        setPlanIdentity(undefined);
        return;
      }

      setLoading(true);

      try {
        const repoPath = buildRepoPlanPath(sessionDirectory, sessionCreatedAt, sessionPlanSlug);
        const homePath = resolveTilde(buildHomePlanPath(sessionCreatedAt, sessionPlanSlug), homeDirectory || null);

        let resolved: string | null = null;
        let identity: DocumentIdentity | undefined;

        try {
          identity = await openPlan(repoPath);
          resolved = repoPath;
        } catch {
          // ignore
        }

        if (!resolved) {
          try {
            identity = await openPlan(homePath);
            resolved = homePath;
          } catch {
            // ignore
          }
        }

        if (cancelled) return;

        if (!resolved || !identity) {
          setResolvedPath(null);
          setPlanIdentity(undefined);
          return;
        }

        setResolvedPath(resolved);
        setPlanIdentity(identity);
      } catch {
        if (cancelled) return;
        setResolvedPath(null);
        setPlanIdentity(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [effectiveDirectory, homeDirectory, planModeEnabled, runtimeApis.documents, sessionCreatedAt, sessionDirectory, sessionPlanSlug, t, targetPath]);

  React.useEffect(() => {
    if (!planIdentity || !planRecord?.dirty) {
      return;
    }

    const controller = window.setTimeout(async () => {
      setSaveError(null);
      try {
        const saved = await getDocumentRegistry().save(planIdentity);
        if (saved.status === 'conflict' || saved.status === 'error') {
          throw new Error(saved.errorMessage ?? t('planView.error.writeFailed'));
        }
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : t('planView.error.saveFailed'));
      }
    }, 350);

    return () => {
      window.clearTimeout(controller);
    };
  }, [planIdentity, planRecord?.dirty, planRecord?.localEditRevision, t]);

  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
    };
  }, []);

  const routeToChat = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
  }, [setActiveMainTab, setSessionSwitcherOpen]);

  const handleConfirmPlanSend = React.useCallback(
    async (execution: TodoSendExecution) => {
      if (!currentProjectRef || !pendingPlanSend) {
        return;
      }

      const visiblePrompt = await actionInstruction(
        pendingPlanSend.action === 'improve' ? 'plan.improve.visible' : 'plan.implement.visible',
        {
          plan_title: sendPromptTitle,
        },
      );
      const instructionsText = await actionInstruction(
        pendingPlanSend.action === 'improve' ? 'plan.improve.instructions' : 'plan.implement.instructions',
        {
          plan_title: sendPromptTitle,
          plan_path: resolvedPath ?? '',
        },
      );
      setIsPlanSendSubmitting(true);

      try {
        routeToChat();
        let sessionId: string;
        if (pendingPlanSend.target === 'worktree') {
          if (!canCreateWorktree) return;
          const projectsState = useProjectsStore.getState();
          if (projectsState.activeProjectId !== currentProjectRef.id) {
            projectsState.setActiveProjectIdOnly(currentProjectRef.id);
          }
          sessionId = (await createPiWorktreeSession()).sessionId;
        } else {
          sessionId = (await createPiSessionFromNavigation({
            directory: currentProjectRef.path,
            projectId: currentProjectRef.id,
          })).sessionId;
        }
        // Pi receives the full plan directly. Goal mode adds explicit completion
        // criteria without routing the request through the legacy goal runtime.
        const goalObjective = execution.runAsGoal === true
          ? [
              `Implement the plan "${sendPromptTitle}" end-to-end${resolvedPath ? ` (plan file: ${resolvedPath})` : ''}.`,
              'Re-read that file for full details — it is the source of truth.',
              '',
              content,
            ].join('\n')
          : null;
        const promptText = [visiblePrompt, instructionsText, goalObjective]
          .filter((value): value is string => Boolean(value?.trim()))
          .join('\n\n');
        const sessionState = usePiSessionStore.getState();
        await sessionState.selectModel(sessionId, {
          id: execution.modelID,
          provider: execution.providerID,
        });
        await sessionState.selectThinking(sessionId, execution.thinkingLevel);
        if (!await sessionState.prompt(sessionId, promptText)) {
          throw new Error('The Pi runtime did not accept the plan prompt');
        }

        setPendingPlanSend(null);
      } catch (error) {
        toast.error('Failed to start Pi plan session', {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsPlanSendSubmitting(false);
      }
    },
    [canCreateWorktree, content, currentProjectRef, pendingPlanSend, resolvedPath, routeToChat, sendPromptTitle]
  );

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: planFileDrafts,
      editingDraftId,
      commentText,
      onTextChange: setCommentText,
      selection: lineSelection,
      isDragging,
      fileLabel: planFileLabel,
      newWidgetId: 'plan-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: handleCancelComment,
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [commentText, deleteDraft, editingDraftId, handleCancelComment, handleSaveComment, isDragging, lineSelection, planFileDrafts, planFileLabel, setCommentText, startEdit]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-1.5 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label font-medium truncate">{parsedTitle}</div>
          {saveError ? (
            <div className="typography-micro text-[color:var(--status-error)] truncate" title={saveError}>
              {t('planView.error.saveFailed')}
            </div>
          ) : null}
        </div>
        {resolvedPath ? (
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      aria-label={t('planView.actions.improvePlanAria')}
                      disabled={!content.trim()}
                    >
                      <RiLoopRightAiLine className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('planView.actions.improve')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setPendingPlanSend({ action: 'improve', target: 'session' })}>
                  {t('planView.actions.sendToNewSession')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'improve', target: 'worktree' })}
                  disabled={!canCreateWorktree}
                >
                  {t('planView.actions.sendToNewWorktreeSession')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      aria-label={t('planView.actions.implementPlanAria')}
                      disabled={!content.trim()}
                    >
                      <RiCodeAiLine className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('planView.actions.implement')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setPendingPlanSend({ action: 'implement', target: 'session' })}>
                  {t('planView.actions.sendToNewSession')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'implement', target: 'worktree' })}
                  disabled={!canCreateWorktree}
                >
                  {t('planView.actions.sendToNewWorktreeSession')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PreviewToggleButton
              currentMode={mdViewMode}
              onToggle={() => saveMdViewMode(mdViewMode === 'preview' ? 'edit' : 'preview')}
            />
            {mdViewMode === 'preview' && showMessageTTSButtons && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0"
                    aria-label={isTTSPlaying ? t('planView.tts.stopSpeaking') : t('planView.tts.readAloud')}
                    onClick={() => {
                      if (isTTSPlaying) {
                        stopTTS();
                      } else if (content.trim()) {
                        void playTTS(content);
                      }
                    }}
                  >
                    {isTTSPlaying ? (
                      <Icon name="stop" className="h-4 w-4 text-[color:var(--status-success)]" />
                    ) : (
                      <Icon name="volume-up" className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>
                  {isTTSPlaying ? t('planView.tts.stopSpeaking') : t('planView.tts.readAloud')}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(content);
                if (result.ok) {
                  setCopiedContent(true);
                  if (copiedContentTimeoutRef.current !== null) {
                    window.clearTimeout(copiedContentTimeoutRef.current);
                  }
                  copiedContentTimeoutRef.current = window.setTimeout(() => {
                    setCopiedContent(false);
                  }, 1200);
                } else {
                  // ignored
                }
              }}
              className="h-5 w-5 p-0"
              title={t('planView.actions.copyPlanContents')}
              aria-label={t('planView.actions.copyPlanContents')}
            >
              {copiedContent ? (
                <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <RiClipboardLine className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      <TodoSendDialog
        open={pendingPlanSend !== null}
        onOpenChange={(open) => {
          if (!open && !isPlanSendSubmitting) {
            setPendingPlanSend(null);
          }
        }}
        target={pendingPlanSend?.target ?? 'session'}
        projectDirectory={currentProjectRef?.path ?? null}
        submitting={isPlanSendSubmitting}
        allowRunAsGoal
        onConfirm={handleConfirmPlanSend}
      />

      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {loading ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('planView.state.loading')}</div>
          ) : (
            <div className="relative h-full">
              <div className="h-full">
                {mdViewMode === 'preview' ? (
                  <div className="h-full overflow-auto p-3">
                    <ErrorBoundary
                      fallback={
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                          <div className="mb-1 font-medium text-destructive">{t('planView.error.previewUnavailable')}</div>
                          <div className="text-sm text-muted-foreground">
                            {t('planView.error.switchToEditMode')}
                          </div>
                        </div>
                      }
                    >
                      <SimpleMarkdownRenderer content={content} className="typography-markdown-body" enableFileReferences={false} />
                    </ErrorBoundary>
                  </div>
                ) : planIdentity ? (
                  <div className="relative h-full" ref={editorWrapperRef}>
                    <DocumentCodeMirror
                      identity={planIdentity}
                      readOnly={false}
                      className="h-full"
                      extensions={editorExtensions}
                      onViewReady={(view) => { editorViewRef.current = view; }}
                      onViewDestroy={() => { editorViewRef.current = null; }}
                      blockWidgets={blockWidgets}
                      highlightLines={lineSelection
                        ? {
                          start: Math.min(lineSelection.start, lineSelection.end),
                          end: Math.max(lineSelection.start, lineSelection.end),
                        }
                        : undefined}
                      lineNumbersConfig={{
                        domEventHandlers: {
                          mousedown: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.button !== 0) return false;
                            event.preventDefault();
                            const lineNumber = view.state.doc.lineAt(line.from).number;

                            if (
                              lineSelection &&
                              !event.shiftKey &&
                              Math.min(lineSelection.start, lineSelection.end) === lineNumber &&
                              Math.max(lineSelection.start, lineSelection.end) === lineNumber
                            ) {
                              setLineSelection(null);
                              cancel();
                              isSelectingRef.current = false;
                              selectionStartRef.current = null;
                              setIsDragging(false);
                              return true;
                            }

                            if (isMobile && lineSelection && !event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineSelection.end, lineNumber);
                              const end = Math.max(lineSelection.start, lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                              isSelectingRef.current = false;
                              selectionStartRef.current = null;
                              setIsDragging(false);
                              return true;
                            }

                            isSelectingRef.current = true;
                            selectionStartRef.current = lineNumber;
                            setIsDragging(true);

                            if (lineSelection && event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineNumber);
                              const end = Math.max(lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                            } else {
                              setLineSelection({ start: lineNumber, end: lineNumber });
                            }

                            return true;
                          },
                          mouseover: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.buttons !== 1) return false;
                            if (!isSelectingRef.current || selectionStartRef.current === null) return false;
                            const lineNumber = view.state.doc.lineAt(line.from).number;
                            const start = Math.min(selectionStartRef.current, lineNumber);
                            const end = Math.max(selectionStartRef.current, lineNumber);
                            setLineSelection({ start, end });
                            setIsDragging(true);
                            return false;
                          },
                          mouseup: () => {
                            isSelectingRef.current = false;
                            selectionStartRef.current = null;
                            setIsDragging(false);
                            return false;
                          },
                        },
                    }}
                  />
                </div>
                ) : null}
              </div>
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
