import React from 'react';
import { useSidebarCatalog, type SidebarConversation as SessionSummary, type ConversationSessionAttentionState } from '../conversation/sidebarCatalog';
import { useThreadStore } from '@/stores/useThreadStore';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
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
import { openThreadFromNavigation, startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import {
  buildConversationSessionForest,
  groupConversationSessionForestByWorkspace,
  conversationSessionTitle,
  type ConversationSessionNode,
} from '../conversation/sessionPresentation';

interface ThreadSwitcherDropdownProps {
  align?: 'start' | 'center' | 'end';
  children: React.ReactElement;
}

const SwitcherNode: React.FC<{
  attentionBySession: Readonly<Record<string, ConversationSessionAttentionState>>;
  busySessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  depth: number;
  node: ConversationSessionNode;
  onSelect(session: SessionSummary): void;
  untitled: string;
}> = ({ attentionBySession, busySessionIds, currentSessionId, depth, node, onSelect, untitled }) => {
  const { session } = node;
  const timestamp = Date.parse(session.updatedAt);
  const attention = attentionBySession[session.id];
  const icon = busySessionIds.has(session.id)
    ? <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" />
    : attention?.kind === 'error'
      ? <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
      : attention
        ? <Icon name="notification-3" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
        : session.parentId ? null : <Icon name="chat-4" className="size-3.5 shrink-0 text-muted-foreground" />;
  return (
    <>
      <DropdownMenuItem
        onClick={() => onSelect(session)}
        className={cn('min-w-0 gap-2', currentSessionId === session.id && 'bg-interactive-active')}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {session.parentId && <AgentAvatar identity={session.id} avatar={session.avatar} size={20} />}{icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate typography-ui-label text-foreground">
            {conversationSessionTitle(session, untitled)}
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
          onSelect={onSelect}
          untitled={untitled}
        />
      ))}
    </>
  );
};

export const ThreadSwitcherDropdown: React.FC<ThreadSwitcherDropdownProps> = ({
  align = 'start',
  children,
}) => {
  const { t } = useI18n();
  const { activeSessions: sessions, attentionBySession } = useSidebarCatalog();
  const currentSessionId = useThreadStore(state => state.selectedIdentity?.threadId ?? null);
  const pinnedIds = React.useMemo(() => new Set(sessions.filter(session => session.pinned).map(session => session.id)), [sessions]);
  const projects = useProjectsStore((state) => state.projects);
  const untitled = t('sessions.sidebar.session.untitled');
  const groups = React.useMemo(() => groupConversationSessionForestByWorkspace(
    buildConversationSessionForest(
      sessions,
      (session) => pinnedIds.has(session.id),
    ),
    projects,
    (session) => pinnedIds.has(session.id),
  ).map((group) => ({
    ...group,
    label: group.project?.label?.trim()
      || (group.path ? formatDirectoryName(group.path, null) || group.path : null)
      || t('sessions.sidebar.grouping.recent'),
  })), [pinnedIds, projects, sessions, t]);
  const busySessionIds = React.useMemo(() => new Set(sessions.filter(session => session.busy).map(session => session.id)), [sessions]);

  const select = React.useCallback(async (session: SessionSummary) => {
    try {
      await openThreadFromNavigation({ directory: session.cwd, threadId: session.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const create = React.useCallback(async () => {
    try {
      await startThreadFromNavigation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

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
