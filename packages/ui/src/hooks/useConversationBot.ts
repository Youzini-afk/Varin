import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type BotSummary } from '@varin/application-client';
import { getBot } from '@/lib/bots';
import { subscribeVarinEvents } from '@/lib/varinEvents';

/** The same Bot profile drives a direct conversation in every Shell. */
export function useConversationBot(botId?: string | null) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [state, setState] = React.useState<{ botId: string; host: number; bot: BotSummary | null; error?: string }>();
  React.useEffect(() => {
    if (!botId) return;
    const controller = new AbortController(); let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void getBot(botId, controller.signal).then(bot => {
        if (!controller.signal.aborted && request === sequence && host === getRuntimeEndpointGeneration()) setState({ botId, host, bot,
          ...(!bot ? { error: 'This conversation’s Bot is no longer available' } : {}) });
      }, error => {
        if (!controller.signal.aborted && request === sequence && host === getRuntimeEndpointGeneration()) setState({ botId, host, bot: null, error: error instanceof Error ? error.message : 'Bot profile is unavailable' });
      });
    };
    refresh();
    const unsubscribe = subscribeVarinEvents(event => { if (event.type === 'stream-ready' || event.type === 'bot-changed' && event.botId === botId) refresh(); });
    return () => { controller.abort(); unsubscribe(); };
  }, [botId, host]);
  const selected = state && state.botId === botId && state.host === host ? state : undefined;
  return { bot: selected?.bot, error: selected?.error, loading: Boolean(botId && !selected) };
}
