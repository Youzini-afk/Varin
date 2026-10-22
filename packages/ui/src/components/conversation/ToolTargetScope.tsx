import React from 'react';
import type { ChatSessionEntry, ChatToolExecutionState } from './types';
import { ToolTargetContext, collectToolTargets, useToolTargets, type ToolTargets } from './toolTargetContext';

export function ToolTargetScope({ entries, executions, children }: React.PropsWithChildren<{
  entries: readonly ChatSessionEntry[]; executions: Record<string, ChatToolExecutionState>;
}>) {
  const parent = useToolTargets();
  const previous = React.useRef<ToolTargets | null>(null);
  const targets = React.useMemo(() => {
    if (parent) return parent;
    const next = collectToolTargets(entries, executions), old = previous.current;
    // Output/status deltas do not invalidate every other tool heading in this conversation.
    if (old && (['processes', 'children', 'threads'] as const).every(kind => next[kind].size === old[kind].size
      && [...next[kind]].every(([key, value]) => old[kind].get(key) === value))) return old;
    previous.current = next;
    return next;
  }, [parent, entries, executions]);
  return <ToolTargetContext.Provider value={targets}>{children}</ToolTargetContext.Provider>;
}
