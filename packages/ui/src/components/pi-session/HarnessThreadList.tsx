import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useWorkOverviewStore, workOverviewStateKey } from '@/stores/useWorkOverviewStore';
import {
  harnessThreadTitle, isEndedHarnessThread, projectHarnessThreadState,
  type HarnessThreadSnapshot,
} from './harnessThreadPresentation';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { collectThreadPeers, threadPeerLabel } from './threadMessages';

export function HarnessThreadStatus({ entry }: { entry: HarnessThreadSnapshot }) {
  const { t } = useI18n();
  const state = projectHarnessThreadState(entry);
  return <span className={cn('shrink-0 typography-meta',
    state === 'running' || state === 'starting' ? 'text-[var(--status-info)]'
      : state === 'failed' || state === 'interrupted' ? 'text-[var(--status-error)]'
        : !isEndedHarnessThread(entry) ? 'text-[var(--status-warning)]' : 'text-muted-foreground',
  )}>{t(`harness.threads.state.${state}`)}</span>;
}

export function HarnessThreadList({ entries, parentSessionId, onSelect }: {
  entries: readonly HarnessThreadSnapshot[];
  parentSessionId: string;
  onSelect(entry: HarnessThreadSnapshot): void;
}) {
  const { t } = useI18n();
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const key = workOverviewStateKey(runtimeKey, parentSessionId);
  const endedOpen = useWorkOverviewStore((state) => state.bySession[key]?.endedThreads ?? true);
  const setDisclosure = useWorkOverviewStore((state) => state.setDisclosure);
  const context = useHarnessThreadState();
  const peers = collectThreadPeers(context.peers, context.rootThreads, context.threads, context.branches);
  const active = entries.filter((entry) => !isEndedHarnessThread(entry));
  const ended = entries.filter(isEndedHarnessThread);
  const row = (entry: HarnessThreadSnapshot, compact: boolean) => {
    const state = projectHarnessThreadState(entry);
    const running = state === 'running' || state === 'starting';
    const waitingReply = entry.thread.dependencyWaits?.find(wait => wait.state === 'watching' && wait.replyTo);
    const request = waitingReply ? entry.thread.messages?.find(message => message.id === waitingReply.replyTo && message.direction === 'out') : undefined;
    const pending = entry.thread.messages?.filter(message => message.direction === 'in' && message.kind === 'request'
      && ['pending', 'held', 'delivered'].includes(message.status)).length ?? 0;
    const latest = entry.thread.messages?.at(-1);
    const messageError = entry.thread.dependencyWaits?.find(wait => wait.error)?.error
      || (latest?.status === 'failed' ? latest.failure : undefined);
    const detail = messageError || (request ? t('harness.messages.waitingOn', { peer: threadPeerLabel(request.to, peers,
      { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') }) })
      : pending ? t('harness.messages.pending', { count: pending }) : entry.thread.waitingFor?.text || entry.activeRun?.exitReason
      || (running && entry.activeRun?.lastToolCall
        ? t('harness.threads.usingTool', { tool: entry.activeRun.lastToolCall.name })
        : entry.thread.report?.conclusion));
    return <button key={entry.thread.id} type="button" onClick={() => onSelect(entry)}
      title={entry.thread.brief}
      aria-label={`${t('harness.threads.viewConversation')}: ${harnessThreadTitle(entry)}`}
      className="group w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline focus-visible:outline-primary">
      <div className="flex items-center gap-2">
        <Icon name={running ? 'loader-4' : 'chat-1'} className={cn('size-3.5 shrink-0 text-muted-foreground', running && 'animate-spin text-[var(--status-info)]')} />
        <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{harnessThreadTitle(entry)}</span>
        <HarnessThreadStatus entry={entry} />
      </div>
      {(!compact || messageError) && detail ? <p className={cn('mt-1 pl-5.5 line-clamp-2 typography-meta leading-5', messageError ? 'text-destructive' : 'text-muted-foreground')}>{detail}</p> : null}
    </button>;
  };
  return <div className="space-y-1">
    {entries.length === 0 ? <p className="p-3 typography-meta text-muted-foreground">{t('harness.threads.empty')}</p> : null}
    {active.map((entry) => row(entry, false))}
    {ended.length > 0 ? <details key={key} open={endedOpen}
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open !== endedOpen) {
          setDisclosure(key, 'endedThreads', event.currentTarget.open);
        }
      }} className="group/ended">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 typography-meta text-muted-foreground [&::-webkit-details-marker]:hidden">
        <Icon name="arrow-right-s" className="size-3.5 transition-transform group-open/ended:rotate-90" />
        {t('harness.threads.ended', { count: ended.length })}
      </summary>
      {ended.map((entry) => row(entry, true))}
    </details> : null}
  </div>;
}
