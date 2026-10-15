import { useConversationPresentation } from './ConversationContext';
export function EntryExtras({ itemId }: { itemId?: string }) {
  const context = useConversationPresentation();
  return itemId ? context.renderExtras?.(itemId) : null;
}
