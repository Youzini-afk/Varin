import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  VARIN_WORKBENCH_SLOTS,
  type VarinWorkbenchActivityItemsSlotProps,
  type VarinWorkbenchPrimarySidebarViewsSlotProps,
  type VarinWorkbenchSecondarySidebarViewsSlotProps,
  type VarinWorkbenchStatusItemsSlotProps,
} from '@varin/extension-contract';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { HelpDialog } from '@/components/ui/HelpDialog';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { WorkbenchProfileSwitcher } from '@/components/layout/WorkbenchProfileSwitcher';
import { WorkbenchServices } from '@/components/layout/WorkbenchServices';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { IdeSessionHeader } from './IdeSessionHeader';
import { IdeSidebar } from './IdeSidebar';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SidebarFilesTree } from '@/components/layout/SidebarFilesTree';
import { RegularChatView } from '@/components/views/RegularChatView';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { PiSessionSidebar } from '@/components/pi-session/PiSessionSidebar';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { MultiRunLauncher } from '@/components/multirun';
import { WorkspaceOverlays } from '@/components/workspace/WorkspaceOverlays';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { invokeDesktop, isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { workbenchExtensionDisplayName } from '@/lib/extensions/workbench-profile-label';
import {
  WorkbenchContributionSlot,
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';
import {
  refreshVarinExtensionCatalog,
  useVarinExtensionCatalog,
} from '@/lib/extensions/catalog-store';
import {
  useWorkbenchWorkspace,
  useWorkbenchWorkspaceId,
} from '@/lib/extensions/workbench-workspace';
import {
  DEFAULT_IDE_WORKBENCH_LAYOUT,
  flushPersistedIdeWorkbenchLayout,
  IDE_LAYOUT_NODE_IDS,
  patchIdeWorkbenchLayout,
  projectIdeWorkbenchLayout,
  retryIdeWorkbenchLayout,
  updateIdeLayoutNode,
  type IdeWorkbenchActivityId,
  type IdeWorkbenchLayoutProjection,
} from '@/lib/workbench/ide-layout';
import { useIdeWorkbenchLayout } from '@/lib/workbench/useIdeWorkbenchLayout';
import { showWorkbenchPanel } from '@/lib/workbench/editors/panels';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGitRepositorySelectionStore } from '@/stores/useGitRepositorySelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import type { FileSearchResult, WorkspaceContentSearchHit } from '@varin/application-client';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';
import { IdeRunPanel } from '@/components/workbench/IdeRunPanel';
import { EditorWorkbenchArea } from '@/components/workbench/EditorWorkbenchArea';
import { WorkbenchPanelArea } from '@/components/workbench/WorkbenchPanelArea';
import { IdeEditorStatus } from './IdeEditorStatus';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { resolveGitTopLevel } from '@/lib/gitApi';
import {
  subscribeIdeSearchRequests,
  type IdeSearchMode,
} from '@/lib/workbench/ide-search-events';
import { requestFileEditorNavigation } from '@/lib/monaco/editor-command-service';
import {
  gitRepositoryRootWithinWorkspace,
  resolveIdeGitResourceId,
} from '@/lib/workbench/ide-git';

const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((module) => ({ default: module.GitView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then((module) => ({ default: module.SettingsWindow })));
type IdeSearchDraft = { mode: IdeSearchMode; query: string };

type FileSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: FileSearchResult[] }
  | { status: 'failure'; message: string };

type ContentSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: WorkspaceContentSearchHit[] }
  | { status: 'failure'; message: string };

const IdeSearchResults: React.FC<{
  mode: IdeSearchMode;
  fileHits: FileSearchResult[];
  contentHits: WorkspaceContentSearchHit[];
  onOpenFile: (path: string) => void;
  onOpenContent: (hit: WorkspaceContentSearchHit) => void;
}> = ({ mode, fileHits, contentHits, onOpenFile, onOpenContent }) => {
  const parentRef = React.useRef<HTMLDivElement | null>(null);
  const count = mode === 'files' ? fileHits.length : contentHits.length;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => mode === 'files' ? 36 : 52,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className="h-full overflow-auto p-2">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const fileHit = mode === 'files' ? fileHits[row.index] : undefined;
          const contentHit = mode === 'content' ? contentHits[row.index] : undefined;
          return (
            <div
              key={fileHit?.path ?? (contentHit ? `${contentHit.resource.resourceId}:${contentHit.line}:${contentHit.column}` : row.key)}
              className="absolute left-0 top-0 w-full"
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              {fileHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-9 w-full justify-start truncate text-left" onClick={() => onOpenFile(fileHit.path)}>
                  {fileHit.path}
                </Button>
              ) : contentHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-[52px] w-full justify-start text-left" onClick={() => onOpenContent(contentHit)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{contentHit.resource.resourceId}:{contentHit.line}</span>
                    <span className="truncate text-muted-foreground">{contentHit.preview}</span>
                  </span>
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ACTIVITIES: ReadonlyArray<{ id: IdeWorkbenchActivityId; icon: IconName; labelKey: I18nKey; ariaKey: I18nKey }> = [
  { id: 'explorer', icon: 'folder-3', labelKey: 'workbench.ide.activity.explorer', ariaKey: 'workbench.ide.activity.explorerAria' },
  { id: 'search', icon: 'search', labelKey: 'workbench.ide.activity.search', ariaKey: 'workbench.ide.activity.searchAria' },
  { id: 'git', icon: 'git-branch', labelKey: 'workbench.ide.activity.git', ariaKey: 'workbench.ide.activity.gitAria' },
  { id: 'run', icon: 'play', labelKey: 'workbench.ide.activity.run', ariaKey: 'workbench.ide.activity.runAria' },
  { id: 'extensions', icon: 'plug', labelKey: 'workbench.ide.activity.extensions', ariaKey: 'workbench.ide.activity.extensionsAria' },
];

const IdeSearchPanel: React.FC<{
  directory: string | undefined;
  focusRequestId: number;
  mode: IdeSearchMode;
  query: string;
  onModeChange(mode: IdeSearchMode): void;
  onQueryChange(query: string): void;
}> = ({ directory, focusRequestId, mode, query, onModeChange, onQueryChange }) => {
  const { t } = useI18n();
  const files = useRuntimeAPIs().files;
  const workspaceSearch = useRuntimeAPIs().workspaceSearch;
  const workspaceId = useWorkbenchWorkspaceId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileState, setFileState] = React.useState<FileSearchViewState>({ status: 'idle' });
  const [contentState, setContentState] = React.useState<ContentSearchViewState>({ status: 'idle' });

  React.useEffect(() => {
    if (focusRequestId <= 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'files') return undefined;
    if (!directory || !normalized) {
      setFileState({ status: 'idle' });
      return undefined;
    }
    setFileState({ status: 'searching' });
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void files.search({ directory, query: normalized }, { signal: controller.signal })
        .then((hits) => {
          if (cancelled || controller.signal.aborted) return;
          setFileState(hits.length === 0 ? { status: 'empty' } : { status: 'ready', hits });
        })
        .catch((error) => {
          if (cancelled) return;
          setFileState({
            status: 'failure',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [directory, files, mode, query]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'content') return undefined;
    if (!directory || !workspaceId || !normalized) {
      setContentState({ status: 'idle' });
      return undefined;
    }
    setContentState({ status: 'searching' });
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void workspaceSearch.searchContent(
        { workspaceId, query: normalized },
        {
          signal: controller.signal,
          onBatch: (hits) => {
            if (cancelled || hits.length === 0) return;
            setContentState((current) => ({
              status: 'ready',
              hits: current.status === 'ready' ? [...current.hits, ...hits] : [...hits],
            }));
          },
        },
      ).then((result) => {
        if (cancelled) return;
        if (result.status === 'cancelled') return;
        if (result.status === 'failure') {
          setContentState({ status: 'failure', message: result.message });
          return;
        }
        if (result.status === 'empty') {
          setContentState({ status: 'empty' });
          return;
        }
        setContentState({ status: 'ready', hits: result.hits });
      }).catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setContentState({
          status: 'failure',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [directory, mode, query, workspaceId, workspaceSearch]);

  const openFileHit = (path: string) => {
    if (!directory || !workspaceId) return;
    const resourceId = resourceIdFromWorkspacePath(directory, path);
    if (resourceId) openWorkbenchEditor(workspaceId, resourceId);
  };

  const openContentHit = (hit: WorkspaceContentSearchHit) => {
    if (!directory || !workspaceId) return;
    const opened = openWorkbenchEditor(workspaceId, hit.resource.resourceId);
    requestFileEditorNavigation(
      hit.resource,
      hit.line,
      hit.column,
      activeEditorTab(opened)?.viewId,
    );
  };

  const activeState = mode === 'files' ? fileState : contentState;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 p-2">
        <div className="flex gap-1">
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'files'}
            onClick={() => onModeChange('files')}
          >
            {t('workbench.ide.search.filesTab')}
          </Button>
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'content'}
            onClick={() => onModeChange('content')}
          >
            {t('workbench.ide.search.contentTab')}
          </Button>
        </div>
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t(mode === 'files' ? 'workbench.ide.search.placeholder' : 'workbench.ide.search.contentPlaceholder')}
          aria-label={t(mode === 'files' ? 'workbench.ide.search.filesAria' : 'workbench.ide.search.contentAria')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden typography-ui">
        {!directory || (mode === 'content' && !workspaceId) ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.noWorkspace' : 'workbench.ide.search.contentNoWorkspace')}
          </p>
        ) : activeState.status === 'searching' ? (
          <p className="p-2 text-muted-foreground">{t('workbench.ide.search.searching')}</p>
        ) : activeState.status === 'failure' ? (
          <p className="p-2 text-[color:var(--status-error)]">
            {t(mode === 'files' ? 'workbench.ide.search.failed' : 'workbench.ide.search.contentFailed', { message: activeState.message })}
          </p>
        ) : activeState.status === 'empty' ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.empty' : 'workbench.ide.search.contentEmpty')}
          </p>
        ) : (fileState.status === 'ready' && mode === 'files') || (contentState.status === 'ready' && mode === 'content') ? (
          <IdeSearchResults
            mode={mode}
            fileHits={fileState.status === 'ready' ? fileState.hits : []}
            contentHits={contentState.status === 'ready' ? contentState.hits : []}
            onOpenFile={openFileHit}
            onOpenContent={openContentHit}
          />
        ) : null}
      </div>
    </div>
  );
};

const IdeExtensionsPanel: React.FC = () => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const extensions = catalog.snapshot?.catalog.extensions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setSettingsPage('extensions');
            setSettingsDialogOpen(true);
          }}
        >
          {t('workbench.ide.extensions.openSettings')}
        </Button>
      </div>
      {catalog.error ? (
        <div className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-2 py-1 text-status-warning">
          <Icon name="error-warning" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate typography-micro" title={catalog.error}>{catalog.error}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void refreshVarinExtensionCatalog().catch(() => undefined)}
          >
            {t('startup.initRecovery.retry')}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-2 typography-ui">
        {!catalog.snapshot ? (
          <p className="text-muted-foreground">
            {catalog.loading || !catalog.error ? t('common.loading') : t('common.unavailable')}
          </p>
        ) : extensions.length === 0 ? (
          <p className="text-muted-foreground">{t('workbench.ide.extensions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {extensions.map((entry) => (
              <li key={entry.manifest.id} className="truncate text-foreground">
                {workbenchExtensionDisplayName(entry, t)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** Ties the header's session button to the picker region it expands over the Agent column. */
const SESSION_PICKER_REGION_ID = 'varin-ide-session-picker';

export const IdeWorkbenchShell: React.FC<Record<string, unknown>> = () => {
  const { t } = useI18n();
  useUpdatePolling();
  const workspace = useWorkbenchWorkspace();
  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const directory = useEffectiveDirectory();
  const projectActionsContext = useProjectActionsContext();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const selectedGitDirectory = useGitRepositorySelectionStore((state) => (
    workspaceId ? state.repositoryByWorkspace[workspaceId] ?? null : null
  ));
  const setSelectedGitDirectory = useGitRepositorySelectionStore((state) => state.setRepository);
  const containedSelectedGitDirectory = React.useMemo(() => (
    directory && selectedGitDirectory
      ? gitRepositoryRootWithinWorkspace(directory, selectedGitDirectory)
      : null
  ), [directory, selectedGitDirectory]);
  const gitDirectory = containedSelectedGitDirectory || directory || null;
  const branchLabel = useGitBranchLabel(gitDirectory);
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setCommandPaletteOpen = useUIStore((state) => state.setCommandPaletteOpen);
  const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
  const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
  const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
  const [settingsWindowMounted, setSettingsWindowMounted] = React.useState(isSettingsDialogOpen);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = React.useState(false);
  const [searchDraftByDirectory, setSearchDraftByDirectory] = React.useState<Record<string, IdeSearchDraft>>({});
  const [searchFocusRequestId, setSearchFocusRequestId] = React.useState(0);
  const layoutState = useIdeWorkbenchLayout(workspaceId);
  const layoutDocument = layoutState?.document ?? DEFAULT_IDE_WORKBENCH_LAYOUT;
  const layout = React.useMemo(() => projectIdeWorkbenchLayout(layoutDocument), [layoutDocument]);
  // CSS leaves free space unused when the remaining grow factors sum to less than one.
  // Convert the persisted ratios to relative factors; toggling a pane then fills the row.
  const smallestWeight = Math.min(...layout.mainWeights.filter(weight => weight > 0));
  const growWeights = layout.mainWeights.map(weight => weight / smallestWeight);
  const [resizing, setResizing] = React.useState(false);
  const resizeCleanupRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => resizeCleanupRef.current?.(), []);
  const shellRootRef = React.useRef<HTMLDivElement>(null);
  const mainAreaRef = React.useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [contentWidth, setContentWidth] = React.useState<number | null>(null);
  const [readingFocus, setReadingFocus] = React.useState<'primary' | 'editor' | 'secondary' | null>(null);
  React.useLayoutEffect(() => {
    const area = mainAreaRef.current;
    if (!area) return;
    const update = () => setContentWidth(area.clientWidth || null);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  // Offer a local focus action when allocated content is narrow; never change the chosen layout.
  const visibleWeight = layout.mainWeights[1] + (layout.primaryVisible ? layout.mainWeights[0] : 0)
    + (layout.secondaryVisible ? layout.mainWeights[2] : 0);
  const usableWidth = contentWidth === null ? null : contentWidth - (layout.activityVisible ? 44 : 0);
  const compact = usableWidth !== null && visibleWeight > 0 && (
    usableWidth * layout.mainWeights[1] / visibleWeight < 480
    || (layout.secondaryVisible && usableWidth * layout.mainWeights[2] / visibleWeight < 320)
  );
  const selectedPane = readingFocus;
  const primaryDisplayed = selectedPane === null ? layout.primaryVisible : selectedPane === 'primary';
  const secondaryDisplayed = selectedPane === null ? layout.secondaryVisible : selectedPane === 'secondary';
  const editorDisplayed = selectedPane === null || selectedPane === 'editor';
  React.useEffect(() => {
    const showAgent = () => {
      if (!shellRootRef.current?.isConnected || shellRootRef.current.closest('[data-varin-workbench-shell-staging]')) return;
      setReadingFocus('secondary');
    };
    const showEditor = () => {
      if (!shellRootRef.current?.isConnected || shellRootRef.current.closest('[data-varin-workbench-shell-staging]')) return;
      setReadingFocus(current => current ? 'editor' : null);
    };
    window.addEventListener('varin:ide-focus-agent', showAgent);
    window.addEventListener('varin:ide-focus-editor', showEditor);
    return () => {
      window.removeEventListener('varin:ide-focus-agent', showAgent);
      window.removeEventListener('varin:ide-focus-editor', showEditor);
    };
  }, []);
  const editorWorkbench = useEditorWorkbench(workspaceId);
  const activeViewId = editorWorkbench ? activeEditorTab(editorWorkbench)?.viewId : undefined;
  const previousViewRef = React.useRef(activeViewId);
  React.useEffect(() => {
    if (previousViewRef.current && activeViewId && previousViewRef.current !== activeViewId) {
      setReadingFocus(current => current ? 'editor' : null);
    }
    previousViewRef.current = activeViewId;
  }, [activeViewId]);
  const searchDirectoryKey = directory || '__no-workspace__';
  const searchDraft = searchDraftByDirectory[searchDirectoryKey] ?? { mode: 'files', query: '' };

  const updateSearchDraft = React.useCallback((patch: Partial<IdeSearchDraft>) => {
    setSearchDraftByDirectory((current) => {
      const previous = current[searchDirectoryKey] ?? { mode: 'files', query: '' };
      const next = { ...previous, ...patch };
      if (next.mode === previous.mode && next.query === previous.query) return current;
      return { ...current, [searchDirectoryKey]: next };
    });
  }, [searchDirectoryKey]);

  React.useEffect(() => {
    if (isSettingsDialogOpen) setSettingsWindowMounted(true);
  }, [isSettingsDialogOpen]);

  React.useEffect(() => workspaceEvents.onDirectoryRequest(() => {
    setDirectoryDialogOpen(true);
  }), []);

  React.useEffect(() => {
    if (workspaceId && selectedGitDirectory && !containedSelectedGitDirectory) {
      setSelectedGitDirectory(workspaceId, null);
    }
  }, [containedSelectedGitDirectory, selectedGitDirectory, setSelectedGitDirectory, workspaceId]);

  const workspaceSelectionRef = React.useRef({ directory, workspaceId });
  workspaceSelectionRef.current = { directory, workspaceId };

  const handleGitDirectoryChange = React.useCallback(async (candidateDirectory: string) => {
    if (!directory || !workspaceId) throw new Error(t('common.unavailable'));
    const repositoryRoot = await resolveGitTopLevel(candidateDirectory);
    if (
      workspaceSelectionRef.current.directory !== directory
      || workspaceSelectionRef.current.workspaceId !== workspaceId
    ) throw new Error(t('common.unavailable'));
    const containedRoot = gitRepositoryRootWithinWorkspace(directory, repositoryRoot);
    if (!containedRoot) throw new Error(t('filesView.document.outsideWorkspace'));
    setSelectedGitDirectory(
      workspaceId,
      resourceIdFromWorkspacePath(directory, containedRoot) === '' ? null : containedRoot,
    );
  }, [directory, setSelectedGitDirectory, t, workspaceId]);

  const handleFollowWorkspaceGitDirectory = React.useCallback(() => {
    if (workspaceId) setSelectedGitDirectory(workspaceId, null);
  }, [setSelectedGitDirectory, workspaceId]);

  const patchLayout = React.useCallback((patch: Partial<Pick<
    IdeWorkbenchLayoutProjection,
    'activity' | 'primaryVisible' | 'secondaryVisible'
  >>) => {
    if (!workspaceId) return;
    patchIdeWorkbenchLayout(workspaceId, (document) => {
      let next = document;
      const primary = next.nodes[IDE_LAYOUT_NODE_IDS.primary];
      if (primary?.kind === 'stack' && (patch.activity !== undefined || patch.primaryVisible !== undefined)) {
        next = updateIdeLayoutNode(next, {
          ...primary,
          ...(patch.activity !== undefined ? { activeViewId: patch.activity } : {}),
          ...(patch.primaryVisible !== undefined ? { visible: patch.primaryVisible } : {}),
        });
      }
      const secondary = next.nodes[IDE_LAYOUT_NODE_IDS.secondary];
      if (secondary?.kind === 'stack' && patch.secondaryVisible !== undefined) {
        next = updateIdeLayoutNode(next, { ...secondary, visible: patch.secondaryVisible });
      }
      return next;
    });
  }, [workspaceId]);

  React.useEffect(() => subscribeIdeSearchRequests(({ mode }) => {
    const root = shellRootRef.current;
    if (!root?.isConnected || root.closest('[data-varin-workbench-shell-staging]')) return false;
    patchLayout({ activity: 'search', primaryVisible: true });
    if (readingFocus) setReadingFocus('primary');
    updateSearchDraft({ mode });
    setSearchFocusRequestId((current) => current + 1);
    return true;
  }), [patchLayout, updateSearchDraft, readingFocus]);

  // The picker covers the Agent column rather than floating over the workbench, so it only has
  // somewhere to render once that column is visible. Opening it reveals the column; hiding the
  // column takes the picker's host away, so drop the open flag with it instead of leaving a
  // picker that reappears the next time the Agent sidebar comes back.
  const toggleSessionPicker = React.useCallback(() => {
    if (sessionPickerOpen) {
      setSessionPickerOpen(false);
      return;
    }
    patchLayout({ secondaryVisible: true });
    setSessionPickerOpen(true);
  }, [patchLayout, sessionPickerOpen]);

  React.useEffect(() => {
    if (!layout.secondaryVisible) setSessionPickerOpen(false);
  }, [layout.secondaryVisible]);

  // Git diffs belong in the editor area. The Agent profile routes them through its tabbed context
  // panel, which the IDE shell does not mount, so the IDE opens a pinned diff provider tab instead.
  const openGitDiffInEditor = React.useCallback((gitPath: string, staged: boolean) => {
    if (!workspaceId || !directory || !gitDirectory) return;
    const resourceId = resolveIdeGitResourceId(directory, gitDirectory, gitPath);
    if (!resourceId) return;
    openWorkbenchEditor(workspaceId, resourceId, BUILTIN_EDITOR_PROVIDER_IDS.gitDiff, {
      viewState: {
        diffScope: staged ? 'staged' : 'working',
        diffRepositoryResourceId: resourceIdFromWorkspacePath(directory, gitDirectory) ?? '',
      },
    });
    if (readingFocus) setReadingFocus('editor');
  }, [directory, gitDirectory, workspaceId, readingFocus]);

  const startResize = React.useCallback((side: 'primary' | 'secondary') => (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    setResizing(true);
    const startX = event.clientX;
    const size = mainAreaRef.current?.clientWidth ?? 0;
    const startWeights = layout.mainWeights;
    const onMove = (moveEvent: MouseEvent) => {
      if (!workspaceId || size <= 0) return;
      const delta = (moveEvent.clientX - startX) / size * visibleWeight;
      patchIdeWorkbenchLayout(workspaceId, (document) => {
        const rootNode = document.nodes[IDE_LAYOUT_NODE_IDS.root];
        if (!rootNode || rootNode.kind !== 'split' || rootNode.weights.length !== 3) return document;
        const [primaryWeight, centerWeight, secondaryWeight] = startWeights;
        const boundedDelta = side === 'primary' ? Math.max(-primaryWeight, Math.min(centerWeight, delta))
          : Math.max(-centerWeight, Math.min(secondaryWeight, delta));
        const weights = side === 'primary'
          ? [primaryWeight + boundedDelta, centerWeight - boundedDelta, secondaryWeight]
          : [primaryWeight, centerWeight + boundedDelta, secondaryWeight - boundedDelta];
        if (weights.every((weight) => weight === 0)) return document;
        return updateIdeLayoutNode(document, { ...rootNode, weights });
      });
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizeCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setResizing(false);
      if (workspaceId) void flushPersistedIdeWorkbenchLayout(workspaceId);
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [layout.mainWeights, visibleWeight, workspaceId]);

  const workspaceLabel = directory
    ? formatDirectoryName(directory, homeDirectory)
    : t('workbench.ide.status.noWorkspace');
  const showPrimarySidebar = primaryDisplayed;
  const resizeWithKeyboard = (side: 'primary' | 'secondary') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (!workspaceId || !contentWidth) return;
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 12) / contentWidth * visibleWeight;
    patchIdeWorkbenchLayout(workspaceId, document => {
      const root = document.nodes[IDE_LAYOUT_NODE_IDS.root];
      if (!root || root.kind !== 'split') return document;
      const [left, center, right] = root.weights;
      const boundedDelta = side === 'primary' ? Math.max(-left, Math.min(center, delta))
        : Math.max(-center, Math.min(right, delta));
      return updateIdeLayoutNode(document, { ...root, weights: side === 'primary'
        ? [left + boundedDelta, center - boundedDelta, right]
        : [left, center + boundedDelta, right - boundedDelta] });
    });
  };

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  return (
    <DiffWorkerProvider>
      <div
        ref={shellRootRef}
        data-page-scroll-lock="true"
        data-workbench-chrome="ide"
        className="workbench-frame flex h-[100dvh] min-h-0 flex-col"
      >
        <CommandPalette fileOpenTarget="editor" />
        <PiInteractionHost />
        <HelpDialog />
        <WorkspaceOverlays />
        <WorkbenchContributionSlot kind="panel" slot="workbench.overlay" />
        <DirectoryExplorerDialog
          open={directoryDialogOpen}
          onOpenChange={setDirectoryDialogOpen}
        />

        <header
          className="workbench-titlebar app-region-drag flex h-11 shrink-0 items-center gap-2 px-2"
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.button !== 0) return;
            if (target.closest('.app-region-no-drag')) return;
            if (target.closest('button, a, input, select, textarea')) return;
            if (isDesktopShell()) void startDesktopWindowDrag();
          }}
        >
          {usesFramelessChrome && windowControlsSide === 'left' ? (
            <WindowsWindowControls visible position="left" />
          ) : null}
          {usesFramelessChrome ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="app-region-no-drag"
              aria-label={t('header.actions.openAppMenuAria')}
              onClick={handleOpenWindowsAppMenu}
            >
              <Icon name="menu-2" className="size-4" />
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="app-region-no-drag"
                aria-label={t(primaryDisplayed ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel')}
                aria-pressed={primaryDisplayed} onClick={() => {
                  if (readingFocus) setReadingFocus(primaryDisplayed ? 'editor' : 'primary');
                  else patchLayout({ primaryVisible: !layout.primaryVisible });
                }}>
                <Icon name="layout-left" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t(primaryDisplayed ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel')}</TooltipContent>
          </Tooltip>
          <WorkbenchProfileSwitcher />
          {projectActionsContext ? (
            <ProjectActionsButton
              projectRef={projectActionsContext.projectRef}
              directory={projectActionsContext.directory}
              menuTrigger={(
                <button type="button" className="app-region-no-drag flex min-w-0 items-center gap-1 rounded px-1.5 py-1 typography-ui-label text-foreground hover:bg-interactive-hover" aria-label={`${workspaceLabel}: ${t('projectActions.actions.chooseActionAria')}`}>
                  <span className="min-w-0 truncate">{workspaceLabel}</span>
                  <Icon name="arrow-down-s" className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              )}
            />
          ) : <div className="min-w-0 truncate typography-ui-label text-foreground">{workspaceLabel}</div>}
          <div className="ml-auto flex shrink-0 app-region-no-drag items-center gap-1">

            <OpenInAppButton directory={directory ?? ''} />
            <WorkbenchServices />

            <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={secondaryDisplayed ? t('workbench.ide.sidebar.hideSecondary') : t('workbench.ide.sidebar.showSecondary')}
                          aria-pressed={secondaryDisplayed}
                          onClick={() => {
                            if (readingFocus) setReadingFocus(secondaryDisplayed ? 'editor' : 'secondary');
                            else patchLayout({ secondaryVisible: !layout.secondaryVisible });
                          }}
                        >
                          <Icon name="layout-right" className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {secondaryDisplayed ? t('workbench.ide.sidebar.hideSecondary') : t('workbench.ide.sidebar.showSecondary')}
                      </TooltipContent>
                    </Tooltip>


            {usesFramelessChrome && windowControlsSide === 'right' ? (
              <WindowsWindowControls visible position="right" />
            ) : null}
          </div>
        </header>

        {layoutState?.errorMessage ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-1 typography-meta text-status-warning">
            <Icon name="error-warning" className="size-3.5" />
            <span className="min-w-0 truncate" title={layoutState.errorMessage}>{layoutState.errorMessage}</span>
            {workspaceId ? (
              <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => retryIdeWorkbenchLayout(workspaceId)}>
                {t('startup.initRecovery.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {workspace.status === 'error' ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-1 typography-meta text-status-warning">
            <Icon name="error-warning" className="size-3.5" />
            <span className="min-w-0 truncate" title={workspace.errorMessage}>{workspace.errorMessage}</span>
            <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={workspace.retry}>
              {t('startup.initRecovery.retry')}
            </Button>
          </div>
        ) : null}

        {compact || readingFocus ? <nav className="ide-region-navigation flex shrink-0 items-center gap-1 px-2 pb-1" aria-label={t('workbench.ide.title')}>
          {(['primary', 'editor', 'secondary'] as const).map(pane => <button key={pane} type="button"
            aria-pressed={selectedPane === pane} className={cn('workbench-icon-button flex items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground', selectedPane === pane && 'bg-interactive-selection text-foreground')}
            onClick={() => setReadingFocus(current => current === pane ? null : pane)}>
            <Icon name={pane === 'primary' ? 'folder' : pane === 'editor' ? 'file-code' : 'chat-1'} className="size-3.5" />
            {pane === 'primary' ? t('layout.rightSidebar.files') : pane === 'editor' ? t('workbench.ide.editorLabel') : 'Agent'}
          </button>)}
          <button type="button" className="workbench-icon-button ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={() => setReadingFocus(null)} disabled={!readingFocus}>
            <Icon name="layout-column" className="size-3.5" />{t(readingFocus ? 'workbench.ide.restoreLayout' : 'workbench.ide.columns')}
          </button>
        </nav> : null}
        <div ref={mainAreaRef} className="ide-workspace-row flex min-h-0 flex-1 overflow-hidden">
          {layout.activityVisible ? (
          <nav className="ide-activity flex w-11 shrink-0 flex-col items-center gap-1 py-2" aria-label={t('workbench.ide.title')}>
            <WorkbenchReplacement
              target={WORKBENCH_REPLACEMENT_TARGETS.activity}
              fallback={(
                <>
                  {ACTIVITIES.map((item) => (
                    <Tooltip key={item.id}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t(item.ariaKey)}
                          aria-pressed={layout.activity === item.id && primaryDisplayed}
                          className={cn(layout.activity === item.id && primaryDisplayed && 'bg-[var(--interactive-selection)]')}
                          onClick={() => {
                            if (selectedPane !== null) {
                              setReadingFocus(layout.activity === item.id && primaryDisplayed ? 'editor' : 'primary');
                              patchLayout({ activity: item.id });
                              return;
                            }
                            if (layout.activity === item.id) {
                              patchLayout({ primaryVisible: !layout.primaryVisible });
                              return;
                            }
                            patchLayout({ activity: item.id, primaryVisible: true });
                          }}
                        >
                          <Icon name={item.icon} className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
                    </Tooltip>
                  ))}
                  {workspaceId ? (
                    <WorkbenchContributionSlot
                      kind="view"
                      slot={VARIN_WORKBENCH_SLOTS.activityItems}
                      props={{ workspaceId } satisfies VarinWorkbenchActivityItemsSlotProps}
                    />
                  ) : null}
                  <div className="mt-auto flex flex-col gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('workbench.ide.commandPaletteAria')}
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  <Icon name="command" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workbench.ide.commandPalette')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('workbench.ide.settingsAria')}
                  onClick={() => setSettingsDialogOpen(true)}
                >
                  <Icon name="settings-3" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workbench.ide.settings')}</TooltipContent>
            </Tooltip>
                  </div>
                </>
              )}
            />
          </nav>
          ) : null}

          <AnimatePresence initial={false}>
          {showPrimarySidebar ? (
            <IdeSidebar key="primary" side="primary" weight={selectedPane ? 1 : growWeights[0]} resizing={resizing} onResize={startResize('primary')}
              onResizeKeyDown={resizeWithKeyboard('primary')} resizeLabel={t('sidebar.resize.leftPanelAria')} resizable={selectedPane === null}>
                <WorkbenchReplacement
                  target={WORKBENCH_REPLACEMENT_TARGETS.primarySidebar}
                  fallback={(
                    <>
                      {workspaceId ? (
                        <WorkbenchContributionSlot
                          kind="view"
                          slot={VARIN_WORKBENCH_SLOTS.primarySidebarViews}
                          props={{
                            workspaceId,
                            activeActivityId: layout.activity,
                          } satisfies VarinWorkbenchPrimarySidebarViewsSlotProps}
                        />
                      ) : null}
                      {layout.activity === 'explorer' ? <SidebarFilesTree openTarget="editor" onEditorOpen={() => setReadingFocus(current => current ? 'editor' : null)} /> : null}
                      {layout.activity === 'search' ? (
                        <IdeSearchPanel
                          key={searchDirectoryKey}
                          directory={directory}
                          focusRequestId={searchFocusRequestId}
                          mode={searchDraft.mode}
                          query={searchDraft.query}
                          onModeChange={(mode) => updateSearchDraft({ mode })}
                          onQueryChange={(query) => updateSearchDraft({ query })}
                        />
                      ) : null}
                      {layout.activity === 'git' ? (
                        <React.Suspense fallback={null}>
                          <GitView
                            isActive
                            directoryOverride={gitDirectory}
                            showDirectorySelector
                            sessionDirectory={directory}
                            isFollowingSessionDirectory={!containedSelectedGitDirectory}
                            followDirectoryLabel={t('workspace.git.workspace')}
                            onDirectoryChange={handleGitDirectoryChange}
                            onFollowSessionDirectory={handleFollowWorkspaceGitDirectory}
                            onViewDiff={openGitDiffInEditor}
                          />
                        </React.Suspense>
                      ) : null}
                      {layout.activity === 'run' ? <IdeRunPanel /> : null}
                      {layout.activity === 'extensions' ? <IdeExtensionsPanel /> : null}
                    </>
                  )}
                />
            </IdeSidebar>
          ) : null}
          </AnimatePresence>

          <motion.div
            className="ide-editor-canvas relative flex min-h-0 min-w-0 flex-col overflow-hidden"
            initial={false} animate={{ flexGrow: editorDisplayed ? (selectedPane ? 1 : growWeights[1]) : 0, opacity: editorDisplayed ? 1 : 0 }}
            transition={{ duration: resizing || reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ flexBasis: 0, flexShrink: 1 }} inert={!editorDisplayed} aria-hidden={!editorDisplayed}
          >
            <main className="relative min-h-0 flex-1 overflow-hidden">
              <WorkbenchReplacement
                target={WORKBENCH_REPLACEMENT_TARGETS.editor}
                fallback={workspace.status === 'ready' ? (
                  <EditorWorkbenchArea showPanel={false} />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-center typography-ui text-muted-foreground">
                    {workspace.status === 'loading'
                      ? t('common.loading')
                      : workspace.status === 'error'
                        ? t('common.unavailable')
                        : t('workbench.ide.status.noWorkspace')}
                  </div>
                )}
              />
              {isMultiRunLauncherOpen ? (
                <div className="absolute inset-0 z-10 bg-background">
                  <ErrorBoundary>
                    <MultiRunLauncher
                      isWindowed
                      initialPrompt={multiRunLauncherPrefillPrompt}
                      onCreated={() => setMultiRunLauncherOpen(false)}
                      onCancel={() => setMultiRunLauncherOpen(false)}
                    />
                  </ErrorBoundary>
                </div>
              ) : null}
              <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
              <ErrorBoundary><ArchiveView /></ErrorBoundary>
              <ErrorBoundary><WorktreesView /></ErrorBoundary>
            </main>
            {workspace.status === 'ready' && workspaceId && directory ? (
              <WorkbenchPanelArea workspaceId={workspaceId} directory={directory} replaceable />
            ) : null}
          </motion.div>

          <AnimatePresence initial={false}>
          {secondaryDisplayed ? (
            <IdeSidebar key="secondary" side="secondary" weight={selectedPane ? 1 : growWeights[2]} resizing={resizing} onResize={startResize('secondary')}
              onResizeKeyDown={resizeWithKeyboard('secondary')} resizeLabel={t('sidebar.resize.rightPanelAria')} resizable={selectedPane === null}>
                <IdeSessionHeader>
                  <button type="button" className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    aria-label={t(readingFocus === 'secondary' ? 'workbench.ide.restoreLayout' : 'workbench.ide.focusAgent')}
                    title={t(readingFocus === 'secondary' ? 'workbench.ide.restoreLayout' : 'workbench.ide.focusAgent')}
                    onClick={() => setReadingFocus(current => current === 'secondary' ? null : 'secondary')}>
                    <Icon name={readingFocus === 'secondary' ? 'fullscreen-exit' : 'fullscreen'} className="size-3.5" />
                  </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('workbench.ide.sessionsAria')}
                  aria-expanded={sessionPickerOpen}
                  aria-controls={SESSION_PICKER_REGION_ID}
                  onClick={toggleSessionPicker}
                >
                  <Icon name="list-unordered" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workbench.ide.sessions')}</TooltipContent>
            </Tooltip>
                </IdeSessionHeader>
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <WorkbenchReplacement
                    target={WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar}
                    fallback={(
                      <>
                        {workspaceId ? (
                          <WorkbenchContributionSlot
                            kind="view"
                            slot={VARIN_WORKBENCH_SLOTS.secondarySidebarViews}
                            props={{ workspaceId } satisfies VarinWorkbenchSecondarySidebarViewsSlotProps}
                          />
                        ) : null}
                        <div className="h-full min-h-0">
                          <ErrorBoundary>
                            <RegularChatView active />
                          </ErrorBoundary>
                        </div>
                      </>
                    )}
                  />
                  {sessionPickerOpen ? (
                    <div
                      id={SESSION_PICKER_REGION_ID}
                      role="region"
                      aria-label={t('workbench.ide.sessions')}
                      className="absolute inset-0 z-10 flex flex-col bg-sidebar"
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return;
                        event.stopPropagation();
                        setSessionPickerOpen(false);
                      }}
                    >
                      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
                        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                          {t('workbench.ide.sessions')}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={t('header.actions.closeSessionsAria')}
                          onClick={() => setSessionPickerOpen(false)}
                        >
                          <Icon name="close" className="size-4" />
                        </Button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <ErrorBoundary>
                          <WorkbenchReplacement
                            target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator}
                            fallback={<PiSessionSidebar onRequestClose={() => setSessionPickerOpen(false)} />}
                          />
                        </ErrorBoundary>
                      </div>
                    </div>
                  ) : null}
                </div>
            </IdeSidebar>
          ) : null}
          </AnimatePresence>
        </div>

        {layout.statusVisible ? (
        <footer className="ide-statusbar flex h-7 shrink-0 items-center gap-3 px-3 typography-micro text-muted-foreground">
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.status}
            fallback={(
              <>
                <span className="truncate">{workspaceLabel}</span>
                <span className="truncate">{branchLabel || t('workbench.ide.status.noBranch')}</span>
                <IdeEditorStatus workspaceId={workspaceId} />
                {workspaceId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    onClick={() => showWorkbenchPanel(workspaceId, 'terminal')}
                  >
                    {t('workbench.panel.terminal')}
                  </Button>
                ) : null}
                {workspaceId ? (
                  <WorkbenchContributionSlot
                    kind="view"
                    slot={VARIN_WORKBENCH_SLOTS.statusItems}
                    props={{ workspaceId } satisfies VarinWorkbenchStatusItemsSlotProps}
                  />
                ) : null}
              </>
            )}
          />
        </footer>
        ) : null}

        {settingsWindowMounted ? (
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.settings}
            fallback={(
              <React.Suspense fallback={null}>
                <SettingsWindow
                  open={isSettingsDialogOpen}
                  onOpenChange={setSettingsDialogOpen}
                />
              </React.Suspense>
            )}
          />
        ) : null}
      </div>
    </DiffWorkerProvider>
  );
};
