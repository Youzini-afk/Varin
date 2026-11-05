import React from 'react';
import { createConversationContentParser } from '@varin/application-client';
import { ChatTextSourceContext } from '@/components/conversation/chatTextSourceContext';
import { ConversationPreviewContext } from '@/components/conversation/ConversationContext';
import { DeclarativeUiContent } from './DeclarativeUiContent';

/** React owns controls; the Markdown DOM owner only receives original prose slices. */
export function ConversationContent({ content, messageId, variant = 'assistant', isStreaming, renderMarkdown }: {
  content: string; messageId: string; variant?: string; isStreaming?: boolean;
  renderMarkdown(text: string, start: number, streaming: boolean): React.ReactNode;
}) {
  const source = React.useContext(ChatTextSourceContext);
  const preview = React.useContext(ConversationPreviewContext);
  // Provider part identity survives the transient-to-history handoff. Its parser
  // and complete definitions must survive too, especially while a field is focused.
  const parserIdentity = source?.contentIdentity ?? `${source?.entryId ?? messageId}:${source?.contentIndex ?? 0}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parser = React.useMemo(() => createConversationContentParser(), [parserIdentity]);
  const parts = React.useMemo(() => parser(content, { role: !preview && source?.role === 'assistant' && variant === 'assistant' ? 'assistant' : 'text', streaming: isStreaming }), [parser, content, variant, isStreaming, source?.role, preview]);
  return <>{parts.map(part => {
    if (part.kind === 'pending') return null;
    if (part.kind === 'ui') {
      // Native source parts are addressed locally; source.offset belongs only to text selection.
      const fragmentKey = `offset:${part.start}`;
      const sourceKey = source?.contentIdentity ? `${source.contentIdentity}:offset:${part.start}` : `${source?.entryId ?? messageId}:${source?.contentIndex ?? 0}:${fragmentKey}`;
      return <DeclarativeUiContent key={sourceKey} node={part.node} sourceKey={sourceKey} isStreaming={isStreaming}
        fragment={source?.entryId ? { messageId: source.entryId, fragmentKey, contentIndex: source.contentIndex } : undefined} />;
    }
    if (part.kind === 'invalid') return <pre key={part.start} className="whitespace-pre-wrap break-words text-sm my-3" data-invalid-interaction>{part.raw}</pre>;
    return <React.Fragment key={part.start}>{renderMarkdown(part.text, part.start, Boolean(isStreaming && part === parts.at(-1)))}</React.Fragment>;
  })}</>;
}
