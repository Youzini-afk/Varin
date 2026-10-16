import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
/** Navigation in the enclosing conversation, never a process-wide Thread selector. */
export interface ReferenceNavigation { identity: ThreadIdentity; revealEntry?: (id: string) => void | Promise<void> }
export const ReferenceNavigationContext = React.createContext<ReferenceNavigation | null>(null);
