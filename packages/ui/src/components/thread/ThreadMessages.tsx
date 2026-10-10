import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, ThreadRequestError } from '@varin/application-client';
import type { ThreadFamilyAPI, ThreadIdentity, ThreadMessagesAPI } from '@varin/application-client';
import type { FamilyList, MessageActivation, MessageActivationHold, MessageDirection, MessageKind, MessagePage, MessageReceipt, MessageSummary, MessageView } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

type Props = { api: ThreadMessagesAPI; family?: ThreadFamilyAPI; identity: ThreadIdentity; eventCursor?: number };
type Send = Parameters<ThreadMessagesAPI['send']>[1];
const holdLabels: Record<MessageActivationHold, string> = {
  manual_pause: 'manually paused', question: 'awaiting a user answer', goal_blocked: 'Goal control or budget is blocking work',
  dependency_wait: 'ending the original dependency observation', preparing: 'preparing execution', source_unsettled: 'awaiting the original source result and writer stop',
};
function activationText(activation: MessageActivation): string {
  switch (activation.state) {
    case 'passive': return 'Notification · does not start work';
    case 'pending': return `Request awaiting admission${activation.executionId ? ` · execution ${activation.executionId}` : ''}${activation.holdReason ? ` · ${holdLabels[activation.holdReason]}` : ''}`;
    case 'bound': return `Request bound to ${activation.runId}${activation.executionId ? ` · execution ${activation.executionId}` : ''}${activation.holdReason ? ` · ${holdLabels[activation.holdReason]}` : ''}`;
    case 'cancelled': return `Request activation cancelled${activation.runId ? ` · ${activation.runId}` : ''}`;
    case 'failed': return `Request activation failed: ${activation.code}${activation.executionId ? ` · execution ${activation.executionId}` : ''}`;
  }
}
/** Rebuildable original-message views and an unsent draft; no UI queue or execution owner. */
export function ThreadMessages(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const identity = React.useMemo(() => ({ runtime: 'agent' as const, threadId: props.identity.threadId, branchId: props.identity.branchId }), [props.identity.threadId, props.identity.branchId]);
  return <MessageCard key={JSON.stringify([host, identity.threadId, identity.branchId])} {...props} identity={identity} host={host} />;
}
function MessageCard(props: Props & { host: number }) {
  const [open, setOpen] = React.useState(false);
  const [visited, setVisited] = React.useState(false);
  return <section aria-label="Task messages" className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => { setVisited(true); setOpen(value => !value); }}>{open ? 'Hide task messages' : 'Open task messages'}</Button>
    {visited && <div hidden={!open}><Messages {...props} open={open} /></div>}
  </section>;
}
function Messages({ api, family, identity, host, eventCursor, open }: Props & { host: number; open: boolean }) {
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
        intent.current = null; setUncertain(false); setError(`Message was not accepted: ${failure.code}. Your draft is kept.`);
      } else {
        setUncertain(true); setError('Could not confirm acceptance. Retry keeps the original message, target, and request key. Check Sent messages before leaving this view.');
      }
    } finally { if (current()) { inFlight.current = false; setPending(false); } }
  };
  return <div className="space-y-3">
    <p>Notifications are saved for the next normal boundary. Requests ask the recipient to work and can start a new execution when idle; manual pauses, questions and Goal limits remain in effect. Messages sent here keep your user identity.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" aria-pressed={direction === 'incoming'} onClick={() => { setDirection('incoming'); setCursor(undefined); setSelected(undefined); }}>Received messages</Button>
      <Button variant="outline" size="sm" aria-pressed={direction === 'outgoing'} onClick={() => { setDirection('outgoing'); setCursor(undefined); setSelected(undefined); }}>Sent messages</Button>
      <Button variant="ghost" size="sm" onClick={refresh}>Refresh messages</Button>
    </div>
    {open && (readError ? <p role="alert">Could not read messages. Refresh to try again.</p> : !page ? <p role="status">Reading messages…</p> : <>
      {!page.messages.length && <p>No {direction === 'incoming' ? 'received' : 'sent'} messages.</p>}
      {page.messages.map(message => <article key={message.messageId} className="space-y-1 rounded border p-2">
        <p className="break-all">{message.actor.kind === 'user' ? 'User' : 'Agent'} · {message.senderThreadId} / {message.senderBranchId} → {message.targetThreadId} / {message.targetBranchId}</p>
        <p className="text-xs break-all">{message.messageId} · {message.state === 'delivered' ? `Delivered to history in ${message.deliveredRunId}` : message.state === 'cancelled' ? 'Delivery cancelled · original message retained' : message.activation.state === 'failed' ? 'Accepted · not delivered' : message.kind === 'inform' ? 'Accepted · awaiting a normal boundary' : 'Accepted · awaiting history delivery'}{message.replyTo ? ` · reply to ${message.replyTo}` : ''}</p>
        <p className="text-xs break-all">{activationText(message.activation)}</p>
        <Button variant="ghost" size="sm" onClick={() => setSelected(message.messageId)}>Read message {message.messageId}</Button>
        {direction === 'incoming' && <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => { setReply(message); setKind('inform'); setAccepted(undefined); }}>Reply to {message.messageId}</Button>}
      </article>)}
      {page.nextCursor && <Button variant="outline" size="sm" onClick={() => { setCursor(page.nextCursor!); setSelected(undefined); }}>Next messages</Button>}
    </>)}
    {open && selected && <OriginalMessage key={selected} api={api} identity={identity} host={host} messageId={selected} revision={revision} eventCursor={eventCursor} />}
    <div className="space-y-2 border-t pt-2">
      {reply ? <p className="break-all">Replying to {reply.messageId}, addressed to {reply.senderThreadId} / {reply.senderBranchId}. <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setReply(undefined)}>Clear reply</Button></p> : <label className="block">Send message to
        <select aria-label="Message recipient" value={target} disabled={pending || uncertain} onChange={event => setTarget(event.target.value)}>
          <option value="">Choose a conversation and branch</option>
          {members?.members.flatMap(member => member.branches.map(branch => <option key={branch.branchId} value={JSON.stringify([member.threadId, branch.branchId])}>{member.task || member.threadId} · {branch.branchId}</option>))}
        </select>
      </label>}
      {familyError && <p role="alert">Could not read recipients. Refresh messages to try again.</p>}
      {!family && !reply && <p>Recipient discovery is unavailable. Existing received messages can still be replied to.</p>}
      <label className="block">Message purpose
        <select aria-label="Message purpose" value={kind} disabled={pending || uncertain} onChange={event => setKind(event.target.value as MessageKind)}>
          <option value="inform">Notification · keep for normal processing</option>
          <option value="request">Request · ask the recipient to work</option>
        </select>
      </label>
      <Textarea aria-label="Task message text" value={text} disabled={pending || uncertain} onInput={event => setText(event.currentTarget.value)} />
      {error && <p role="alert">{error}</p>}
      {accepted && <p role="status" className="break-all">Accepted message {accepted.messageId}. Delivery to history is shown separately; it does not confirm that work started or the message was handled.</p>}
      {uncertain && <p>Starting a different draft does not withdraw a message that may already have been accepted. <Button variant="ghost" size="sm" disabled={pending} onClick={() => { intent.current = null; setUncertain(false); setError(''); setText(''); setReply(undefined); setTarget(''); setKind('inform'); }}>Start a different draft</Button></p>}
      <Button size="sm" disabled={pending || (!uncertain && (!text.trim().length || (!reply && !target)))} onClick={() => void send()}>{pending ? `Sending ${kind === 'request' ? 'request' : 'notification'}…` : uncertain ? `Retry same ${kind === 'request' ? 'request' : 'notification'}` : kind === 'request' ? 'Send request' : 'Send notification'}</Button>
    </div>
  </div>;
}
function OriginalMessage({ api, identity, host, messageId, revision, eventCursor }: Pick<Props, 'api' | 'identity' | 'eventCursor'> & { host: number; messageId: string; revision: number }) {
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
    {error ? <p role="alert">Could not read the original message. Refresh messages to try again.</p> : !message ? <p role="status">Reading original message…</p> : <>
      <p className="text-xs break-all">{message.messageId} · {message.actor.kind === 'user' ? 'User' : `Agent in ${message.actor.runId}`}{message.replyTo ? ` · reply to ${message.replyTo}` : ''}</p>
      <MarkdownRenderer messageId={`message:${message.messageId}`} content={message.text} />
    </>}
  </div>;
}
