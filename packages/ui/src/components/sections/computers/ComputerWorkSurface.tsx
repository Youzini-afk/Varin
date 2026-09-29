import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
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
  const tab = useUIStore((state) => state.contextPanelByDirectory[directory]?.tabs.find((entry) => entry.id === tabID));
  const setTabTarget = useUIStore((state) => state.setContextPanelTabTargetPath);
  const [catalog, setCatalog] = React.useState<ComputerCatalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setCatalog(await listComputers());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const desktops = React.useMemo(() => catalog?.desktops ?? [], [catalog]);
  const selectedId = tab?.targetPath ?? null;
  const selected: ComputerDesktop | null = selectedId
    ? desktops.find((desktop) => desktop.id === selectedId) ?? null
    : null;

  // Work association (BC8): the last agent session that drove this desktop,
  // stamped by the Host service. Projection only — work state lives on the
  // session's Thread/Run records.
  const usageSession = usePiSessionStore((state) => {
    const sessionId = selected?.usage?.sessionId;
    return sessionId ? state.summaries.find((summary) => summary.id === sessionId) ?? null : null;
  });

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
      {selected?.usage ? (
        <button
          type="button"
          className="typography-meta text-muted-foreground hover:text-foreground text-left"
          onClick={() => { void openPiSessionFromNavigation({ sessionId: selected.usage!.sessionId }); }}
        >
          {t('contextPanel.computer.lastSession')}: {usageSession?.name || usageSession?.firstMessage?.slice(0, 60) || selected.usage.sessionId}
        </button>
      ) : null}
      {selected ? (
        <ComputerDesktopPane desktop={selected} />
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
