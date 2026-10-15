import React from 'react';
import type { ChatMemoryPassage } from '@varin/application-client';
import { MemoryDraftDialog } from '../thread/ThreadMemorySelection';
import { useConversationPresentation } from './ConversationContext';
export function ChatMemoryDialog({ sources, onClose }: { sessionId: string; sources: ChatMemoryPassage[]; onClose(): void }) {
  const { memory, identity, head } = useConversationPresentation();
  const [selection] = React.useState(() => ({ ...identity, headId: head! }));
  const passages = React.useMemo(() => sources.map(({ entryId, ...source }) => ({ ...source, itemId: entryId })), [sources]);
  return memory && head ? <MemoryDraftDialog api={memory} selection={selection} sources={passages} onClose={onClose} /> : null;
}
