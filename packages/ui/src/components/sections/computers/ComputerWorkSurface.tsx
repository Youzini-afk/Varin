import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { listComputers, type ComputerCatalog } from '@/lib/computers';
import { ComputerDesktopPane } from '@/components/sections/computers/ComputerDesktopView';
import type { ComputerDesktop } from '@varin/protocol';

/**
 * Computer workbench surface (BC8): the shared desktop view/control model as
 * a first-class context-panel tab — the same frame stream, ownership, and
 * takeover/handback semantics the settings dialog uses. The chosen desktop
 * persists on the tab (targetPath) so the surface survives navigation.
 */
export function ComputerWorkSurface({ directory, tabID }: { directory: string; tabID: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const tab = useUIStore((state) => state.contextPanelByDirectory[directory]?.tabs.find((entry) => entry.id === tabID));
  const setTabTarget = useUIStore((state) => state.setContextPanelTabTargetPath);
  const [catalogState, setCatalog] = React.useState<{ host: number; catalog: ComputerCatalog } | null>(null);
  const catalog = catalogState?.host === host ? catalogState.catalog : null;
  const read = React.useRef(0);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const request = ++read.current;
    try {
      const catalog = await listComputers();
      if (host !== getRuntimeEndpointGeneration() || request !== read.current) return;
      setCatalog({ host, catalog }); setError(null);
    } catch (cause) {
      if (host === getRuntimeEndpointGeneration() && request === read.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [host]);

  React.useEffect(() => { setError(null); void refresh(); return () => { read.current += 1; }; }, [refresh]);

  const desktops = React.useMemo(() => catalog?.desktops ?? [], [catalog]);
  const selectedId = tab?.targetPath ?? null;
  const selected: ComputerDesktop | null = selectedId
    ? desktops.find((desktop) => desktop.id === selectedId) ?? null
    : null;

  const usageThread = useThreadStore(state => { const work = selected?.usage?.execution.work; return work?.runtime === 'agent' ? state.threads.find(thread => thread.thread_id === work.threadId) : undefined; });

  // Default to the catalog default / sole desktop on first open.
  React.useEffect(() => {
    if (!catalog || selectedId) return;
    const fallback = catalog.defaultDesktopId
      ?? (desktops.length === 1 ? desktops[0]!.id : null);
    if (fallback) setTabTarget(directory, tabID, fallback);
  }, [catalog, desktops, selectedId, directory, tabID, setTabTarget]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <Select
          value={selectedId ?? 'none'}
          onValueChange={(value) => setTabTarget(directory, tabID, value === 'none' ? '' : value)}
        >
          <SelectTrigger size="settings" className="w-64" aria-label={t('contextPanel.computer.desktopLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {desktops.length === 0 ? (
              <SelectItem value="none" disabled>{t('contextPanel.computer.empty')}</SelectItem>
            ) : desktops.map((desktop) => (
              <SelectItem key={desktop.id} value={desktop.id} disabled={desktop.status === 'stopped'}>
                {desktop.label} — {desktop.machineId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          className="typography-meta text-muted-foreground hover:text-foreground"
          onClick={() => { void refresh(); }}
        >
          {t('settings.harness.retry')}
        </button>
      </div>
      {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
      {selected?.usage?.execution.work.runtime === 'agent' && <button type="button" className="typography-meta break-all text-left text-muted-foreground hover:text-foreground"
        onClick={() => { const work = selected.usage?.execution.work; if (work?.runtime === 'agent') void openThreadFromNavigation(work); }}>
        {usageThread?.title || selected.usage.execution.work.threadId} · {selected.usage.execution.runId}
      </button>}
      {selected ? (
        <ComputerDesktopPane key={selected.id} desktop={selected} />
      ) : catalog ? (
        <div className="flex h-full items-center justify-center">
          <p className="typography-meta text-muted-foreground max-w-sm text-center">
            {desktops.length === 0 ? t('contextPanel.computer.empty') : t('contextPanel.computer.pick')}
          </p>
        </div>
      ) : (
        <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>
      )}
    </div>
  );
}
