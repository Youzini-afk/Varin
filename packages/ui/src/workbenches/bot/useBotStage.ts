import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadsAPI } from '@varin/application-client';
import { useCompanionAttention } from '@/components/companion/useCompanionAttention';
import type { ThreadLiveActivity } from '@/components/thread/threadLiveActivity';
import { BotStageDirector, EMPTY_STAGE, type BotLiveRound, type BotStageEvent, type BotStageView } from './botStageDirector';
import { botToolSubject, botToolUnits } from './botStageTools';

/** Enough recent moments for a figure that mounts late to skip them; each plays once by id. */
const KEEP_MOMENTS = 24;

/** The open conversation's round in the few words the stage needs; equal rounds compare equal. */
export function liveRound(activity: ThreadLiveActivity | null): BotLiveRound | null {
  if (!activity) return null;
  return {
    threadId: activity.identity.threadId, branchId: activity.identity.branchId, runId: activity.runId, text: activity.text,
    tools: activity.tools.map(tool => ({ name: tool.name, subject: botToolSubject(tool.name, tool.arguments), units: botToolUnits(tool.name, tool.arguments) })),
  };
}
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export interface BotStageState {
  view: BotStageView;
  moments: readonly { id: number; event: BotStageEvent }[];
  /** For the open conversation: ThreadConversation `onActivity`. */
  onActivity: (activity: ThreadLiveActivity | null) => void;
}

/**
 * The selected Bot's stage facts (botStageDirector), fed by the Host's attention read and the open
 * conversation's live round. The attention stream runs only while the Bot workbench is shown.
 */
export function useBotStage({ threads, botId, enabled, preferThreadId }: {
  threads: ThreadsAPI | undefined; botId: string | null; enabled: boolean; preferThreadId: string | null;
}): BotStageState {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const source = enabled && typeof threads?.attention === 'function' && typeof threads.observe === 'function' ? threads : undefined;
  const attention = useCompanionAttention(source, generation);
  const [live, setLive] = React.useState<BotLiveRound | null>(null);
  const onActivity = React.useCallback((activity: ThreadLiveActivity | null) => {
    const next = liveRound(activity);
    setLive(current => same(current, next) ? current : next);
  }, []);
  const director = React.useRef<BotStageDirector | null>(null);
  director.current ??= new BotStageDirector();
  const ids = React.useRef(0);
  const [stage, setStage] = React.useState<{ view: BotStageView; moments: { id: number; event: BotStageEvent }[] }>({ view: EMPTY_STAGE, moments: [] });
  const snapshot = source ? attention.snapshot : null;
  React.useEffect(() => {
    const { view, events } = director.current!.observe({ snapshot, botId: enabled ? botId : null, live, preferThreadId, now: Date.now() });
    const added = events.map(event => ({ id: ++ids.current, event }));
    setStage(current => !added.length && same(current.view, view) ? current : { view, moments: [...current.moments, ...added].slice(-KEEP_MOMENTS) });
  }, [snapshot, botId, enabled, live, preferThreadId]);
  return { view: stage.view, moments: stage.moments, onActivity };
}
