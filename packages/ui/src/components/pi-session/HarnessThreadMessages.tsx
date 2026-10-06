import React from 'react';
import { LegendList } from '@legendapp/list/react';
import type { ThreadMessagePeer, ThreadMessageRecord } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';
import { groupThreadMessages, threadMessageState, threadPeerLabel, threadPeerSession } from './threadMessages';

export function ThreadPeerLink({ peer, entries, onOpen }: { peer: ThreadMessagePeer; entries: readonly HarnessThreadSnapshot[]; onOpen?(): void }) {
  const { t } = useI18n();
  const label = threadPeerLabel(peer, entries, { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') });
  const sessionId = threadPeerSession(peer, entries);
  const directory = peer.kind === 'thread' ? entries.find(entry => entry.thread.id === peer.id)?.thread.worktree?.path : undefined;
  return <button type="button" disabled={!sessionId} className="max-w-56 truncate text-left hover:text-primary disabled:cursor-default" title={label}
    onClick={() => { if (sessionId) void openPiSessionFromNavigation({ sessionId, ...(directory ? { directory } : {}) }).then(onOpen).catch(error => toast.error(error instanceof Error ? error.message : String(error))); }}>{label}</button>;
}

function Exchange({ messages, entries, focused, onOpen, onReply, parentSessionId }: {
  messages: ThreadMessageRecord[]; entries: readonly HarnessThreadSnapshot[]; focused: boolean;
  parentSessionId: string; onOpen(): void; onReply(message: ThreadMessageRecord): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(focused);
  const root = messages[0]!;
  const latest = messages.at(-1)!;
  return <details open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}
    className={cn('group/exchange mx-4 my-2 rounded-lg border border-border/60', focused && 'border-primary/50')}>
    <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
      <div className="flex items-center gap-2 typography-meta text-muted-foreground">
        <Icon name="chat-1" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{threadPeerLabel(root.from, entries, { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') })}
          {' → '}{threadPeerLabel(root.to, entries, { user: t('harness.messages.you'), main: t('harness.messages.main'), thread: t('harness.messages.thread') })}</span>
        <span>{t(`harness.messages.state.${threadMessageState(root, messages)}`)}</span>
        <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
      </div>
      {!open ? <><p className="mt-1 line-clamp-2 whitespace-pre-wrap typography-meta">{root.text}</p>
        {latest.id !== root.id ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap typography-meta text-muted-foreground">↳ {latest.text}</p> : null}</> : null}
    </summary>
    {open ? <div className="space-y-3 border-t border-border/60 p-3">{messages.map(message => <div key={message.id}>
      <div className="mb-1 flex items-center gap-1 typography-meta text-muted-foreground">
        <ThreadPeerLink peer={message.from} entries={entries} onOpen={onOpen} />{' → '}
        <ThreadPeerLink peer={message.to} entries={entries} onOpen={onOpen} />
        <span className="ml-auto">{t(`harness.messages.state.${threadMessageState(message, messages)}`)}</span>
      </div>
      <MarkdownRenderer content={message.text} messageId={`thread-message:${message.id}`} />
      {message.failure ? <p className="typography-meta text-destructive">{message.failure}</p> : null}
      {message.from.kind === 'thread' && message.to.kind !== 'thread' && message.to.id === parentSessionId
        ? <button type="button" className="mt-1 typography-meta text-muted-foreground hover:text-primary" onClick={() => onReply(message)}>{t('harness.messages.reply')}</button> : null}
      <details className="mt-1 typography-micro text-muted-foreground"><summary className="cursor-pointer">{t('harness.messages.details')}</summary>
        <p className="break-all">{message.id}{message.replyTo ? ` · ${message.replyTo}` : ''}</p>
        <p>{new Date(message.at).toLocaleString()}{message.wait ? ` · ${new Date(message.wait.deadline).toLocaleString()}` : ''}</p>
      </details>
    </div>)}</div> : null}
  </details>;
}

export function HarnessThreadMessages({ entry, entries, parentSessionId, focusMessageId, onOpen, onReply }: {
  entry: HarnessThreadSnapshot; entries: readonly HarnessThreadSnapshot[]; parentSessionId: string;
  focusMessageId?: string; onOpen(): void; onReply(message: ThreadMessageRecord): void;
}) {
  const { t } = useI18n();
  const groups = React.useMemo(() => groupThreadMessages(entry.thread.messages ?? []), [entry.thread.messages]);
  if (!groups.length) return <p className="p-4 typography-meta text-muted-foreground">{t('harness.messages.empty')}</p>;
  const focused = groups.findIndex(group => group.messages.some(message => message.id === focusMessageId));
  return <LegendList key={`${entry.thread.id}:${focusMessageId ?? ''}`} data={groups} dataKey={entry.thread.id}
    keyExtractor={group => group.id} recycleItems={false} className="min-h-0 flex-1 overflow-auto" contentContainerClassName="py-2"
    initialScrollIndex={focused >= 0 ? { index: focused, viewPosition: 0.5 } : groups.length - 1}
    renderItem={({ item, index }) => <Exchange messages={item.messages} entries={entries} parentSessionId={parentSessionId}
      focused={index === focused} onOpen={onOpen} onReply={onReply} />} />;
}
