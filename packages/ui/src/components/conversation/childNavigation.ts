import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';

/**
 * Where a dispatched member's conversation opens. The ordinary workbench shows it in its
 * collaboration panel; the Bot workbench provides this to open the original conversation in
 * the ordinary workbench instead (docs/design/bot-ui.md §4, §6).
 */
export interface ChildNavigation {
  open(child: ThreadIdentity): void;
  label: string;
}

export const ChildNavigationContext = React.createContext<ChildNavigation | null>(null);
