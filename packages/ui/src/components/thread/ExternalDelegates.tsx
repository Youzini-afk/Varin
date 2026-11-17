import React from 'react';
import { createExternalAgentsHttpAPI, type ExternalDelegation } from '@varin/application-client';
import {
  useExternalAgents,
  useExternalAgentStore,
  openConversationFromNavigation,
} from '@/stores/useExternalAgentStore';
import { HarnessIcon } from './HarnessIcon';
import { ChildState } from '@/components/conversation/childPresentation';
import { ChatAgentMessageBubble } from '@/components/conversation/ChatAgentMessageBubble';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';

export function ExternalDelegateList({ parentThreadId }: { parentThreadId: string }) {
  useExternalAgents();
  const children = useExternalAgentStore((state) => state.children),
    conversations = useExternalAgentStore((state) => state.conversations);
  const latest = [
    ...new Map(
      children
        .filter((child) => child.parentThreadId === parentThreadId && child.messageKind !== 'inform')
        .map((child) => [child.conversationId, child]),
    ).values(),
  ];
  return (
    <>
      {latest.map((child) => (
        <button
          key={child.operationId}
          type="button"
          disabled={!conversations.some((c) => c.id === child.conversationId)}
          className="thread-overview-action typography-meta"
          onClick={() => void openConversationFromNavigation({ threadId: child.conversationId })}
        >
          <HarnessIcon harness={child.harness} profileId={conversations.find(c => c.id === child.conversationId)?.profileId} configurationId={child.configurationId ?? conversations.find(c => c.id === child.conversationId)?.configurationId} className="size-[22px]" />
          <span className="min-w-0 flex-1 truncate">{child.name}</span>
          <ChildState state={child.state} />
        </button>
      ))}
    </>
  );
}

export function ExternalDelegationMessage({
  child,
  report = false,
}: {
  child: ExternalDelegation;
  report?: boolean;
}) {
  const { t } = useI18n();
  const [view, setView] = React.useState<{ task: string; answer?: string; detail?: string }>();
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    const controller = new AbortController();
    void createExternalAgentsHttpAPI()
      .childPresentation(child.operationId, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setView(value);
        },
        (error) => {
          if (!controller.signal.aborted) setError(String(error));
        },
      );
    return () => controller.abort();
  }, [child.operationId, child.reportReady]);
  const text = report
    ? [view?.answer, view?.detail].filter(Boolean).join('\n\n')
    : (view?.task ?? child.name);
  return (
    <ChatAgentMessageBubble
      id={`external-${report ? 'report' : 'task'}:${child.operationId}`}
      kind={report ? 'report' : child.messageKind === 'inform' ? 'message' : 'task'}
      text={text}
      senderThreadId={report ? child.conversationId : child.parentThreadId}
      targetThreadId={report ? child.parentThreadId : child.conversationId}
      status={<ChildState state={child.state} />}
    >
      {error ? (
        <p role="alert" className="text-destructive typography-meta">
          {error}
        </p>
      ) : view ? (
        <MarkdownRenderer
          content={text}
          messageId={`external-message:${child.operationId}:${report}`}
          variant="assistant"
        />
      ) : (
        <p className="text-muted-foreground typography-meta">{t('common.loading')}</p>
      )}
    </ChatAgentMessageBubble>
  );
}
