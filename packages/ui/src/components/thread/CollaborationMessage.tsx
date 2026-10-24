import React from 'react';
import type { MessageFeedEntry } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { ChildState } from '../conversation/childPresentation';
import type { CollaborationFeedItem, CollaborationMember } from './collaborationFeed';
import { exchangeSummary } from './collaborationPresentation';
import { CollaborationExchangeCard } from './CollaborationExchange';

/** Measure the rendered body, including Markdown, fonts and later image loads. */
export function CollaborationMessageBody({ id, text, expanded, onExpandedChange }: {
  id: string; text: string; expanded: boolean; onExpandedChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const body = React.useRef<HTMLDivElement>(null);
  const limit = React.useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = React.useState({ height: 0, overflow: false });
  const regionId = React.useId();
  React.useLayoutEffect(() => {
    const content = body.current, boundary = limit.current;
    if (!content || !boundary) return;
    const measure = () => {
      const height = content.scrollHeight;
      const preview = boundary.getBoundingClientRect().height;
      const overflow = preview > 0 && height > preview + 1;
      setMeasurement(previous => previous.height === height && previous.overflow === overflow ? previous : { height, overflow });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content); observer.observe(boundary);
    return () => observer.disconnect();
  }, [id, text]);
  return <div className="collaboration-message-body" data-expanded={expanded} data-overflow={measurement.overflow}>
    <div ref={limit} className="collaboration-message-preview-limit" aria-hidden="true" />
    <div id={regionId} className="collaboration-message-window"
      style={expanded ? { maxHeight: measurement.height || undefined } : undefined}
      onFocusCapture={() => { if (!expanded && measurement.overflow) onExpandedChange(true); }}>
      <div ref={body} className="collaboration-message-content">
        <MarkdownRenderer messageId={`collaboration:${id}`} content={text} enableFileReferences={false} />
      </div>
    </div>
    {measurement.overflow && <button type="button" className="collaboration-message-expand"
      aria-expanded={expanded} aria-controls={regionId} onClick={() => onExpandedChange(!expanded)}>
      {t(expanded ? 'collaboration.collapseMessage' : 'collaboration.expandMessage')}
      <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
    </button>}
  </div>;
}

export function CollaborationMessage({ item, members, original, expanded, onExpandedChange, onMember, onReply, onCopy, onExchange }: {
  item: CollaborationFeedItem; members: CollaborationMember[]; original?: MessageFeedEntry;
  expanded: boolean; onExpandedChange(open: boolean): void;
  onMember(threadId: string, branchId: string): void;
  onReply(item: CollaborationFeedItem): void; onCopy(text: string): void;
  onExchange(message: MessageFeedEntry): void;
}) {
  const { t } = useI18n();
  const message = item.kind === 'message' ? item.message : undefined;
  const report = item.kind === 'report' ? item.report : undefined;
  const record = item.kind === 'message' ? item.message : item.kind === 'dispatch' ? item.dispatch : item.report;
  const text = item.kind === 'message' ? item.message.text : item.kind === 'dispatch' ? item.dispatch.task
    : [item.report.text, item.report.detail].filter(Boolean).join('\n\n');
  const outgoing = message?.actor.kind === 'user';
  const find = (id: string) => members.find(member => member.threadId === id);
  const name = (id: string) => find(id)?.name || find(id)?.agentId || id;
  const exchange = message && exchangeSummary(message);
  const sourceId = exchange && typeof exchange.source?.threadId === 'string' ? exchange.source.threadId : record.senderThreadId;
  const targetId = exchange && typeof exchange.target?.threadId === 'string' ? exchange.target.threadId : record.targetThreadId;
  const sourceBranch = sourceId === record.senderThreadId ? record.senderBranchId : record.targetBranchId;
  const targetBranch = targetId === record.targetThreadId ? record.targetBranchId : record.senderBranchId;
  const target = find(targetId);
  const memberLink = (threadId: string, branchId: string, avatar = false) => <button type="button"
    className="collaboration-message-member" title={name(threadId)}
    aria-label={t('collaboration.viewMember', { name: name(threadId) })}
    onClick={() => onMember(threadId, branchId)}>
    {avatar && <AgentAvatar identity={threadId} avatar={find(threadId)?.avatar} size={16} />}
    <span>{name(threadId)}</span>
  </button>;
  const replyLabel = t(item.kind === 'message' ? 'chat.messages.reply' : 'collaboration.send');
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <article className="collaboration-message" data-message-id={item.id} data-kind={item.kind} data-outgoing={Boolean(outgoing)}>
        {outgoing ? <span className="collaboration-message-user-avatar">{t('collaboration.you')}</span>
          : <button type="button" className="collaboration-message-avatar" onClick={() => onMember(sourceId, sourceBranch)}
            aria-label={t('collaboration.viewMember', { name: name(sourceId) })}>
            <AgentAvatar identity={sourceId} avatar={find(sourceId)?.avatar} size={30} />
          </button>}
        <div className="collaboration-message-column">
          <div className="collaboration-message-route">
            {outgoing ? <span className="collaboration-message-self">{t('collaboration.you')}</span> : memberLink(sourceId, sourceBranch)}
            <span className="collaboration-message-to">{t('collaboration.to')}</span>
            {memberLink(targetId, targetBranch, true)}
          </div>
          <div className="collaboration-message-bubble">
            {item.kind === 'dispatch' && <div className="collaboration-dispatch-label">
              <Icon name="git-branch" className="size-3.5" />
              <span>{t('collaboration.dispatch')}</span>
              {item.dispatch.preset && <span className="collaboration-dispatch-preset">{item.dispatch.preset}</span>}
            </div>}
            {report && <div className="collaboration-dispatch-label">
              <Icon name="reply" className="size-3.5" />
              <span>{t('collaboration.report')}</span>
              {report.outcome !== 'succeeded' && <ChildState state={report.outcome} />}
            </div>}
            {message?.replyTo && <div className="collaboration-message-quote">
              <Icon name="reply" className="size-3 shrink-0" />
              <span>{original ? original.codeExchangeOperationId ? t('collaboration.fileExchange') : original.text : t('collaboration.earlierMessage')}</span>
            </div>}
            {exchange && message ? <CollaborationExchangeCard message={message} onOpen={() => onExchange(message)} />
              : text && <CollaborationMessageBody id={item.id} text={text} expanded={expanded} onExpandedChange={onExpandedChange} />}
            {item.kind === 'dispatch' && <div className="collaboration-dispatch-footer">
              <button type="button" onClick={() => onMember(targetId, targetBranch)}>
                {t('collaboration.openAgent')}<Icon name="arrow-right-s" className="size-3.5" />
              </button>
              {target?.detail && <span className="collaboration-dispatch-agent-state" title={t('collaboration.agentState')}>
                <ChildState state={target.detail.state} />
              </span>}
            </div>}
            {report && <div className="collaboration-dispatch-footer">
              <button type="button" onClick={() => onMember(sourceId, sourceBranch)}>
                {t('collaboration.openAgent')}<Icon name="arrow-right-s" className="size-3.5" />
              </button>
            </div>}
          </div>
          <div className="collaboration-message-footer">
            {item.acceptedAtMs !== undefined && <time dateTime={new Date(item.acceptedAtMs).toISOString()} title={new Date(item.acceptedAtMs).toLocaleString()}>
              {new Date(item.acceptedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>}
            {message?.activation.state === 'failed' ? <span role="status" title={message.activation.code} className="text-destructive">{t('chat.messages.failed')}</span>
              : message?.state === 'cancelled' ? <span>{t('chat.messages.cancelled')}</span>
                : outgoing && message?.state === 'queued' ? <span>{t('chat.messages.queued')}</span> : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="collaboration-message-menu" aria-label={t('collaboration.messageActions')}>
                  <Icon name="more" className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onReply(item)}><Icon name="reply" className="size-4" />{replyLabel}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCopy(text)}><Icon name="file-copy" className="size-4" />{t('collaboration.copyMessage')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </article>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onReply(item)}><Icon name="reply" className="size-4" />{replyLabel}</ContextMenuItem>
      <ContextMenuItem onClick={() => onMember(item.kind === 'dispatch' ? targetId : sourceId, item.kind === 'dispatch' ? targetBranch : sourceBranch)}>
        <Icon name="chat-1" className="size-4" />{t('harness.threads.openConversation')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopy(text)}><Icon name="file-copy" className="size-4" />{t('collaboration.copyMessage')}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
