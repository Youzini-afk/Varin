import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { HarnessThreadStateProvider } from './HarnessThreadState';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { HarnessThreadList } from './HarnessThreadList';
import { HarnessThreadConversation } from './HarnessThreadConversation';
import { isEndedHarnessThread, projectHarnessThreadState } from './harnessThreadPresentation';

function SubtasksContent({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const { t } = useI18n();
  const state = useHarnessThreadState();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'active' | 'attention' | 'ended'>('all');
  const entries = [...state.threads, ...state.branches];
  const entry = entries.find((item) => item.thread.id === selected);
  if (entry) return <HarnessThreadConversation key={entry.thread.id} entry={entry} parentSessionId={sessionId} cwd={cwd} onClose={() => setSelected(null)} />;
  const query = search.trim().toLocaleLowerCase();
  const filtered = entries.filter((item) => {
    if (query && !`${item.thread.brief} ${item.thread.preset ?? ''} ${item.thread.report?.conclusion ?? ''}`.toLocaleLowerCase().includes(query)) return false;
    const ended = isEndedHarnessThread(item);
    const active = ['queued', 'starting', 'running'].includes(projectHarnessThreadState(item));
    return filter === 'all' || (filter === 'ended' ? ended : filter === 'active' ? active : !ended && !active);
  });
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 space-y-3 border-b border-border p-3">
      <Input aria-label={t('harness.threads.search')} placeholder={t('harness.threads.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="flex flex-wrap gap-1" aria-label={t('harness.overview.threads')}>
        {(['all', 'active', 'attention', 'ended'] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
          className={cn('rounded-md px-2.5 py-1 typography-meta', filter === value ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover')}>
          {t(`harness.threads.filter.${value}`)}
        </button>)}
      </div>
    </div>
    {state.loadError ? <div role="alert" className="p-3 typography-meta text-destructive">{state.loadError}
      <Button size="sm" variant="ghost" onClick={() => void state.reload().catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}>{t('settings.harness.retry')}</Button>
    </div> : null}
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <HarnessThreadList entries={filtered} parentSessionId={sessionId} onSelect={(item) => setSelected(item.thread.id)} />
    </div>
  </div>;
}

export function HarnessSubtasksPanel() {
  const { t } = useI18n();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const snapshot = usePiSessionStore((state) => state.currentSessionId ? state.records[state.currentSessionId]?.snapshot : undefined);
  const summary = usePiSessionStore((state) => state.summaries.find((item) => item.id === state.currentSessionId));
  const workspace = snapshot?.workspace ?? summary?.workspace;
  const workspaceId = workspace?.kind === 'workspace' ? workspace.authorityId ?? workspace.id : null;
  if (!sessionId || !workspaceId) return <p className="p-4 typography-meta text-muted-foreground">{t('harness.threads.empty')}</p>;
  return <HarnessThreadStateProvider key={`${runtimeKey}:${sessionId}`} parentSessionId={sessionId} workspaceId={workspaceId}>
    <SubtasksContent sessionId={sessionId} cwd={snapshot?.cwd ?? summary?.cwd} />
  </HarnessThreadStateProvider>;
}
