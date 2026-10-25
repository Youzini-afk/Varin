import React from 'react';
import type { ThreadIdentity, ThreadNextStep, ThreadsAPI } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export function useThreadNextStep(api: ThreadsAPI, identity: ThreadIdentity, input: {
  owner: string; runId?: string; headId?: string | null; eligible: boolean;
}) {
  const { owner, runId, headId, eligible } = input;
  const { runtime, threadId, branchId } = identity;
  const key = JSON.stringify([owner, threadId, branchId, runId, headId]);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<{ key: string; revision: number; value: ThreadNextStep }>();
  const [consumed, setConsumed] = React.useState<string>();
  React.useEffect(() => subscribeVarinEvents(event => {
    if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings') refresh();
  }), []);
  React.useEffect(() => {
    if (!eligible || !runId || !headId || !api.nextStep || consumed === key) return;
    const controller = new AbortController();
    void api.nextStep({ runtime, threadId, branchId }, { runId, headId }, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ key, revision, value });
    }, () => {
      if (!controller.signal.aborted) setResult({ key, revision, value: { status: 'unavailable', code: 'next-step-observation-failed' } });
    });
    return () => controller.abort();
  }, [api, runtime, threadId, branchId, key, revision, eligible, runId, headId, consumed]);
  const value = eligible && consumed !== key && result?.key === key && result.revision === revision ? result.value : undefined;
  return {
    text: value?.status === 'ready' && value.runId === runId && value.headId === headId ? value.text : undefined,
    error: value?.status === 'unavailable' ? value.code : undefined,
    consume: () => setConsumed(key),
  };
}
