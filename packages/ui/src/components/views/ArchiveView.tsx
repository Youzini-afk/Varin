import React from 'react';
import type { SessionSummary } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  buildPiSessionForest,
  groupPiSessionForestByWorkspace,
  piSessionTitle,
  type PiSessionNode,
} from '@/components/pi-session/sessionPresentation';
import { formatSessionDateLabel } from '@/lib/sessionDateLabels';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshBotSessionIndex, regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import {
  selectArchivedPiSessions,
  usePiSessionStore,
} from '@/stores/usePiSessionStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

type WorkspaceBucket = {
  id: string;
  label: string;
  path: string | null;
  sessions: SessionSummary[];
};

type DeleteConfirmation = {
  label: string;
  sessions: SessionSummary[];
};

// Archives can grow into the hundreds. Incremental rendering keeps the page
// responsive while still allowing every matching session to be revealed.
const PAGE_SIZE = 100;

const sessionTimestamp = (session: SessionSummary): number => {
  const parsed = Date.parse(session.archivedAt ?? session.updatedAt ?? session.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sessionDirectory = (session: SessionSummary): string => (
  normalizePath(session.cwd) ?? session.cwd
);

const flattenSessionNodes = (nodes: PiSessionNode[]): SessionSummary[] => nodes.flatMap((node) => [
  node.session,
  ...flattenSessionNodes(node.children),
]);

export function ArchiveView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isArchivePageOpen);
  const setOpen = useUIStore((state) => state.setArchivePageOpen);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const allArchivedSessions = usePiSessionStore(selectArchivedPiSessions);
  const projects = useProjectsStore((state) => state.projects);
  const loadCatalog = usePiSessionStore((state) => state.loadCatalog);
  const unarchiveSession = usePiSessionStore((state) => state.unarchiveSession);
  const deleteSession = usePiSessionStore((state) => state.deleteSession);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const botSessionIndex = useBotSessionIndex();
  const archivedSessions = React.useMemo(
    () => regularPiSessions(allArchivedSessions, botSessionIndex, runtimeKey),
    [allArchivedSessions, botSessionIndex, runtimeKey],
  );
  const prefetchSession = usePiSessionStore((state) => state.prefetchSession);
  const clearPinnedSession = useSessionPinnedStore((state) => state.clearPinnedSession);
  const [query, setQuery] = React.useState('');
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<string | null>(null);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);
  const [confirmation, setConfirmation] = React.useState<DeleteConfirmation | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const untitled = t('sessions.sidebar.session.untitled');

  React.useEffect(() => {
    if (open) {
      void loadCatalog();
      void refreshBotSessionIndex(runtimeKey, true);
    }
  }, [loadCatalog, open, runtimeKey]);

  const normalizedQuery = query.trim().toLocaleLowerCase();

  const sortedSessions = React.useMemo(() => {
    if (!open) return [];
    return [...archivedSessions].sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
  }, [archivedSessions, open]);

  const buckets = React.useMemo<WorkspaceBucket[]>(() => (
    groupPiSessionForestByWorkspace(buildPiSessionForest(sortedSessions), projects).map((group) => ({
      id: group.id,
      label: group.project?.label?.trim()
        || (group.path ? formatDirectoryName(group.path, homeDirectory) || group.path : null)
        || t('sessions.sidebar.grouping.recent'),
      path: group.path,
      sessions: flattenSessionNodes(group.forest)
        .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left)),
    }))
  ), [homeDirectory, projects, sortedSessions, t]);

  const filteredSessions = React.useMemo(() => {
    if (normalizedQuery) {
      return sortedSessions.filter((session) => [
        piSessionTitle(session, untitled),
        session.cwd,
        session.firstMessage,
        session.allMessagesText,
      ].join('\n').toLocaleLowerCase().includes(normalizedQuery));
    }
    if (selectedWorkspace === null) return sortedSessions;
    return buckets.find((bucket) => bucket.id === selectedWorkspace)?.sessions ?? [];
  }, [buckets, normalizedQuery, selectedWorkspace, sortedSessions, untitled]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const remainingCount = filteredSessions.length - visibleSessions.length;
  const totalCount = archivedSessions.length;

  const selectWorkspace = React.useCallback((workspaceId: string | null) => {
    setSelectedWorkspace(workspaceId);
    setVisibleCount(PAGE_SIZE);
  }, []);

  const handleOpenSession = React.useCallback(async (session: SessionSummary) => {
    try {
      await openPiSessionFromNavigation({ directory: session.cwd, sessionId: session.id });
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [setOpen]);

  const restoreSession = React.useCallback(async (session: SessionSummary) => {
    try {
      await unarchiveSession(session.id);
      toast.success(t('sessions.sidebar.session.unarchive.success'));
    } catch (error) {
      console.error('Failed to restore Pi session:', error);
      toast.error(t('sessions.sidebar.session.unarchive.error'));
    }
  }, [t, unarchiveSession]);

  const runDelete = React.useCallback(async () => {
    if (!confirmation) return;
    setDeletePending(true);
    try {
      const results = await Promise.allSettled(
        confirmation.sessions.map((session) => deleteSession(session.id)),
      );
      let failed = 0;
      results.forEach((result, index) => {
        const session = confirmation.sessions[index];
        if (!session || result.status === 'rejected' || result.value !== true) {
          failed += 1;
          return;
        }
        clearPinnedSession(runtimeKey, session.cwd, session.id);
      });
      if (failed > 0) {
        toast.error(t('sessions.sidebar.dialogs.deleteResult.tryAgain'));
      } else {
        toast.success(t('sessions.sidebar.session.delete.success'));
      }
      setConfirmation(null);
    } finally {
      setDeletePending(false);
    }
  }, [clearPinnedSession, confirmation, deleteSession, runtimeKey, t]);

  if (!open) return null;

  const renderDirectoryItem = (
    key: string,
    label: string,
    count: number,
    isSelected: boolean,
    onSelect: () => void,
    fullPath?: string,
    sessionsForDelete?: SessionSummary[],
  ) => (
    <div key={key} className="group/dir relative">
      <button
        type="button"
        onClick={onSelect}
        title={fullPath}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label transition-[padding] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          sessionsForDelete ? 'group-hover/dir:pr-8 group-focus-within/dir:pr-8' : '',
          isSelected
            ? 'bg-interactive-selection text-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 typography-micro text-muted-foreground/70">{count}</span>
      </button>
      {sessionsForDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setConfirmation({ label, sessions: sessionsForDelete })}
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/dir:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={t('sessions.archivePage.deleteProjectAria', { label })}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>{t('sessions.archivePage.deleteProject')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 flex-shrink-0 flex-col border-r border-border/50">
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {renderDirectoryItem(
              '__all__',
              t('sessions.archivePage.allWorkspaces'),
              totalCount,
              selectedWorkspace === null,
              () => selectWorkspace(null),
            )}
            {buckets.map((bucket) => renderDirectoryItem(
              bucket.id,
              bucket.label,
              bucket.sessions.length,
              selectedWorkspace === bucket.id,
              () => selectWorkspace(bucket.id),
              bucket.path || undefined,
              bucket.sessions,
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-6 pt-3">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
                placeholder={t('sessions.archivePage.searchPlaceholder')}
                className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              />
            </div>
            <span className="flex-shrink-0 typography-micro text-muted-foreground">
              {filteredSessions.length === 1
                ? t('sessions.archivePage.countSingle', { count: filteredSessions.length })
                : t('sessions.archivePage.countPlural', { count: filteredSessions.length })}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
            <div className="mx-auto w-full max-w-3xl space-y-0.5">
              {botSessionIndex.runtimeKey !== runtimeKey || botSessionIndex.loading || (botSessionIndex.ids === null && !botSessionIndex.error) ? (
                <p role="status" className="py-10 text-center typography-meta text-muted-foreground">{t('common.loading')}</p>
              ) : botSessionIndex.error ? (
                <button type="button" onClick={() => void refreshBotSessionIndex(runtimeKey, true)}
                  className="w-full py-10 text-center typography-meta text-destructive">
                  {t('sessions.sidebar.group.empty.loadFailed')}: {botSessionIndex.error}
                </button>
              ) : visibleSessions.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  <p className="typography-ui-label font-semibold">
                    {normalizedQuery ? t('sessions.archivePage.empty.noMatches') : t('sessions.archivePage.empty.noArchived')}
                  </p>
                </div>
              ) : visibleSessions.map((session) => {
                const directory = sessionDirectory(session);
                const directoryLabel = directory
                  ? (formatDirectoryName(directory, homeDirectory) || directory)
                  : null;
                const title = piSessionTitle(session, untitled);
                return (
                  <div
                    key={session.id}
                    className="group relative flex cursor-pointer items-center gap-3 rounded-md py-1 pl-2 pr-2 transition-[padding] hover:bg-interactive-hover/40 hover:pr-16 focus-within:pr-16"
                    onClick={() => void handleOpenSession(session)}
                    onFocus={() => { void prefetchSession(session.id, session.cwd).catch(() => undefined); }}
                    onPointerEnter={() => { void prefetchSession(session.id, session.cwd).catch(() => undefined); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void handleOpenSession(session);
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                      {title}
                    </span>
                    {normalizedQuery && directoryLabel ? (
                      <span className="max-w-40 flex-shrink-0 truncate text-[0.72rem] text-muted-foreground/70" title={directory}>
                        {directoryLabel}
                      </span>
                    ) : null}
                    <span className="flex-shrink-0 text-[0.72rem] text-muted-foreground/75">
                      {formatSessionDateLabel(sessionTimestamp(session))}
                    </span>
                    <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void restoreSession(session);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-label={t('sessions.sidebar.session.menu.restore')}
                        title={t('sessions.sidebar.session.menu.restore')}
                      >
                        <Icon name="inbox-unarchive" className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmation({ label: title, sessions: [session] });
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-label={t('sessions.archivePage.deleteSessionAria', { title })}
                      >
                        <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {remainingCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  className="mt-1 flex items-center justify-start rounded-md px-2 py-1 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {t('sessions.sidebar.group.showMore')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmation !== null} onOpenChange={(nextOpen) => { if (!nextOpen) setConfirmation(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>
              {confirmation && confirmation.sessions.length > 1
                ? t('sessions.sidebar.dialogs.deleteSessions.title')
                : t('sessions.sidebar.dialogs.deleteSession.title')}
            </DialogTitle>
            <DialogDescription>
              {confirmation && confirmation.sessions.length > 1
                ? t(
                    confirmation.sessions.length === 1
                      ? 'sessions.sidebar.dialogs.deleteSessions.singleDescription'
                      : 'sessions.sidebar.dialogs.deleteSessions.pluralDescription',
                    { count: confirmation.sessions.length },
                  )
                : t('sessions.sidebar.dialogs.deleteSession.single', {
                    sessionTitle: confirmation?.label ?? untitled,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmation(null)}
              disabled={deletePending}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 disabled:opacity-50"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void runDelete()}
              disabled={deletePending}
              className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deletePending && <Icon name="loader-4" className="size-3.5 animate-spin" />}
              {confirmation && confirmation.sessions.length > 1
                ? t('sessions.sidebar.dialogs.deleteSessions.titleAction')
                : t('sessions.sidebar.dialogs.deleteSession.titleAction')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
