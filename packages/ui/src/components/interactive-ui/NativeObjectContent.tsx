import React from 'react';
import { useI18nStore } from '@/lib/i18n/store';
import { getRuntimeEndpointGeneration, type ThreadPlanState } from '@varin/application-client';
import { useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { ChildState } from '@/components/conversation/childPresentation';
import { useThreadStore } from '@/stores/useThreadStore';
import { useThreadContextUsageStore, contextUsageKey } from '@/stores/useThreadContextUsageStore';
import { useNativeObjectOpener } from '@/lib/interactive-ui/native-object-actions';
import { resolveNativeObject, type NativeObject } from '@/lib/interactive-ui/native-objects';
import { nativePlanObservation } from '@/lib/interactive-ui/native-plan';

const empty: { plan?: ThreadPlanState; error?: string } = {};
const noSubscription = () => () => {};
const emptySnapshot = () => empty;
function useNativeFacts(ref: string) {
  const conversation = useOptionalConversationPresentation();
  const threads = useThreadStore(state => state.threads);
  const usage = useThreadContextUsageStore(state => conversation ? state.views[contextUsageKey(conversation.identity)]?.usage : undefined);
  const host = getRuntimeEndpointGeneration();
  const observer = React.useMemo(() => ref.startsWith('plan:') && conversation?.api.plan
    ? nativePlanObservation(conversation.api.plan, conversation.identity, host) : undefined,
  [ref, conversation?.api.plan, conversation?.identity, host]);
  const plan = React.useSyncExternalStore(observer?.subscribe ?? noSubscription, observer?.getSnapshot ?? emptySnapshot, observer?.getSnapshot ?? emptySnapshot);
  return { conversation, facts: { snapshot: conversation?.snapshot, threads, usage, plan: plan.plan, planError: plan.error } };
}
function ObjectLabel({ object }: { object: NativeObject }) {
  return <>{object.kind === 'thread' && <AgentAvatar identity={object.threadId} avatar={object.avatar} size={22} />}
    <span className="min-w-0 flex-1 truncate">{object.title}</span>
    {'state' in object && object.state && <ChildState state={object.state} />}</>;
}
export function NativeObjectContent({ refValue }: { refValue: string }) {
  useI18nStore(state => state.dictionary);
  const { facts } = useNativeFacts(refValue);
  const object = resolveNativeObject(refValue, facts);
  const open = useNativeObjectOpener();
  const [error, setError] = React.useState('');
  React.useEffect(() => setError(''), [refValue]);
  return <div className="my-2 min-w-0" data-native-object-ref={refValue}>
    {object.kind === 'unavailable' ? <p role="status" className="typography-meta text-muted-foreground">{object.title}</p>
      : <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left typography-meta hover:bg-interactive-hover" title={refValue}
        onClick={() => { setError(''); void open(refValue).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}><ObjectLabel object={object} /><span aria-hidden="true">↗</span></button>}
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
  </div>;
}
