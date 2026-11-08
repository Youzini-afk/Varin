import { parseConversationContent } from '@varin/application-client';
import type { ChatAssistantMessage, ChatSessionEntry, ChatTextContent } from '@/components/conversation/types';
import type { UiCardProjection } from '@/components/conversation/ConversationContext';
export interface UiEmbedPlacement { sessionId: string; primaryKey: string; sourceEntryId: string; ref: string }
interface ParsedEmbeds { text: string; streaming: boolean; embeds: Array<{ start: number; ref: string }> }
// HistoryPresentation retains immutable text parts while new stream frames arrive.
// Cache only parsed offsets/references, not placement or tool ownership. Weak keys
// release the derived data with its message and never retain a second text history.
const parsedEmbeds = new WeakMap<ChatTextContent, ParsedEmbeds>();
function embedReferences(part: ChatTextContent, streaming: boolean) {
  const cached = parsedEmbeds.get(part);
  if (cached?.text === part.text && cached.streaming === streaming) return cached.embeds;
  const embeds = parseConversationContent(part.text, { role: 'assistant', streaming }).flatMap(fragment =>
    fragment.kind === 'ui' && fragment.node.type === 'embed' ? [{ start: fragment.start, ref: fragment.node.ref }] : []);
  parsedEmbeds.set(part, { text: part.text, streaming, embeds });
  return embeds;
}
/** Resolve final placement before history mounts. Tool receipts remain intact. */
export function projectUiEmbeds(entries: readonly ChatSessionEntry[], cards: Record<string, UiCardProjection>, live?: ChatAssistantMessage) {
  const embeds: Record<string, UiEmbedPlacement> = {}, targets: Record<string, string> = {};
  let turn = 'history', pending: Array<{ key: string; ref: string; entryId: string }> = [], owners = new Map<string, string>();
  const flush = () => {
    const first = new Map<string, UiEmbedPlacement>();
    for (const item of pending) {
      const owner = owners.get(item.ref);
      const placement = first.get(item.ref) ?? { sessionId: owner ?? `embed:${turn}:${item.ref}`, primaryKey: item.key, sourceEntryId: item.entryId, ref: item.ref };
      first.set(item.ref, placement); embeds[item.key] = placement;
      targets[placement.sessionId] = placement.primaryKey;
    }
    pending = []; owners = new Map();
  };
  const text = (entryId: string, message: ChatAssistantMessage) => {
    message.content.forEach((part, contentIndex) => {
      if (part.type === 'toolCall') {
        const projected = cards[part.id], receipt = projected?.result?.details as { ref?: string } | undefined;
        if (receipt?.ref && !projected?.compact) owners.set(receipt.ref, part.id);
      }
      if (part.type !== 'text') return;
      for (const fragment of embedReferences(part, message.stopReason === 'pending')) {
        pending.push({ key: part.id ? `${part.id}:offset:${fragment.start}` : `${entryId}:${part.contentIndex ?? contentIndex}:offset:${fragment.start}`, ref: fragment.ref, entryId });
      }
    });
  };
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') { flush(); turn = entry.id; }
    if (entry.message.role === 'assistant') text(entry.id, entry.message);
  }
  if (live) text(live.id, live);
  flush();
  return { embeds, targets };
}
