import * as React from 'react';
import type { FollowUpDefinitionView } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fetchFollowUps, postFollowUpAction } from '@/lib/followUpsApi';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { piSessionTitle } from '@/components/pi-session/sessionPresentation';
import { FollowUpEditorDialog } from './FollowUpEditorDialog';
import { TaskListRow, TaskSearch } from './TaskListPrimitives';

const isActive = (entry: FollowUpDefinitionView) => entry.status === 'waiting' || entry.status === 'triggered';

interface Props { createOpen?: boolean; onCreateOpenChange?(open: boolean): void }

export function FollowUpTasksPanel(props: Props) {
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  return <FollowUpTasksList key={runtimeKey} {...props} />;
}

function FollowUpTasksList({ createOpen = false, onCreateOpenChange }: Props) {
  const { t, locale } = useI18n();
  const sessions = usePiSessionStore((state) => state.summaries);
  const [entries, setEntries] = React.useState<FollowUpDefinitionView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'active' | 'history'>('all');
  const [editing, setEditing] = React.useState<FollowUpDefinitionView | null>(null);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const request = React.useRef<AbortController | null>(null);
  const mounted = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (!mounted.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await fetchFollowUps({ includeInactive: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      setEntries(result ?? []);
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type === 'stream-ready' || event.type === 'harness-experiment-changed' && event.fact === 'followup') void refresh();
    });
    return () => {
      mounted.current = false;
      request.current?.abort();
      unsubscribe();
    };
  }, [refresh]);

  const act = async (entry: FollowUpDefinitionView, action: 'cancel' | 'check' | 'fire') => {
    setBusy(entry.id);
    try {
      await postFollowUpAction(entry.sessionId, entry.id, action, entry.revision);
      await refresh();
    } catch (cause) {
      if (mounted.current) toast.error(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const needle = query.trim().toLocaleLowerCase();
  const visible = entries?.filter((entry) => {
    if (filter === 'active' && !isActive(entry) || filter === 'history' && isActive(entry)) return false;
    const session = sessionById.get(entry.sessionId);
    return !needle || `${entry.waitingSummary} ${entry.instruction} ${session ? piSessionTitle(session, entry.sessionId) : entry.sessionId}`.toLocaleLowerCase().includes(needle);
  }) ?? [];

  return (
    <section className="space-y-5">
      <TaskSearch value={query} onChange={setQuery} label={t('tasksHub.search')} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={t('tasksHub.followUps')}>
          {(['all', 'active', 'history'] as const).map((value) => <Button key={value} variant={filter === value ? 'secondary' : 'ghost'} size="sm" className="h-7 rounded-full px-2.5 typography-meta" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`tasksHub.${value}`)}</Button>)}
        </div>
        <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => void refresh()} aria-label={t('tasksHub.refresh')}><Icon name="refresh" className="size-3.5" /></Button>
      </div>
      {error ? <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-border p-3 typography-meta text-[var(--status-error)]"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void refresh()}>{t('tasksHub.refresh')}</Button></div> : null}
      {!entries && !error ? <div className="flex items-center gap-2 typography-meta text-muted-foreground"><Icon name="loader-4" className="size-4 animate-spin" />{t('sessions.scheduledTasks.dialog.loading')}</div> : null}
      {entries && visible.length === 0 && !error ? <div className="py-12 text-center typography-meta text-muted-foreground">{t(needle ? 'tasksHub.noMatches' : filter === 'history' ? 'tasksHub.emptyHistory' : 'tasksHub.empty')}</div> : null}
      <div className="space-y-1">
        {visible.map((entry) => {
          const session = sessionById.get(entry.sessionId);
          const sessionLabel = session ? piSessionTitle(session, entry.sessionId) : entry.sessionId;
          const source = entry.source;
          const condition = source.kind === 'time' ? new Date(source.at).toLocaleString(locale)
            : source.kind === 'file' ? `${t(`followupEditor.file.${source.condition}`)} · ${source.path}`
            : source.kind === 'external' ? `${t(`followupEditor.pr.${source.condition}`)}${source.branch ? ` · ${source.branch}` : ''}`
            : source.kind === 'manual' ? source.note || t('followupEditor.kind.manual')
            : source.kind === 'experiment' ? t('followupEditor.kind.experiment') : entry.waitingSummary;
          return (
            <TaskListRow key={`${entry.workspaceId}:${entry.id}`} title={entry.instruction.split(/\r?\n/)[0] || entry.instruction} subtitle={`${condition} · ${sessionLabel}`} icon="timer" muted={!isActive(entry)} status={<span className={cn(entry.status === 'unavailable' && 'text-[var(--status-error)]')}>{t(`chat.followup.status.${entry.status}`)}</span>}>
              <p className="whitespace-pre-wrap break-words text-foreground">{entry.instruction}</p>
              <p className="break-words text-muted-foreground">{condition}</p>
                    <button type="button" className="max-w-full truncate text-left typography-meta text-muted-foreground hover:text-foreground" title={t('tasksHub.openSession')} onClick={() => {
                      void openPiSessionFromNavigation({ sessionId: entry.sessionId, directory: session?.cwd })
                        .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)));
                    }}>{sessionLabel}</button>
              {entry.lastOccurrence ? <time className="block typography-micro text-muted-foreground" dateTime={new Date(entry.lastOccurrence.at).toISOString()}>{t('tasksHub.lastTriggered')}: {new Date(entry.lastOccurrence.at).toLocaleString()}</time> : null}
              {isActive(entry) ? <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" disabled={busy === entry.id} onClick={() => setEditing(entry)}>{t('sessions.scheduledTasks.dialog.actions.edit')}</Button>
                {(['check', 'fire', 'cancel'] as const).map((action) => <Button key={action} variant={action === 'fire' ? 'secondary' : 'ghost'} size="sm" disabled={busy !== null} title={t(`chat.followup.action.${action}Hint`)} onClick={() => void act(entry, action)}>{busy === entry.id ? <Icon name="loader-4" className="mr-1 size-3.5 animate-spin" /> : null}{t(`chat.followup.action.${action}`)}</Button>)}
              </div> : null}
            </TaskListRow>
          );
        })}
      </div>
      <FollowUpEditorDialog open={createOpen || editing !== null} entry={createOpen ? null : editing} onOpenChange={(open) => { if (!open) { onCreateOpenChange?.(false); setEditing(null); } }} onSaved={() => { void refresh(); }} />
    </section>
  );
}
