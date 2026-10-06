import React from 'react';
import { useI18n } from '@/lib/i18n';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { harnessThreadSessionId } from './harnessThreadPresentation';
import { ThreadPeerLink } from './HarnessThreadMessages';
import { collectThreadPeers, THREAD_EXCHANGE_OPEN_EVENT } from './threadMessages';

export function PiReceivedThreadMessage({ id, entryId, sessionId, content }: { id?: string; entryId: string; sessionId: string; content: string }) {
  const { t } = useI18n();
  const context = useHarnessThreadState();
  const entries = collectThreadPeers(context.peers, context.rootThreads, context.threads, context.branches);
  const receiver = entries.find(entry => harnessThreadSessionId(entry) === sessionId);
  const message = receiver?.thread.messages?.find(message => message.direction === 'in' && message.id === id)
    ?? entries.flatMap(entry => entry.thread.messages ?? []).find(message => message.id === id && message.to.kind !== 'thread' && message.to.id === sessionId);
  const sender = message?.from.kind === 'thread' ? entries.find(entry => entry.thread.id === message.from.id) : undefined;
  const exchange = receiver ?? sender;
  return <article className="my-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
    <div className="mb-1 flex items-center gap-2 typography-meta text-muted-foreground"><Icon name="chat-1" className="size-3.5 shrink-0" />
      <span>{t(message?.replyTo ? 'harness.messages.reply' : 'harness.messages.received')}</span>
      {message ? <ThreadPeerLink peer={message.from} entries={entries} /> : null}
      {exchange ? <button type="button" className="ml-auto hover:text-primary" onClick={() => window.dispatchEvent(new CustomEvent(THREAD_EXCHANGE_OPEN_EVENT,
        { detail: { threadId: exchange.thread.id, ...(id ? { messageId: id } : {}) } }))}>{t('harness.messages.open')}</button> : null}
    </div>
    <MarkdownRenderer content={message?.text ?? content} messageId={entryId} />
  </article>;
}
