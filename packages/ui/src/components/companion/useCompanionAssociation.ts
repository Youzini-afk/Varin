import { useCallback, useEffect, useState } from 'react';
import type { BotSummary, BotsAPI } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { companionAssociation, COMPANION_CHOICE_KEY, readCompanionChoice, type CompanionChoice } from './companionAssociation';

const storedChoice = (): CompanionChoice => {
  try { return readCompanionChoice(window.localStorage.getItem(COMPANION_CHOICE_KEY)); } catch { return null; }
};

/** The Host's Bot catalog plus the user's stored choice. Reading never creates a Bot.
 * `refreshKey` re-reads the catalog (for example when the user opens the controls). */
export function useCompanionAssociation(api: BotsAPI | undefined, generation: number, refreshKey: unknown) {
  const [catalog, setCatalog] = useState<{ generation: number; bots: BotSummary[] } | null>(null);
  const [choice, setChoice] = useState<CompanionChoice>(storedChoice);
  useEffect(() => {
    if (!api) return;
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void api.list(request.signal).then(bots => { if (!request.signal.aborted) setCatalog({ generation, bots }); },
        // A failed read keeps the last catalog of this Host; a new Host stays unknown.
        () => { if (!request.signal.aborted) setCatalog(current => current?.generation === generation ? current : null); });
    };
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'bot-changed' || event.type === 'stream-ready') refresh();
    });
    refresh();
    return () => { unsubscribe(); pending?.abort(); };
  }, [api, generation, refreshKey]);
  useEffect(() => {
    // Another window of the same origin can change the choice.
    const changed = (event: StorageEvent) => { if (event.key === COMPANION_CHOICE_KEY) setChoice(storedChoice()); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const choose = useCallback((botId: string | null) => {
    const next = { botId };
    try { window.localStorage.setItem(COMPANION_CHOICE_KEY, JSON.stringify(next)); } catch { /* The choice still applies to this window. */ }
    setChoice(next);
  }, []);
  const bots = !api ? [] : catalog?.generation === generation ? catalog.bots.filter(bot => !bot.archived && !bot.deletion) : null;
  return { association: companionAssociation(!api ? [] : bots, choice), bots: bots ?? [], choice, choose };
}
