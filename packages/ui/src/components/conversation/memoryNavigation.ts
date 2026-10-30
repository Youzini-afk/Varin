import React from 'react';

/**
 * Where a memory written in the conversation can be looked at. The Bot workbench provides this
 * to open its memory tab on the written item (docs/design/bot-ui.md §4); elsewhere it is absent.
 */
export interface MemoryNavigation {
  /** `id` is the memory row when the receipt names one. */
  open(id: string | null): void;
  label: string;
}

export const MemoryNavigationContext = React.createContext<MemoryNavigation | null>(null);
