import React from 'react';
import { applyBotOrganizationChange, botOrganizationSections, emptyBotOrganization, getRuntimeEndpointGeneration, type BotOrganization, type BotOrganizationChange, type BotSummary } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useI18n } from '@/lib/i18n';

/** Each mounted surface observes the same Host record. Drafts and collapse preferences stay local. */
export function useBotOrganization(bots: readonly BotSummary[] | null, enabled = true) {
  const api = useRuntimeAPIs().bots?.organization;
  const { t } = useI18n();
  const [value, setValue] = React.useState<BotOrganization>(emptyBotOrganization);
  const [ready, setReady] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const current = React.useRef(value); current.current = value;
  const saving = React.useRef(false), changedWhileSaving = React.useRef(false);
  const request = React.useRef(0), alive = React.useRef(true);
  const invalidateReads = React.useCallback(() => { request.current++; }, []);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; invalidateReads(); }; }, [invalidateReads]);
  const refresh = React.useCallback(async () => {
    if (!api || !enabled) return;
    if (saving.current) { changedWhileSaving.current = true; return; }
    const sequence = ++request.current, host = getRuntimeEndpointGeneration();
    try {
      const result = await api.read();
      if (!alive.current || sequence !== request.current || host !== getRuntimeEndpointGeneration()) return;
      current.current = result; setValue(result); setReady(true); setError(null);
    } catch (cause) {
      if (alive.current && sequence === request.current && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, enabled]);
  React.useEffect(() => { void refresh(); return invalidateReads; }, [refresh, invalidateReads]);
  React.useEffect(() => enabled ? subscribeVarinEvents(event => {
    if (event.type === 'bot-organization-changed' || event.type === 'stream-ready') void refresh();
  }) : undefined, [enabled, refresh]);
  const change = async (change: BotOrganizationChange): Promise<boolean> => {
    if (!api || !ready || saving.current || !bots) return false;
    const before = current.current, host = getRuntimeEndpointGeneration();
    let optimistic: BotOrganization;
    try { optimistic = applyBotOrganizationChange(before, change, bots.map(bot => bot.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    saving.current = true; request.current++; setPending(true); setError(null);
    current.current = optimistic; setValue(optimistic);
    const stillHere = () => alive.current && host === getRuntimeEndpointGeneration();
    let success = false;
    try {
      const result = await api.update({ expectedRevision: before.revision, change });
      if (!stillHere()) return false;
      current.current = result; setValue(result); success = true;
    } catch (cause) {
      if (!stillHere()) return false;
      // Observe the committed state after an uncertain response; never replay a move or creation.
      let restored = before;
      try { restored = await api.read(); } catch { /* Keep the previous confirmed record until retry. */ }
      if (!stillHere()) return false;
      current.current = restored; setValue(restored);
      setError(cause && typeof cause === 'object' && 'status' in cause && cause.status === 409 ? t('bot.groups.conflict') : cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      if (stillHere()) {
        setPending(false);
        const refreshNeeded = changedWhileSaving.current; changedWhileSaving.current = false;
        if (refreshNeeded && success) void refresh();
      }
    }
    return success;
  };
  return { value, sections: botOrganizationSections(bots ?? [], value), ready: ready && bots !== null, pending, error, refresh, change };
}
export type BotOrganizationController = ReturnType<typeof useBotOrganization>;
