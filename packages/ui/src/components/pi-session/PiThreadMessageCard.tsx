import React from 'react';
import { isAttachedRootPurpose, type PiToolCall, type PiToolResultMessage, type ThreadMessagePeer, type ThreadMessageRecord } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { collectThreadPeers, THREAD_EXCHANGE_OPEN_EVENT, threadMessageState, threadPeerLabel } from './threadMessages';
import { ThreadPeerLink } from './HarnessThreadMessages';
import { harnessThreadSessionId } from './harnessThreadPresentation';

const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const peerOf = (value: unknown): ThreadMessagePeer | undefined => {
  const record = recordOf(value);
  return ['thread', 'session', 'user'].includes(String(record.kind)) && typeof record.id === 'string' ? record as unknown as ThreadMessagePeer : undefined;
};

export function PiThreadMessageCard({ call, result, failed, sessionId }: { call: PiToolCall; result?: PiToolResultMessage; failed: boolean; sessionId?: string }) {
  const { t } = useI18n();
  const context = useHarnessThreadState();
  const [open, setOpen] = React.useState(false);
  const entries = React.useMemo(() => collectThreadPeers(context.peers, context.rootThreads, context.threads, context.branches), [context.peers, context.rootThreads, context.threads, context.branches]);
  const args = recordOf(call.arguments);
  const details = recordOf(result?.details);
  const id = typeof details.messageId === 'string' ? details.messageId : undefined;
  const senderPeer = peerOf(details.from);
  const caller = senderPeer?.kind === 'thread' ? entries.find(entry => entry.thread.id === senderPeer.id)
    : entries.find(entry => harnessThreadSessionId(entry) === sessionId);
  const matches = (message: ThreadMessageRecord) => message.id === id
    && message.text === args.message && message.kind === (args.kind ?? 'inform') && message.replyTo === args.replyTo
    && (args.threadId === undefined || message.to.id === args.threadId);
  const message = id ? caller?.thread.messages?.find(message => matches(message) && message.direction === 'out')
    ?? entries.flatMap(entry => entry.thread.messages ?? []).find(message => matches(message)
      && (senderPeer ? message.from.id === senderPeer.id && message.from.kind === senderPeer.kind : message.originSessionId === sessionId)) : undefined;
  const from = senderPeer ?? message?.from;
  const to = peerOf(details.to) ?? message?.to ?? (typeof args.threadId === 'string' ? { kind: 'thread' as const, id: args.threadId } : undefined);
  const sender = from?.kind === 'thread' ? entries.find(entry => entry.thread.id === from.id) : undefined;
  const messages = sender?.thread.messages ?? (to?.kind === 'thread' ? entries.find(entry => entry.thread.id === to.id)?.thread.messages : undefined) ?? [];
  const replies = message ? messages.filter(reply => reply.replyTo === message.id && ['held', 'delivered', 'resolved'].includes(reply.status)) : [];
  const directReply = recordOf(details.reply);
  const accepted = message && ['held', 'delivered', 'resolved'].includes(message.status);
  const rejected = failed && ['invalid-params', 'denied', 'forbidden'].includes(String(details.code));
  const state = rejected ? 'failed' : replies.length || directReply.text ? 'replied' : failed && !accepted ? 'failed' : failed || details.timedOut || details.interrupted ? 'waitEnded' : message ? threadMessageState(message, messages)
    : details.timedOut || details.interrupted ? 'waitEnded' : result ? (details.delivery === 'held' ? 'recorded' : details.delivery === 'scheduled' ? 'queued' : args.kind === 'request' ? 'pendingReply' : 'delivered')
      : typeof args.wait === 'number' && args.wait > 0 ? 'sendingAndWaiting' : 'sending';
  const exchange = entries.find(entry => entry.thread.id === to?.id && !isAttachedRootPurpose(entry.thread.purpose))
    ?? sender ?? entries.find(entry => entry.thread.id === to?.id);
  const text = typeof args.message === 'string' ? args.message : '';
  const preview = to ? threadPeerLabel(to, entries, { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') }) : '';
  return <details open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }} className="group/message my-1 rounded-lg border border-border/60">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 typography-meta [&::-webkit-details-marker]:hidden">
      <Icon name={!result && !failed ? 'loader-4' : 'chat-1'} className={!result && !failed ? 'size-3.5 animate-spin text-muted-foreground' : 'size-3.5 text-muted-foreground'} />
      <span className="shrink-0">{t(args.replyTo ? 'harness.messages.reply' : 'harness.messages.send')}</span>
      {preview ? <span className="min-w-0 max-w-40 truncate" title={preview}>→ {preview}</span> : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{text}</span>
      <span className={state === 'failed' ? 'shrink-0 text-destructive' : 'shrink-0 text-muted-foreground'}>{t(`harness.messages.state.${state}`)}</span>
      <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground" />
    </summary>
    {open ? <div className="space-y-2 border-t border-border/60 p-3">
      {from || to ? <div className="flex items-center gap-1 typography-meta text-muted-foreground">{from ? <ThreadPeerLink peer={from} entries={entries} /> : null}{from && to ? ' → ' : null}{to ? <ThreadPeerLink peer={to} entries={entries} /> : null}</div> : null}
      <MarkdownRenderer content={text} messageId={`sent-message:${call.id}`} />
      {replies.map(reply => <div key={reply.id} className="border-l border-border pl-3"><MarkdownRenderer content={reply.text} messageId={`reply:${reply.id}`} /></div>)}
      {!replies.length && typeof directReply.text === 'string' ? <MarkdownRenderer content={directReply.text} messageId={`reply:${call.id}`} /> : null}
      {failed && result ? <p className="whitespace-pre-wrap typography-meta text-destructive">{result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n')}</p> : null}
      {exchange ? <button type="button" className="typography-meta text-muted-foreground hover:text-primary" onClick={() => window.dispatchEvent(new CustomEvent(THREAD_EXCHANGE_OPEN_EVENT, { detail: { threadId: exchange.thread.id, ...(id ? { messageId: id } : {}) } }))}>{t('harness.messages.open')}</button> : null}
      <details className="typography-micro text-muted-foreground"><summary className="cursor-pointer">{t('harness.messages.details')}</summary><pre className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ arguments: call.arguments, receipt: result?.details }, null, 2)}</pre></details>
    </div> : null}
  </details>;
}
