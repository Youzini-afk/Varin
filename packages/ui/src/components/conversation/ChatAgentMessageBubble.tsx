import React from 'react';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useToolDisclosureChoices } from './toolDisclosureContext';
import { agentMessagePreview } from './agentMessagePresentation';

/** The same folded message surface for received messages, reports and native send calls. */
export function ChatAgentMessageBubble({ id, senderThreadId, senderBranchId, targetThreadId, targetBranchId,
  text, kind = 'message', outgoing = false, status, live = false, children }: {
  id: string; senderThreadId?: string; senderBranchId?: string; targetThreadId?: string; targetBranchId?: string;
  text: string; kind?: 'message' | 'report' | 'task'; outgoing?: boolean; status?: React.ReactNode;
  /** Being sent now: the bubble settles in once instead of appearing. */
  live?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [arrives] = React.useState(live);
  const choices = useToolDisclosureChoices();
  const key = `agent-message:${id}`;
  const [expanded, setExpanded] = React.useState(() => choices?.get(key) ?? false);
  const [visited, setVisited] = React.useState(expanded);
  const regionId = React.useId();
  const threads = useThreadStore(state => state.threads);
  const member = (id?: string) => threads.find(thread => thread.thread_id === id || (id && thread.agent_code === id.toUpperCase()));
  const source = member(senderThreadId), target = member(targetThreadId);
  const name = (id?: string) => {
    const thread = member(id);
    return thread?.title || thread?.agent_code || id || t('chat.agentMessage.agent');
  };
  const openMember = (id?: string, branchId?: string) => {
    if (id) void openThreadFromNavigation({ threadId: member(id)?.thread_id ?? id, ...(branchId ? { branchId } : {}) });
  };
  const label = t(kind === 'report' ? 'collaboration.report' : kind === 'task' ? 'collaboration.dispatch' : 'chat.agentMessage.message');
  const preview = agentMessagePreview(text);
  return <article className="chat-agent-message" data-outgoing={outgoing} data-kind={kind} data-arrive={arrives || undefined}>
    <button type="button" className="chat-agent-message-avatar" disabled={!senderThreadId}
      aria-label={t('collaboration.viewMember', { name: name(senderThreadId) })} onClick={() => openMember(senderThreadId, senderBranchId)}>
      <AgentAvatar identity={source?.thread_id ?? senderThreadId ?? id} avatar={source?.avatar} size={26} />
    </button>
    <div className="chat-agent-message-column">
      <div className="chat-agent-message-route">
        <button type="button" disabled={!senderThreadId} title={name(senderThreadId)} onClick={() => openMember(senderThreadId, senderBranchId)}><span>{name(senderThreadId)}</span></button>
        {targetThreadId && <><Icon name="arrow-right" className="size-3 shrink-0" />
          <button type="button" title={name(targetThreadId)} onClick={() => openMember(targetThreadId, targetBranchId)}>
            {target && <AgentAvatar identity={target.thread_id} avatar={target.avatar} size={14} />}<span>{name(targetThreadId)}</span>
          </button></>}
      </div>
      <div className="chat-agent-message-bubble" data-expanded={expanded}>
        <button type="button" className="chat-agent-message-toggle" aria-expanded={expanded} aria-controls={regionId}
          aria-label={t(expanded ? 'chat.agentMessage.collapse' : 'chat.agentMessage.expand')}
          onClick={() => {
            const next = !expanded;
            choices?.set(key, next); setExpanded(next); if (next) setVisited(true);
          }}>
          <span className="chat-agent-message-heading"><span>{label}</span>{status}<Icon name="arrow-down-s" className="chat-agent-message-chevron size-3.5" /></span>
          {preview && <span className="chat-agent-message-preview-reveal" aria-hidden={expanded}>
            <span className="chat-agent-message-preview-inner"><span className="chat-agent-message-preview">{preview}</span></span>
          </span>}
        </button>
        <div id={regionId} className="chat-agent-message-reveal" aria-hidden={!expanded} inert={!expanded ? true : undefined}>
          <div className="chat-agent-message-reveal-inner"><div className="chat-agent-message-content" tabIndex={expanded ? 0 : -1}
            role="region" aria-label={label} data-conversation-tool-scroll="true">
            {visited && children}
          </div></div>
        </div>
      </div>
    </div>
  </article>;
}
