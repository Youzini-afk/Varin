import { useOptionalConversationPresentation } from './ConversationContext';
export function EntryExtras({ itemId, hideImages }: { itemId?: string; hideImages?: boolean }) {
  const context = useOptionalConversationPresentation();
  return itemId ? context?.renderExtras?.(itemId, { hideImages }) : null;
}
