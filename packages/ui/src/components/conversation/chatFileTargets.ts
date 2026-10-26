import React from 'react';
import type { VarinResourceReference } from '@varin/application-client';

export interface ChatFileResource { path: string; directory: string; resource?: VarinResourceReference }
export interface ChatFileTarget {
  path: string;
  directory?: string;
  runtimeKey: string;
  open(): void | Promise<void>;
  /** Captured by the link's own conversation, including nested retrieval sources. */
  resolve?(): Promise<ChatFileResource>;
}
export const ChatFileTargetsContext = React.createContext<Map<HTMLElement, ChatFileTarget> | null>(null);

export function useChatFileTarget(target: ChatFileTarget | null) {
  const targets = React.useContext(ChatFileTargetsContext);
  const previous = React.useRef<HTMLElement | null>(null);
  return React.useCallback((element: HTMLElement | null) => {
    if (previous.current) targets?.delete(previous.current);
    previous.current = element;
    if (element && target) targets?.set(element, target);
  }, [targets, target]);
}
