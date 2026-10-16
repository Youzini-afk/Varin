import { useI18n, type I18nKey } from '@/lib/i18n';
import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadUsage, UsageTokenCount } from '@varin/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { Button } from '@/components/ui/button';

const metrics = [['inputTokens', 'input'], ['outputTokens', 'output'], ['cachedInputTokens', 'cacheRead'], ['cacheWriteTokens', 'cacheWrite'], ['reasoningTokens', 'reasoning']] as const;
const kinds: Record<string, I18nKey> = { conversation: 'chat.usage.conversation', context: 'chat.usage.context', planning: 'chat.usage.planning', mcp_sampling: 'chat.usage.mcp_sampling', auxiliary: 'chat.usage.auxiliary' };
function tokenLabel(value: UsageTokenCount): string {
  if (value.known === null) return '—';
  if (!/^\d+$/.test(value.known)) return '—';
  return `${BigInt(value.known).toLocaleString()}${value.missing ? ' + ?' : ''}`;
}
/** Visible-demand projection of the original Catalog receipt metadata. */
export function ThreadTokenUsage({ active = true }: { active?: boolean }) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const owner = JSON.stringify([generation, identity?.threadId, identity?.branchId]);
  const [refresh, setRefresh] = React.useState(0);
  const [view, setView] = React.useState<{ owner: string; data?: ThreadUsage; error?: string }>({ owner: '' });
  React.useEffect(() => {
    if (!active || !identity || !api) { setView({ owner }); return; }
    let alive = true; let dirty = false; let loading: Promise<void> | undefined;
    const controller = new AbortController();
    const current = () => alive && generation === getRuntimeEndpointGeneration();
    const read = (): Promise<void> => {
      dirty = true; if (loading) return loading;
      loading = (async () => {
        while (dirty && current()) {
          dirty = false;
          const data = await api.usage(identity, controller.signal);
          if (data.threadId !== identity.threadId || data.branchId !== identity.branchId) throw new Error('Usage identity did not match the selected branch.');
          if (current()) setView({ owner, data });
        }
      })().finally(() => { loading = undefined; });
      return loading;
    };
    const fail = (error: unknown) => { if (current()) setView(previous => ({ ...(previous.owner === owner ? previous : { owner }), error: error instanceof Error ? error.message : 'Usage unavailable' })); };
    void (async () => {
      const first = await api.usage(identity, controller.signal);
      if (!current()) return;
      if (first.threadId !== identity.threadId || first.branchId !== identity.branchId) throw new Error('Usage identity did not match the selected branch.');
      setView({ owner, data: first });
      await api.observe(first.throughCursor, event => {
        if (current() && 'cursor' in event && 'kind' in event) void read().catch(fail);
      }, { signal: controller.signal });
      if (current()) fail(new Error('Usage updates disconnected. Refresh to reconnect.'));
    })().catch(fail);
    return () => { alive = false; controller.abort(); };
  }, [active, api, owner, generation, identity, refresh]);
  const shown = view.owner === owner ? view : undefined;
  return <section className="space-y-3 px-4 py-3" aria-label="Branch token usage">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{t('chat.usage.title')}</h3>
      {identity && <Button type="button" variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)}>{t('chat.mcp.refresh')}</Button>}
    </div>
    {!identity ? <p>Select a conversation to inspect usage.</p> : !api ? <p role="alert">Thread usage is unavailable.</p> : <>
      {shown?.error && <p role="alert">{shown.error}</p>}
      {!shown?.data && !shown?.error && <p role="status">{t('common.loading')}</p>}
      {shown?.data && <>
        {!shown.data.rows.length && <p>{t('chat.usage.empty')}</p>}
        {shown.data.rows.map(row => <div key={JSON.stringify([row.kind, row.providerId, row.providerFamily, row.modelId, row.measurement])} className="space-y-2 rounded bg-[var(--surface-muted)] p-3">
          <div><p className="font-medium break-words">{row.modelId}</p>
            <p className="text-xs text-muted-foreground">{row.providerId ?? row.providerFamily ?? 'Provider unavailable'} · {kinds[row.kind] ? t(kinds[row.kind]) : row.kind}</p>
            <p className="text-xs">{t('chat.usage.requests', { count: row.requests })} · {t(row.measurement === 'actual' ? 'chat.usage.actual' : row.measurement === 'estimated' ? 'chat.usage.estimated' : 'chat.usage.missing')}{row.pendingRequests > 0 ? ` · ${t('chat.usage.pending', { count: row.pendingRequests })}` : ''}</p>
          </div>
          <dl className="space-y-1 text-sm">{metrics.map(([key, label]) => <div key={key} className="flex justify-between gap-3"><dt>{t(`contextSidebar.tokens.${label}`)}</dt><dd className="text-right tabular-nums">{tokenLabel(row[key])}</dd></div>)}</dl>
        </div>)}
      </>}
    </>}
  </section>;
}
