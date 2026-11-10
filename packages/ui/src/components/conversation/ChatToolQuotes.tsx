import React from 'react';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { useOptionalConversationPresentation } from './ConversationContext';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { captureToolReference, addChatObjectReference, useChatQuoteObject, useChatQuoteGroup } from './chatQuoteObjects';

export function ChatToolQuote({ call, execution, executionById, result, generating, children }: React.PropsWithChildren<{
  call: ChatToolCall; execution?: ChatToolExecutionState; executionById?: Record<string, ChatToolExecutionState>; result?: ChatToolResultMessage; generating?: boolean;
}>) {
  const conversation = useOptionalConversationPresentation();
  const { t } = useI18n();
  const capture = React.useCallback(() => captureToolReference(conversation!.identity, call, execution, result, generating,
    conversation?.sourceEntry?.(call.id), executionById), [conversation, call, execution, executionById, result, generating]);
  const attach = useChatQuoteObject(conversation ? capture : undefined);
  if (!conversation) return <>{children}</>;
  return <div ref={attach} data-chat-quote-object data-chat-tool-call-id={call.id} className="group/quote relative min-w-0">
    {children}
    <button type="button" data-chat-quote-action aria-label={t('chat.context.quoteTool')} title={t('chat.context.quoteTool')}
      className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover focus-visible:outline-2 focus-visible:outline-primary"
      onClick={() => void addChatObjectReference(conversation.identity, capture(), conversation.api).catch(error => toast.error(error instanceof Error ? error.message : String(error)))}><Icon name="chat-quote" className="size-3.5" /></button>
  </div>;
}

/** A folded group offers its actual calls one by one, never a synthetic result. */
export function ChatToolQuoteGroup({ calls, executionById, resultByCallId, generatingCallIds, children }: React.PropsWithChildren<{
  calls: ChatToolCall[]; executionById: Record<string, ChatToolExecutionState>; resultByCallId: ReadonlyMap<string, ChatToolResultMessage>; generatingCallIds?: ReadonlySet<string>;
}>) {
  const conversation = useOptionalConversationPresentation();
  const { t } = useI18n();
  const capture = React.useCallback(() => calls.map(call => captureToolReference(conversation!.identity,
    call, executionById[call.id], resultByCallId.get(call.id), generatingCallIds?.has(call.id), conversation?.sourceEntry?.(call.id), executionById)),
    [conversation, calls, executionById, resultByCallId, generatingCallIds]);
  const attach = useChatQuoteGroup(conversation ? capture : undefined);
  return <div ref={attach} data-chat-quote-group data-chat-tool-call-ids={JSON.stringify(calls.map(call => call.id))} className="relative min-w-0">{children}
    {conversation && <button type="button" data-chat-more className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover"
      aria-label={t('chat.context.quoteTool')} title={t('chat.context.quoteTool')} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
      }}><Icon name="more" className="size-3.5" /></button>}
  </div>;
}
