import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
export interface ReferenceSourceTarget {
  entryId: string;
  start?: number;
  end?: number;
  /** Exact frozen source slice, used to reject changed content rather than mislocate it. */
  text?: string;
  toolCallId?: string;
  viewRef?: string;
  revisionRef?: string;
}
/** Navigation in the enclosing conversation, never a process-wide Thread selector. */
export interface ReferenceNavigation {
  identity: ThreadIdentity;
  revealEntry?: (id: string) => void | Promise<void>;
  revealSource?: (target: ReferenceSourceTarget) => Promise<void>;
}
export const ReferenceNavigationContext = React.createContext<ReferenceNavigation | null>(null);
