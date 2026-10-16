import { useOptionalConversationPresentation } from './ConversationContext';
export function EntryExtras({ itemId }: { itemId?: string }) {
  const context = useOptionalConversationPresentation();
  return itemId ? context?.renderExtras?.(itemId) : null;
}
