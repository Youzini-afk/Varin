import React from 'react';
import { runtimeFetch } from '@varin/application-client';
import { isAttachedRootPurpose, type SessionEntriesResult, type ThreadMessageRecord } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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
import { HarnessThreadMessages } from './HarnessThreadMessages';
import { collectThreadPeers, threadPeerLabel, type ThreadExchangeLocation } from './threadMessages';

const Timeline = React.lazy(() => import('./PiTimeline').then((module) => ({ default: module.PiTimeline })));
const EMPTY_TOOLS = {};

export function HarnessThreadConversation({ entry, parentSessionId, cwd, dialog = false, messageFocus, onClose }: {
  entry: HarnessThreadSnapshot; parentSessionId: string; cwd?: string; dialog?: boolean; messageFocus?: ThreadExchangeLocation | null; onClose(): void;
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
  const [view, setView] = React.useState<'conversation' | 'messages'>(messageFocus ? 'messages' : 'conversation');
  const [needsReply, setNeedsReply] = React.useState(true);
  const [reply, setReply] = React.useState<ThreadMessageRecord | null>(null);
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const request = React.useRef<{ id: string; identity: string } | null>(null);
  const peers = React.useMemo(() => collectThreadPeers(threads.peers, threads.rootThreads, threads.threads, threads.branches, [entry]), [entry, threads.peers, threads.rootThreads, threads.threads, threads.branches]);
  React.useEffect(() => { if (messageFocus) setView('messages'); }, [messageFocus]);

  React.useEffect(() => {
    let disposed = false;
    setHistory(null); setError(null);
    if (sessionId && view === 'conversation') void prefetchSession(sessionId).then((result) => {
      if (!disposed) setHistory(result);
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [prefetchSession, retry, runtimeKey, sessionId, view]);

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
    const kind = needsReply ? 'request' : 'inform';
    const identity = JSON.stringify({ text, kind, replyTo: reply?.id });
    if (request.current?.identity !== identity) request.current = { id: crypto.randomUUID(), identity };
    setSending(true);
    try {
      const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, requestId: request.current.id, kind, ...(reply ? { replyTo: reply.id } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? t('harness.threads.sendFailed'));
      threads.merge(parseHarnessThreadMutation(body));
      request.current = null;
      setReply(current => current?.id === reply?.id ? null : current);
      setMessage((current) => current.trim() === text ? '' : current);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSending(false); }
  };

  const entries = record?.branchEntries ?? history;
  const waitingReplies = (entry.thread.dependencyWaits ?? []).filter(wait => wait.state === 'watching' && wait.replyTo)
    .flatMap(wait => entry.thread.messages?.filter(message => message.id === wait.replyTo && message.direction === 'out') ?? []);
  const waitingText = waitingReplies.length ? t('harness.messages.waitingOn', { peer: [...new Set(waitingReplies.map(message => threadPeerLabel(message.to, peers,
    { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') })))].join(', ') }) : entry.thread.waitingFor?.text;
  const Title = dialog ? DialogTitle : 'h3';
  return <div className="flex h-full min-h-0 flex-col">
    <div className={`flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 ${dialog ? 'pr-9' : ''}`}>
      {!dialog ? <Button size="sm" variant="ghost" className="size-8 shrink-0 p-0" onClick={onClose} aria-label={t('harness.threads.backToList')}><Icon name="arrow-left" className="size-4" /></Button> : null}
      <Title className="min-w-0 flex-1 truncate typography-ui-label" title={entry.thread.brief}>{harnessThreadTitle(entry)}</Title>
      <HarnessThreadStatus entry={entry} />
      {sessionId ? <Button variant="ghost" size="sm" disabled={opening} onClick={() => void openConversation()}>
        <Icon name="external-link" className="size-3.5" />{t('harness.threads.openConversation')}
      </Button> : null}
      {!isAttachedRootPurpose(entry.thread.purpose) ? <HarnessThreadActions entry={entry} parentSessionId={parentSessionId} onDeleted={onClose} /> : null}
    </div>
    <div role="tablist" className="flex shrink-0 gap-1 border-b border-border px-4 py-2">
      <Button role="tab" aria-selected={view === 'conversation'} size="sm" variant={view === 'conversation' ? 'secondary' : 'ghost'} onClick={() => setView('conversation')}>{t('harness.messages.conversation')}</Button>
      <Button role="tab" aria-selected={view === 'messages'} size="sm" variant={view === 'messages' ? 'secondary' : 'ghost'} onClick={() => setView('messages')}>{t('harness.messages.exchange')}
        {entry.thread.messages?.length ? <span className="ml-1 text-muted-foreground">{new Set(entry.thread.messages.map(message => message.id)).size}</span> : null}</Button>
    </div>
    {waitingText ? <p className="shrink-0 px-4 py-2 typography-meta text-[var(--status-warning)]">{waitingText}</p> : null}
    {entry.thread.deletion ? <p role="status" className="px-4 py-2 typography-meta text-muted-foreground">{entry.thread.deletion.error ?? t('harness.threads.deleting')}</p> : null}
    {entry.thread.codeSubmissions?.length ? <details className="shrink-0 border-b border-border px-4 py-2 typography-meta">
      <summary className="cursor-pointer text-muted-foreground">{t('harness.threads.codeSubmissions')}</summary>
      <div className="mt-2 max-h-40 space-y-2 overflow-auto">
        {entry.thread.codeSubmissions.map(submission => <div key={submission.id}>
          <p>{t(`harness.threads.codeSubmission.${submission.status}`)} · {submission.paths.join(', ')}</p>
          {submission.conflictPaths.length ? <p className="text-[var(--status-warning)]">{submission.conflictPaths.join(', ')}</p> : null}
          {submission.error ? <p className="text-destructive">{submission.error}</p> : null}
        </div>)}
      </div>
    </details> : null}
    <div className="relative flex min-h-0 flex-1 flex-col">
      {view === 'messages' ? <HarnessThreadMessages entry={entry} entries={peers} parentSessionId={parentSessionId}
        focusMessageId={messageFocus?.messageId} onOpen={onClose} onReply={message => { setReply(message); setNeedsReply(true); composer.current?.focus(); }} /> : <>
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
      </>}
    </div>
    {!entry.thread.deletion && entry.thread.kind === 'implementation'
      && ['dirty', 'merge-ready', 'conflict'].includes(entry.thread.integration) ? <div className="max-h-[35%] shrink-0 overflow-auto">
        <HarnessThreadIntegrationPanel workspaceId={threads.workspaceId} parentSessionId={parentSessionId} entry={entry}
          onThread={(thread) => threads.merge({ thread, activeRun: entry.activeRun })} />
      </div> : null}
    {!entry.thread.deletion && entry.thread.lifecycle !== 'archived' ? <form onSubmit={(event) => void send(event)} className="shrink-0 space-y-2 border-t border-border p-3">
      {reply ? <div className="flex items-center gap-2 typography-meta text-muted-foreground"><span className="min-w-0 flex-1 truncate">{t('harness.messages.reply')}: {reply.text}</span>
        <button type="button" aria-label={t('harness.messages.cancelReply')} onClick={() => setReply(null)}><Icon name="close" className="size-3.5" /></button></div> : null}
      <div className="flex items-end gap-2"><Textarea ref={composer} rows={2} outerClassName="min-w-0 flex-1" className="min-h-14" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('harness.messages.placeholder')} aria-label={t('harness.messages.placeholder')} disabled={sending} />
        <Button type="submit" size="sm" disabled={sending || !message.trim()}>{t('harness.messages.send')}</Button></div>
      <label className="flex items-center gap-2 typography-meta text-muted-foreground"><input type="checkbox" checked={needsReply} onChange={event => setNeedsReply(event.target.checked)} />{t('harness.messages.needsReply')}</label>
    </form> : null}
  </div>;
}

export function HarnessThreadDialog({ entry, parentSessionId, cwd, messageFocus, onClose }: {
  entry: HarnessThreadSnapshot | null; parentSessionId: string; cwd?: string; messageFocus?: ThreadExchangeLocation | null; onClose(): void;
}) {
  return <Dialog open={entry !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="h-[80dvh] max-w-5xl overflow-hidden p-0 gap-0" aria-describedby={undefined}>
      {entry ? <HarnessThreadConversation key={`${parentSessionId}:${entry.thread.id}`} entry={entry} parentSessionId={parentSessionId} cwd={cwd} dialog messageFocus={messageFocus} onClose={onClose} /> : null}
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
