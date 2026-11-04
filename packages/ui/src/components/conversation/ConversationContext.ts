import React from 'react';
import type { ThreadIdentity, ThreadsAPI, ThreadMemoryAPI, ThreadFileTarget, ThreadSnapshot } from '@varin/application-client';
import type { ChatToolExecutionState } from './types';
import type { ChatToolCall, ChatToolResultMessage } from './types';
export interface UiCardProjection { call: ChatToolCall; result?: ChatToolResultMessage; compact: boolean }

export interface ConversationPresentation {
  readOnly?: boolean;
  api: ThreadsAPI;
  identity: ThreadIdentity;
  head: string | null;
  snapshot?: ThreadSnapshot;
  openSection?(section: 'plan' | 'recovery' | 'context' | 'threads'): void;
  /** File references are relative to this conversation, not sidebar navigation. */
  fileDirectory?: string;
  toolExecutions: Record<string, ChatToolExecutionState>;
  uiInlineViews?: boolean;
  uiEmbeds?: Record<string, import('@/lib/interactive-ui/embed-projection').UiEmbedPlacement>;
  uiCards?: Record<string, UiCardProjection>;
  sourceEntry?(callId: string): string | undefined;
  outputDurationsMs?: Record<string, number>;
  quote(text: string): void;
  revealQuestion?(operationId: string): void;
  openContext?(jobRunId?: string): void;
  openFile(callId: string, path: string, line?: number): Promise<void>;
  fileTarget(callId: string, path: string): Promise<Extract<ThreadFileTarget, { kind: 'document' }>>;
  memory?: ThreadMemoryAPI;
  followups?: readonly import('@varin/protocol').Followup[];
  renderExtras?(itemId: string, options?: { hideImages?: boolean }): React.ReactNode;
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
