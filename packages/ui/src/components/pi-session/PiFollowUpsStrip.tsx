import * as React from 'react';
import type { FollowUpDefinitionView } from '@varin/protocol';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { fetchFollowUps, postFollowUpAction } from '@/lib/followUpsApi';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { toast } from '@/components/ui/toast';

/**
 * Session waiting entries (W3, D-307): the durable follow-ups the agent
 * registered on this session — what it waits for and what runs next. Check is
 * a program-side source evaluation; fire invokes the agent; cancel only stops
 * the wait, never the watched work.
 */

const STATUS_TONE: Record<string, string> = {
  waiting: 'text-[var(--status-warning)]',
  triggered: 'text-[var(--status-warning)]',
  delivered: 'text-[var(--status-success)]',
  cancelled: 'text-muted-foreground',
  superseded: 'text-muted-foreground',
  unavailable: 'text-[var(--status-error)]',
};

export const PiFollowUpsStrip: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  return <SessionFollowUpsStrip key={JSON.stringify([runtimeKey, sessionId])} sessionId={sessionId} runtimeKey={runtimeKey} />;
};

const isActive = (entry: FollowUpDefinitionView) => entry.status === 'waiting' || entry.status === 'triggered';

const SessionFollowUpsStrip: React.FC<{ sessionId: string; runtimeKey: string }> = ({ sessionId, runtimeKey }) => {
  const { t } = useI18n();
  const [followUps, setFollowUps] = React.useState<FollowUpDefinitionView[] | null>(null);
  const [busyIds, setBusyIds] = React.useState<Record<string, true>>({});
  const [error, setError] = React.useState<string | null>(null);
  const mounted = React.useRef(false);
  const request = React.useRef<AbortController | null>(null);
  const current = React.useCallback(() => mounted.current && getRuntimeKey() === runtimeKey, [runtimeKey]);

  const refresh = React.useCallback(async () => {
    if (!current()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await fetchFollowUps({ sessionId, signal: controller.signal });
      if (!controller.signal.aborted && current()) {
        setFollowUps(result?.filter(isActive) ?? []);
        setError(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted && current()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [current, sessionId]);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type === 'stream-ready' || event.type === 'harness-experiment-changed' && event.fact === 'followup') {
        void refresh();
      }
    });
    return () => {
      mounted.current = false;
      request.current?.abort();
      unsubscribe();
    };
  }, [refresh]);

  const act = React.useCallback(async (entry: FollowUpDefinitionView, action: 'cancel' | 'check' | 'fire') => {
    if (!current() || busyIds[entry.id]) return;
    setBusyIds(ids => ({ ...ids, [entry.id]: true }));
    try {
      const updated = await postFollowUpAction(entry.sessionId, entry.id, action, entry.revision);
      if (current()) {
        request.current?.abort();
        setFollowUps(entries => entries?.map(item => item.id === entry.id ? updated : item).filter(isActive) ?? null);
      }
    } catch (cause) {
      if (current()) toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // A rejected action can mean the displayed registration already ended.
      // Re-read on both outcomes instead of leaving its stale cancel button.
      await refresh();
      if (current()) setBusyIds(ids => { const next = { ...ids }; delete next[entry.id]; return next; });
    }
  }, [busyIds, current, refresh]);

  if (!followUps?.length && !error) return null;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-4xl min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-muted/15 px-3 py-2">
      {error ? <div role="alert" className="flex items-center gap-2 typography-meta text-[var(--status-error)]">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => void refresh()}>{t('tasksHub.refresh')}</button>
      </div> : null}
      {followUps?.map((entry) => (
        <div key={entry.id} className="flex min-w-0 items-center gap-2">
          <Icon name="timer" className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate typography-meta text-foreground"
            title={`${entry.waitingSummary} → ${entry.instruction}`}
          >
            {entry.waitingSummary}
            <span className="text-muted-foreground"> → {entry.instruction}</span>
          </span>
          <span className={`shrink-0 typography-meta ${STATUS_TONE[entry.status] ?? 'text-muted-foreground'}`}>
            {t(`chat.followup.status.${entry.status}` as never)}
          </span>
          {(entry.status === 'waiting' || entry.status === 'triggered') && (
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={busyIds[entry.id]}
                onClick={() => void act(entry, 'check')}
                title={t('chat.followup.action.checkHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.check')}
              </button>
              <button
                type="button"
                disabled={busyIds[entry.id]}
                onClick={() => void act(entry, 'fire')}
                title={t('chat.followup.action.fireHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.fire')}
              </button>
              <button
                type="button"
                disabled={busyIds[entry.id]}
                onClick={() => void act(entry, 'cancel')}
                title={t('chat.followup.action.cancelHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.cancel')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
};
