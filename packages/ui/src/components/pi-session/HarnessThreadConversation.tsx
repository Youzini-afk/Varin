import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import type { SessionEntriesResult } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useWorkOverviewStore, workOverviewStateKey } from '@/stores/useWorkOverviewStore';
import { harnessThreadSessionId, harnessThreadTitle, parseHarnessThreadMutation, type HarnessThreadSnapshot } from './harnessThreadPresentation';
import { HarnessThreadStatus } from './HarnessThreadList';
import { HarnessThreadActions } from './HarnessThreadActions';
import { HarnessThreadIntegrationPanel } from './HarnessThreadIntegrationPanel';
import { useHarnessThreadState } from './HarnessThreadStateContext';

const Timeline = React.lazy(() => import('./PiTimeline').then((module) => ({ default: module.PiTimeline })));
const EMPTY_TOOLS = {};

export function HarnessThreadConversation({ entry, parentSessionId, cwd, dialog = false, onClose }: {
  entry: HarnessThreadSnapshot; parentSessionId: string; cwd?: string; dialog?: boolean; onClose(): void;
}) {
  const { t } = useI18n();
  const threads = useHarnessThreadState();
  const sessionId = harnessThreadSessionId(entry);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const record = usePiSessionStore((state) => sessionId ? state.records[sessionId] : undefined);
  const prefetchSession = usePiSessionStore((state) => state.prefetchSession);
  const [history, setHistory] = React.useState<SessionEntriesResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [opening, setOpening] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const request = React.useRef<{ id: string; text: string } | null>(null);

  React.useEffect(() => {
    let disposed = false;
    setHistory(null); setError(null);
    if (sessionId) void prefetchSession(sessionId).then((result) => {
      if (!disposed) setHistory(result);
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [prefetchSession, retry, runtimeKey, sessionId]);

  const openConversation = async () => {
    if (!sessionId) return;
    setOpening(true);
    useWorkOverviewStore.setState((state) => ({ parentBySession: {
      ...state.parentBySession,
      [workOverviewStateKey(runtimeKey, sessionId)]: { sessionId: parentSessionId, ...(cwd ? { directory: cwd } : {}) },
    } }));
    try {
      await openPiSessionFromNavigation({
        sessionId, directory: entry.thread.worktree?.path ?? cwd,
        launch: {
          ...(entry.thread.model ? { model: entry.thread.model } : {}),
          ...(entry.thread.manifest.scope.length ? { scope: entry.thread.manifest.scope } : {}),
          tools: entry.thread.manifest.tools,
        },
      });
      onClose();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOpening(false); }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    if (request.current?.text !== text) request.current = { id: crypto.randomUUID(), text };
    setSending(true);
    try {
      const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, requestId: request.current.id, kind: 'request' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? t('harness.threads.sendFailed'));
      threads.merge(parseHarnessThreadMutation(body));
      request.current = null;
      setMessage((current) => current.trim() === text ? '' : current);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSending(false); }
  };

  const entries = record?.branchEntries ?? history;
  const Title = dialog ? DialogTitle : 'h3';
  return <div className="flex h-full min-h-0 flex-col">
    <div className={`flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 ${dialog ? 'pr-9' : ''}`}>
      {!dialog ? <Button size="sm" variant="ghost" className="size-8 shrink-0 p-0" onClick={onClose} aria-label={t('harness.threads.backToList')}><Icon name="arrow-left" className="size-4" /></Button> : null}
      <Title className="min-w-0 flex-1 truncate typography-ui-label" title={entry.thread.brief}>{harnessThreadTitle(entry)}</Title>
      <HarnessThreadStatus entry={entry} />
      {sessionId ? <Button variant="ghost" size="sm" disabled={opening} onClick={() => void openConversation()}>
        <Icon name="external-link" className="size-3.5" />{t('harness.threads.openConversation')}
      </Button> : null}
      <HarnessThreadActions entry={entry} parentSessionId={parentSessionId} onDeleted={onClose} />
    </div>
    {entry.thread.waitingFor?.text ? <p className="shrink-0 px-4 py-2 typography-meta text-[var(--status-warning)]">{entry.thread.waitingFor.text}</p> : null}
    {entry.thread.deletion ? <p role="status" className="px-4 py-2 typography-meta text-muted-foreground">{entry.thread.deletion.error ?? t('harness.threads.deleting')}</p> : null}
    <div className="relative flex min-h-0 flex-1 flex-col">
      {error ? <div role="alert" className="p-4 typography-meta text-destructive">{error}
        <Button className="ml-2" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('settings.harness.retry')}</Button>
      </div> : null}
      {sessionId && entries ? <React.Suspense fallback={<p role="status" className="p-4">{t('common.loading')}</p>}>
        <Timeline sessionId={sessionId} entries={entries.entries} leafId={entries.leafId}
          cwd={record?.snapshot?.cwd ?? entry.thread.worktree?.path ?? cwd ?? ''}
          liveAssistant={record?.stoppedAssistant ?? record?.liveAssistant} liveUser={record?.liveUser}
          toolExecutions={record?.toolExecutions ?? EMPTY_TOOLS} />
      </React.Suspense> : !sessionId ? <div className="overflow-auto p-4">
        <MarkdownRenderer content={entry.thread.report?.conclusion || entry.thread.brief} messageId={entry.thread.id} />
      </div> : !error ? <p role="status" className="p-4 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    </div>
    {!entry.thread.deletion && entry.thread.kind === 'implementation'
      && ['dirty', 'merge-ready', 'conflict'].includes(entry.thread.integration) ? <div className="max-h-[35%] shrink-0 overflow-auto">
        <HarnessThreadIntegrationPanel workspaceId={threads.workspaceId} parentSessionId={parentSessionId} entry={entry}
          onThread={(thread) => threads.merge({ thread, activeRun: entry.activeRun })} />
      </div> : null}
    {!entry.thread.deletion && entry.thread.kind === 'implementation' && entry.thread.lifecycle !== 'archived' ? <form onSubmit={(event) => void send(event)} className="flex shrink-0 gap-2 border-t border-border p-3">
      <Input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('harness.threads.askPlaceholder')} aria-label={t('harness.threads.askPlaceholder')} disabled={sending} />
      <Button type="submit" size="sm" disabled={sending || !message.trim()}>{t('harness.threads.ask')}</Button>
    </form> : null}
  </div>;
}

export function HarnessThreadDialog({ entry, parentSessionId, cwd, onClose }: {
  entry: HarnessThreadSnapshot | null; parentSessionId: string; cwd?: string; onClose(): void;
}) {
  return <Dialog open={entry !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="h-[80dvh] max-w-5xl overflow-hidden p-0 gap-0" aria-describedby={undefined}>
      {entry ? <HarnessThreadConversation key={`${parentSessionId}:${entry.thread.id}`} entry={entry} parentSessionId={parentSessionId} cwd={cwd} dialog onClose={onClose} /> : null}
    </DialogContent>
  </Dialog>;
}

export function HarnessThreadParentLink({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const parentId = usePiSessionStore((state) => state.summaries.find((summary) => summary.id === sessionId)?.parentId);
  const origin = useWorkOverviewStore((state) => state.parentBySession[workOverviewStateKey(runtimeKey, sessionId)]);
  const target = origin ?? (parentId ? { sessionId: parentId } : null);
  if (!target) return null;
  return <div className="shrink-0 px-4 py-1">
    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void openPiSessionFromNavigation(target).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}>
      <Icon name="arrow-left" className="size-3.5" />{t('harness.threads.backToParent')}
    </Button>
  </div>;
}
