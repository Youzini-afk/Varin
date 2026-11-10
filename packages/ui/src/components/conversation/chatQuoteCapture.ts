import { parseConversationContent, type ChatMemoryPassage } from '@varin/application-client';
import type { ChatAssistantMessage, ChatSessionEntry } from './types';

/** Explicit turn capture reads real messages in order, excluding controls/thinking/tools. */
export function captureAssistantTurn(entries: readonly ChatSessionEntry[], live?: ChatAssistantMessage | null) {
  const parts: string[] = [], passages: ChatMemoryPassage[] = [];
  const capture = (message: ChatAssistantMessage, entryId?: string) => {
    let offset = 0;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      for (const segment of parseConversationContent(part.text, { role: 'assistant', streaming: message === live })) {
        if (segment.kind !== 'markdown') continue;
        if (segment.text.trim()) {
          const text = segment.text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/gu, '');
          const leading = segment.text.match(/^(?:\r?\n)+/u)?.[0].length ?? 0;
          parts.push(text);
          if (entryId) passages.push({ entryId, start: offset + segment.start + leading, text });
        }
      }
      offset += part.text.length + 1;
    }
  };
  for (const entry of entries) if (entry.type === 'message' && entry.message.role === 'assistant') capture(entry.message, entry.id);
  if (live) capture(live, live.id);
  return { text: parts.join('\n\n'), passages, streaming: Boolean(live), capturedAt: new Date().toISOString() };
}
