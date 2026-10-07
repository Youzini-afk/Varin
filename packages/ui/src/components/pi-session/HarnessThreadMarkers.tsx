import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import {
  harnessThreadsAtEntry,
  projectHarnessThreadState,
  type HarnessThreadState,
} from './harnessThreadPresentation';

const stateKey: Record<HarnessThreadState, `harness.threads.state.${HarnessThreadState}`> = {
  queued: 'harness.threads.state.queued',
  starting: 'harness.threads.state.starting',
  running: 'harness.threads.state.running',
  idle: 'harness.threads.state.idle',
  waiting: 'harness.threads.state.waiting',
  stalled: 'harness.threads.state.stalled',
  looping: 'harness.threads.state.looping',
  completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed',
  cancelled: 'harness.threads.state.cancelled',
  interrupted: 'harness.threads.state.interrupted',
  dirty: 'harness.threads.state.dirty',
  'merge-ready': 'harness.threads.state.merge-ready',
  conflict: 'harness.threads.state.conflict',
  merged: 'harness.threads.state.merged',
  archived: 'harness.threads.state.archived',
};

export const HarnessThreadMarkers: React.FC<{
  cwd: string;
  entryId: string;
}> = ({ cwd, entryId }) => {
  const { t } = useI18n();
  const threads = harnessThreadsAtEntry(useHarnessThreadState().threads, entryId);
  const openSession = usePiSessionStore((state) => state.openSession);
  if (threads.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-harness-thread-markers={entryId}>
      {threads.map((entry) => {
        const state = projectHarnessThreadState(entry);
        const sessionId = entry.activeRun?.sessionId;
        const label = entry.thread.preset ?? (
          entry.thread.kind === 'discussion'
            ? t('harness.threads.discussion')
            : t('harness.threads.userThread')
        );
        return (
          <button
            key={entry.thread.id}
            type="button"
            disabled={!sessionId}
            aria-label={`${t('harness.threads.open')}: ${label}`}
            onClick={() => {
              if (!sessionId) return;
              void openSession({
                cwd: entry.thread.worktree?.path ?? cwd,
                sessionId,
                ...(entry.thread.model ? { model: entry.thread.model } : {}),
                ...(entry.thread.manifest.scope.length > 0 ? { scope: entry.thread.manifest.scope } : {}),
                tools: entry.thread.manifest.tools,
              }).catch((error) => {
                toast.error(error instanceof Error ? error.message : String(error));
              });
            }}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/50 bg-[var(--surface-subtle)]/65 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-border hover:bg-interactive-hover hover:text-foreground disabled:opacity-60"
          >
            <Icon
              name={state === 'running' || state === 'starting'
                ? 'loader-4'
                : entry.thread.kind === 'discussion' ? 'chat-1' : 'git-branch'}
              className={cn('size-3 shrink-0', (state === 'running' || state === 'starting') && 'animate-spin')}
            />
            <span className="max-w-40 truncate">{label}</span>
            <span className="text-muted-foreground/75">· {t(stateKey[state])}</span>
          </button>
        );
      })}
    </div>
  );
};
