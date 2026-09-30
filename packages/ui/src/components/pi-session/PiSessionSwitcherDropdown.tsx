import React from 'react';
import type { SessionSummary } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  openPiSessionFromNavigation,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { cn, formatDirectoryName } from '@/lib/utils';
import {
  selectActivePiSessions,
  type PiSessionAttentionState,
  usePiSessionStore,
} from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { useSessionPinnedStore, isSessionPinned } from '@/stores/useSessionPinnedStore';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import {
  buildPiSessionForest,
  groupPiSessionForestByWorkspace,
  piSessionTitle,
  type PiSessionNode,
} from './sessionPresentation';

interface PiSessionSwitcherDropdownProps {
  align?: 'start' | 'center' | 'end';
  children: React.ReactElement;
}

const SwitcherNode: React.FC<{
  attentionBySession: Readonly<Record<string, PiSessionAttentionState>>;
  busySessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  depth: number;
  node: PiSessionNode;
  onPrefetch(session: SessionSummary): void;
  onSelect(session: SessionSummary): void;
  untitled: string;
}> = ({ attentionBySession, busySessionIds, currentSessionId, depth, node, onPrefetch, onSelect, untitled }) => {
  const { session } = node;
  const timestamp = Date.parse(session.updatedAt);
  const attention = attentionBySession[session.id];
  const icon = busySessionIds.has(session.id)
    ? <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" />
    : attention?.kind === 'error'
      ? <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
      : attention
        ? <Icon name="notification-3" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
        : <Icon name={depth > 0 ? 'ai-agent' : 'chat-4'} className="size-3.5 shrink-0 text-muted-foreground" />;
  return (
    <>
      <DropdownMenuItem
        onClick={() => onSelect(session)}
        onFocus={() => onPrefetch(session)}
        onPointerEnter={() => onPrefetch(session)}
        className={cn('min-w-0 gap-2', currentSessionId === session.id && 'bg-interactive-active')}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate typography-ui-label text-foreground">
            {piSessionTitle(session, untitled)}
          </span>
          <span className="block truncate typography-micro text-muted-foreground">{session.cwd}</span>
        </span>
        <span className="shrink-0 typography-micro text-muted-foreground">
          {formatSessionCompactDateLabel(Number.isFinite(timestamp) ? timestamp : Date.now())}
        </span>
      </DropdownMenuItem>
      {node.children.map((child) => (
        <SwitcherNode
          key={child.session.id}
          attentionBySession={attentionBySession}
          busySessionIds={busySessionIds}
          currentSessionId={currentSessionId}
          depth={depth + 1}
          node={child}
          onPrefetch={onPrefetch}
          onSelect={onSelect}
          untitled={untitled}
        />
      ))}
    </>
  );
};

export const PiSessionSwitcherDropdown: React.FC<PiSessionSwitcherDropdownProps> = ({
  align = 'start',
  children,
}) => {
  const { t } = useI18n();
  const allSessions = usePiSessionStore(selectActivePiSessions);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const botSessionIndex = useBotSessionIndex();
  const sessions = React.useMemo(
    () => regularPiSessions(allSessions, botSessionIndex, runtimeKey),
    [allSessions, botSessionIndex, runtimeKey],
  );
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const attentionBySession = usePiSessionStore((state) => state.attentionBySession);
  const records = usePiSessionStore((state) => state.records);
  const prefetchSession = usePiSessionStore((state) => state.prefetchSession);
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const projects = useProjectsStore((state) => state.projects);
  const untitled = t('sessions.sidebar.session.untitled');
  const groups = React.useMemo(() => groupPiSessionForestByWorkspace(
    buildPiSessionForest(
      sessions,
      (session) => isSessionPinned(pinnedIds, session.cwd, session.id),
    ),
    projects,
    (session) => isSessionPinned(pinnedIds, session.cwd, session.id),
  ).map((group) => ({
    ...group,
    label: group.project?.label?.trim()
      || (group.path ? formatDirectoryName(group.path, null) || group.path : null)
      || t('sessions.sidebar.grouping.recent'),
  })), [pinnedIds, projects, sessions, t]);
  const busySessionIds = React.useMemo(() => new Set(
    Object.values(records)
      .filter((record) => record.snapshot?.busy)
      .map((record) => record.sessionId),
  ), [records]);

  const select = React.useCallback(async (session: SessionSummary) => {
    try {
      await openPiSessionFromNavigation({ directory: session.cwd, sessionId: session.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const create = React.useCallback(async () => {
    try {
      await startPiSessionDraftFromNavigation({ projectId: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const prefetch = React.useCallback((session: SessionSummary) => {
    void prefetchSession(session.id, session.cwd).catch(() => undefined);
  }, [prefetchSession]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[min(70vh,42rem)] w-[min(22rem,calc(100vw-1rem))] min-w-0 overflow-y-auto">
        <DropdownMenuItem onClick={() => void create()}>
          <Icon name="chat-new" className="mr-2 size-4" />
          {t('sessions.sidebar.header.actions.newSession')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {groups.length === 0 ? (
          <DropdownMenuItem disabled>{t('sessions.sidebar.empty.noSessions.title')}</DropdownMenuItem>
        ) : groups.map((group, groupIndex) => (
          <React.Fragment key={group.id}>
            {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="truncate typography-micro text-muted-foreground">
              {group.label}
            </DropdownMenuLabel>
            {group.forest.map((node) => (
              <SwitcherNode
                key={node.session.id}
                attentionBySession={attentionBySession}
                busySessionIds={busySessionIds}
                currentSessionId={currentSessionId}
                depth={0}
                node={node}
                onPrefetch={prefetch}
                onSelect={(session) => void select(session)}
                untitled={untitled}
              />
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
