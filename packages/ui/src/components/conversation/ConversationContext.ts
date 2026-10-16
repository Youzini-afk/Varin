import React from 'react';
import type { ThreadIdentity, ThreadsAPI, ThreadMemoryAPI, ThreadFileTarget } from '@varin/application-client';
import type { ChatToolExecutionState } from './types';
import type { ChatToolCall, ChatToolResultMessage } from './types';
export interface UiCardProjection { call: ChatToolCall; result?: ChatToolResultMessage; compact: boolean }

export interface ConversationPresentation {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  head: string | null;
  toolExecutions: Record<string, ChatToolExecutionState>;
  uiCards?: Record<string, UiCardProjection>;
  sourceEntry?(callId: string): string | undefined;
  outputDurationsMs?: Record<string, number>;
  quote(text: string): void;
  openFile(callId: string, path: string, line?: number): Promise<void>;
  fileTarget(callId: string, path: string): Promise<Extract<ThreadFileTarget, { kind: 'document' }>>;
  memory?: ThreadMemoryAPI;
  renderExtras?(itemId: string): React.ReactNode;
}
/** Presentation-only examples never activate extension renderers or file links. */
export const ConversationPreviewContext = React.createContext(false);
export const ConversationContext = React.createContext<ConversationPresentation | null>(null);
/** Read-only renderers can be mounted in settings without an execution owner. */
export function useOptionalConversationPresentation() {
  return React.useContext(ConversationContext);
}
export function useConversationPresentation() {
  const value = React.useContext(ConversationContext);
  if (!value) throw new Error('Conversation presentation is not mounted');
  return value;
}
