import { useI18n, type I18nKey } from '@/lib/i18n';
import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, ThreadRequestError } from '@varin/application-client';
import type { ThreadFamilyAPI, ThreadIdentity, ThreadMessagesAPI } from '@varin/application-client';
import type { FamilyList, MessageActivation, MessageActivationHold, MessageDirection, MessageKind, MessagePage, MessageReceipt, MessageSummary, MessageView, ReplyWaitView } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

type Props = { api: ThreadMessagesAPI; family?: ThreadFamilyAPI; identity: ThreadIdentity; eventCursor?: number; cancelObservation?: (operationId: string) => Promise<void> };
type Send = Parameters<ThreadMessagesAPI['send']>[1];
const holdLabels: Record<MessageActivationHold, I18nKey> = {
  manual_pause: 'chat.messages.paused', question: 'chat.messages.question', goal_blocked: 'chat.messages.goal',
  dependency_wait: 'chat.messages.dependency', preparing: 'chat.messages.preparing', source_unsettled: 'chat.messages.source',
};
function activationText(activation: MessageActivation, t: ReturnType<typeof useI18n>['t']): string {
  const held = 'holdReason' in activation && activation.holdReason ? ` · ${t(holdLabels[activation.holdReason])}` : '';
  switch (activation.state) {
    case 'passive': return t('chat.messages.inform');
    case 'pending': return t('chat.messages.queued') + held;
    case 'bound': return t('chat.messages.started') + held;
    case 'cancelled': return t('chat.messages.cancelled');
    case 'failed': return `${t('chat.messages.failed')}: ${activation.code}`;
  }
}
function replyWaitText(wait: ReplyWaitView, t: ReturnType<typeof useI18n>['t']): string {
  if (wait.state === 'replied') return t('chat.messages.replied');
  if (wait.state === 'expired') return t('chat.messages.expired');
  if (wait.state === 'cancelled') return t('chat.messages.stoppedWait');
  if (wait.deadlineAtMs === null) return t('chat.messages.waiting');
  const deadline = new Date(wait.deadlineAtMs);
  return `${t('chat.messages.waiting')} · ${deadline.toLocaleString()}`;
}
/** Rebuildable original-message views and an unsent draft; no UI queue or execution owner. */
export function ThreadMessages(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const identity = React.useMemo(() => ({ runtime: 'agent' as const, threadId: props.identity.threadId, branchId: props.identity.branchId }), [props.identity.threadId, props.identity.branchId]);
  return <MessageCard key={JSON.stringify([host, identity.threadId, identity.branchId])} {...props} identity={identity} host={host} />;
}
function MessageCard(props: Props & { host: number }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [visited, setVisited] = React.useState(false);
  return <section aria-label="Task messages" className="space-y-2 typography-meta">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => { setVisited(true); setOpen(value => !value); }}>{t('chat.children.messages')}</Button>
    {visited && <div hidden={!open}><Messages {...props} open={open} /></div>}
  </section>;
}
function Messages({ api, family, identity, host, eventCursor, open, cancelObservation }: Props & { host: number; open: boolean }) {
  const { t } = useI18n();
  const [direction, setDirection] = React.useState<MessageDirection>('incoming');
  const [cursor, setCursor] = React.useState<string>();
  const [revision, setRevision] = React.useState(0);
  const [page, setPage] = React.useState<MessagePage>();
  const [readError, setReadError] = React.useState(false);
  const [selected, setSelected] = React.useState<string>();
  const [members, setMembers] = React.useState<FamilyList>();
  const [familyError, setFamilyError] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [text, setText] = React.useState('');
  const [kind, setKind] = React.useState<MessageKind>('inform');
  const [reply, setReply] = React.useState<MessageSummary>();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [accepted, setAccepted] = React.useState<MessageReceipt>();
  const [uncertain, setUncertain] = React.useState(false);
  const name = (threadId: string) => members?.members.find(member => member.threadId === threadId)?.task || t(threadId === identity.threadId ? 'chat.messages.current' : 'chat.family.untitled');
  const inFlight = React.useRef(false);
  const intent = React.useRef<Send | null>(null);
  const live = React.useRef(false);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && host === getRuntimeEndpointGeneration();
  const refresh = () => { setCursor(undefined); setRevision(value => value + 1); };
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setPage(undefined); setReadError(false);
    void api.list(identity, { direction, cursor }, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setPage(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setReadError(true); });
    return () => controller.abort();
  }, [api, identity, host, open, direction, cursor, revision, eventCursor]);
  React.useEffect(() => {
    if (!open || !family) return;
    const controller = new AbortController(); setFamilyError(false);
    void family.list(identity, false, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setMembers(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setFamilyError(true); });
    return () => controller.abort();
  }, [family, identity, host, open, revision]);
  const send = async () => {
    if (inFlight.current) return;
    let request = intent.current;
    if (!request) {
      if (!text.trim().length || (!reply && !target)) return;
      const [targetThreadId, targetBranchId] = target ? JSON.parse(target) as [string, string] : ['', ''];
      request = { key: crypto.randomUUID(), kind, text,
        ...(reply ? { replyTo: reply.messageId } : { targetThreadId, targetBranchId }) };
      intent.current = request;
    }
    inFlight.current = true; setPending(true); setError(''); setAccepted(undefined);
    try {
      const receipt = await api.send(identity, request);
      if (!current() || intent.current !== request) return;
      setAccepted(receipt); setText(''); setReply(undefined); setUncertain(false); intent.current = null;
      setDirection('outgoing'); setSelected(receipt.messageId); refresh();
    } catch (failure) {
      if (!current() || intent.current !== request) return;
      if (failure instanceof ThreadRequestError && (failure.code === 'thread-conflict' || [401, 403, 413].includes(failure.status))) {
        intent.current = null; setUncertain(false); setError(t('chat.messages.notAccepted'));
      } else {
        setUncertain(true); setError(t('chat.messages.unconfirmed'));
      }
    } finally { if (current()) { inFlight.current = false; setPending(false); } }
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-1">
      <Button variant="ghost" size="sm" aria-pressed={direction === 'incoming'} onClick={() => { setDirection('incoming'); setCursor(undefined); setSelected(undefined); }}>{t('chat.messages.incoming')}</Button>
      <Button variant="ghost" size="sm" aria-pressed={direction === 'outgoing'} onClick={() => { setDirection('outgoing'); setCursor(undefined); setSelected(undefined); }}>{t('chat.messages.outgoing')}</Button>
      <Button variant="ghost" size="sm" onClick={refresh}>{t('chat.family.refresh')}</Button>
    </div>
    {open && (readError ? <p role="alert">{t('chat.messages.readFailed')}</p> : !page ? <p role="status">{t('common.loading')}</p> : <>
      {!page.messages.length && <p className="text-muted-foreground">{t('chat.messages.empty')}</p>}
      {page.messages.map(message => <article key={message.messageId} className="space-y-1 rounded-lg border border-border/50 p-2">
        <p className="truncate font-medium" title={`${name(message.senderThreadId)} → ${name(message.targetThreadId)}`}>{name(message.senderThreadId)} → {name(message.targetThreadId)}</p>
        <p className="text-xs text-muted-foreground">{t(message.state === 'delivered' ? 'chat.messages.delivered' : message.state === 'cancelled' ? 'chat.messages.cancelled' : 'chat.messages.accepted')} · {activationText(message.activation, t)}</p>
        {message.replyWait && <div className="space-y-1 text-xs">
          <p>{replyWaitText(message.replyWait, t)}</p>
          {direction === 'outgoing' && message.replyWait.state === 'waiting' && cancelObservation && <Button variant="ghost" size="sm" onClick={() => void cancelObservation(message.replyWait!.operationId)}>{t('chat.messages.stopWait')}</Button>}
        </div>}
        <Button variant="ghost" size="sm" onClick={() => setSelected(selected === message.messageId ? undefined : message.messageId)}>{t('chat.messages.read')}</Button>
        {direction === 'incoming' && <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => { setReply(message); setKind('inform'); setAccepted(undefined); }}>{t('chat.messages.reply')}</Button>}
        {selected === message.messageId && <OriginalMessage api={api} identity={identity} host={host} messageId={selected} revision={revision} eventCursor={eventCursor} />}
      </article>)}
      {page.nextCursor && <Button variant="ghost" size="sm" onClick={() => { setCursor(page.nextCursor!); setSelected(undefined); }}>{t('chat.family.more')}</Button>}
    </>)}
    <div className="space-y-2 border-t border-border/50 pt-2">
      {reply ? <p>{t('chat.messages.reply')} · {name(reply.senderThreadId)} <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setReply(undefined)}>{t('chat.messages.clearReply')}</Button></p> : <label className="block space-y-1">{t('chat.messages.recipient')}
        <select className="block w-full rounded border border-border bg-background p-2" aria-label={t('chat.messages.recipient')} value={target} disabled={pending || uncertain} onChange={event => setTarget(event.target.value)}>
          <option value="">{t('chat.messages.choose')}</option>
          {members?.members.flatMap(member => member.branches.map((branch, index) => <option key={branch.branchId} value={JSON.stringify([member.threadId, branch.branchId])}>{member.task || t('chat.family.untitled')}{member.branches.length > 1 ? ` · ${t('chat.family.branch')} ${index + 1}` : ''}</option>))}
        </select>
      </label>}
      {familyError && <p role="alert">{t('chat.family.failed')}</p>}
      <select className="w-full rounded border border-border bg-background p-2" aria-label={t('chat.messages.purpose')} value={kind} disabled={pending || uncertain} onChange={event => setKind(event.target.value as MessageKind)}>
        <option value="inform">{t('chat.messages.informHint')}</option>
        <option value="request">{t('chat.messages.requestHint')}</option>
      </select>
      <Textarea aria-label={t('chat.messages.text')} value={text} disabled={pending || uncertain} onInput={event => setText(event.currentTarget.value)} />
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {accepted && <p role="status" className="text-muted-foreground">{t('chat.messages.accepted')}</p>}
      {uncertain && <Button variant="ghost" size="sm" disabled={pending} onClick={() => { intent.current = null; setUncertain(false); setError(''); setText(''); setReply(undefined); setTarget(''); setKind('inform'); }}>{t('chat.messages.newDraft')}</Button>}
      <Button size="sm" disabled={pending || (!uncertain && (!text.trim().length || (!reply && !target)))} onClick={() => void send()}>{t(pending ? 'chat.messages.sending' : uncertain ? 'chat.messages.retry' : kind === 'request' ? 'chat.messages.sendRequest' : 'chat.messages.send')}</Button>
    </div>
  </div>;
}

function OriginalMessage({ api, identity, host, messageId, revision, eventCursor }: Pick<Props, 'api' | 'identity' | 'eventCursor'> & { host: number; messageId: string; revision: number }) {
  const { t } = useI18n();
  const [message, setMessage] = React.useState<MessageView>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController(); setMessage(undefined); setError(false);
    void api.get(identity, messageId, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setMessage(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, host, messageId, revision, eventCursor]);
  return <div aria-label="Original task message" className="rounded border p-2">
    {error ? <p role="alert">{t('chat.messages.readFailed')}</p> : !message ? <p role="status">{t('common.loading')}</p> : <>
      <MarkdownRenderer messageId={`message:${message.messageId}`} content={message.text} />
    </>}
  </div>;
}
