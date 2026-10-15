import React from 'react';
import type { ThreadIdentity, ThreadsAPI, ThreadMemoryAPI, ThreadFileTarget } from '@varin/application-client';
import type { ChatToolExecutionState } from './types';

export interface ConversationPresentation {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  head: string | null;
  toolExecutions: Record<string, ChatToolExecutionState>;
  outputDurationsMs?: Record<string, number>;
  quote(text: string): void;
  openFile(callId: string, path: string, line?: number): Promise<void>;
  fileTarget(callId: string, path: string): Promise<Extract<ThreadFileTarget, { kind: 'document' }>>;
  memory?: ThreadMemoryAPI;
  renderExtras?(itemId: string): React.ReactNode;
}
export const ConversationContext = React.createContext<ConversationPresentation | null>(null);
export function useConversationPresentation() {
  const value = React.useContext(ConversationContext);
  if (!value) throw new Error('Conversation presentation is not mounted');
  return value;
}
