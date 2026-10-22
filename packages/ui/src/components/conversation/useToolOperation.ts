import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { Operation } from '@varin/protocol';
import { useOptionalConversationPresentation } from './ConversationContext';

/** Inspect and control the original accepted operation, never replay its tool call. */
export function useToolOperation(operationId: string | undefined, projected?: Operation) {
  const conversation = useOptionalConversationPresentation();
  const api = conversation?.api, identity = conversation?.identity;
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const key = [host, identity?.threadId, identity?.branchId, operationId].join(':');
  const current = React.useRef(key); current.current = key;
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [state, setState] = React.useState<{ key: string; operation?: Operation; busy?: boolean; cancelRequested?: boolean; error?: string }>({ key });
  const live = operationId ? Object.values(conversation?.toolExecutions ?? {}).find(value => value.operationId === operationId)?.operation ?? projected : undefined;
  const belongs = (value?: Operation) => value?.id === operationId;
  const loaded = state.key === key ? state.operation : undefined;
  const operation = belongs(live) && (!belongs(loaded) || live!.revision >= loaded!.revision) ? live : belongs(loaded) ? loaded : undefined;
  const lock = React.useRef<string | undefined>(undefined);
  const update = async (cancel = false) => {
    if (!api || !identity || !operationId || lock.current === key || (cancel && conversation.readOnly)) return;
    lock.current = key; setState(previous => ({ ...(previous.key === key ? previous : {}), key, busy: true, error: undefined }));
    const valid = () => mounted.current && current.current === key && host === getRuntimeEndpointGeneration();
    try {
      const original = await api.operation(operationId);
      const run = await api.run(original.run_id);
      if (!valid()) return;
      if (original.id !== operationId || run.thread_id !== identity.threadId || run.branch_id !== identity.branchId)
        throw new Error('The original operation belongs to another conversation or branch');
      if (cancel) {
        await api.cancelOperation(operationId);
        if (valid()) setState(previous => ({ ...previous, key, cancelRequested: true }));
      }
      const value = cancel ? await api.operation(operationId) : original;
      if (valid() && belongs(value)) setState(previous => ({ ...previous, key, operation: value, busy: false }));
    } catch (failure) {
      if (valid()) setState(previous => ({ ...previous, key, error: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      if (lock.current === key) lock.current = undefined;
      if (valid()) setState(previous => ({ ...previous, busy: false }));
    }
  };
  return { operation, refresh: () => update(), cancel: () => update(true), available: Boolean(api && operationId),
    readOnly: !conversation || conversation.readOnly, busy: state.key === key && state.busy,
    cancelRequested: operation?.cancel_requested || state.key === key && state.cancelRequested, error: state.key === key ? state.error : undefined };
}
