import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { McpIcon } from '@/components/icons/McpIcon';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import {
  refreshMcpSettingsAvailability,
  useMcpSettingsAvailabilityState,
} from '@/lib/settings/mcp-availability';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  parseMcpAdapterStatus,
  type McpAdapterServerStatus,
} from './mcpAdapterStatus';
import { refreshMcpCatalog, useMcpCatalogState } from './mcp-catalog-store';
import { McpServerStatusBadge } from './McpServerStatusBadge';

export const McpQuickPopover: React.FC = () => {
  const { t } = useI18n();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const availability = useMcpSettingsAvailabilityState();
  const catalogState = useMcpCatalogState();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const extensionState = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId
      ? state.records[sessionId]?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL]
      : undefined;
  });
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [open, setOpen] = React.useState(false);
  const status = React.useMemo(() => parseMcpAdapterStatus(extensionState), [extensionState]);
  const installed = availability.targetKey === targetKey && availability.installed === true;
  const catalog = catalogState.targetKey === targetKey ? catalogState.snapshot?.catalog : null;

  React.useEffect(() => {
    void refreshMcpSettingsAvailability(runtimeTarget, targetKey);
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    if (!open || !installed) return;
    void refreshMcpCatalog(runtimeTarget, targetKey);
  }, [installed, open, runtimeTarget, targetKey]);

  if (!installed) return null;

  const liveByName = new Map(status?.servers.map((server) => [server.name, server]) ?? []);
  const serverNames = [...new Set([
    ...(catalog?.servers.map((server) => server.name) ?? []),
    ...(status?.servers.map((server) => server.name) ?? []),
  ])].sort((left, right) => left.localeCompare(right));
  const triggerStatusClass = !status
    ? 'bg-muted-foreground'
    : status.servers.some((server) => server.status === 'failed')
      ? 'bg-[var(--status-error)]'
      : status.servers.some((server) => server.status === 'needs-auth')
        ? 'bg-[var(--status-warning)]'
        : status.connectedCount > 0
          ? 'bg-[var(--status-success)]'
          : 'bg-muted-foreground';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* Icon-only, so it sits in the workbench header action row like its neighbours. The MCP mark
          is the same one the Agent header's services tabs use, the name survives on `aria-label` and
          in the tooltip, and the status dot rides the corner of the icon because there is no longer
          a text label for it to trail. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="app-region-no-drag relative"
                aria-label={t('settings.page.mcp.title')}
              >
                <McpIcon className="size-4" />
                <span
                  aria-hidden="true"
                  className={`absolute right-1 top-1 size-1.5 rounded-full ${triggerStatusClass}`}
                />
              </Button>
            )}
          />
        </TooltipTrigger>
        <TooltipContent>{t('settings.page.mcp.title')}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="app-region-no-drag z-50">
          <Popover.Popup
            initialFocus={false}
            className="flex max-h-[min(32rem,calc(100dvh-4rem))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-lg outline-none"
          >
            <div className="border-b border-border px-3 py-2.5">
              <Popover.Title className="typography-ui-label font-semibold">
                {t('settings.page.mcp.title')}
              </Popover.Title>
              {status ? (
                <div className="mt-2 grid grid-cols-3 gap-2 typography-micro text-muted-foreground">
                  <span>{t('settings.varin.mcp.runtime.connected')} <strong className="text-foreground">{status.connectedCount}</strong></span>
                  <span>{t('settings.varin.mcp.runtime.tools')} <strong className="text-foreground">{status.totalTools}</strong></span>
                  <span>{t('settings.varin.mcp.runtime.resources')} <strong className="text-foreground">{status.totalResources}</strong></span>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {serverNames.length > 0 ? (
                <div className="space-y-1">
                  {serverNames.map((name) => {
                    const live = liveByName.get(name);
                    const serverStatus: McpAdapterServerStatus = live?.status ?? 'not-connected';
                    return (
                      <div key={name} className="flex min-w-0 items-center gap-2 px-2 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate typography-ui-label text-foreground">{name}</div>
                          {live ? (
                            <div className="truncate typography-micro text-muted-foreground">
                              {t('settings.varin.mcp.runtime.serverCounts', {
                                tools: live.toolCount,
                                resources: live.resourceCount ?? 0,
                              })}
                            </div>
                          ) : null}
                        </div>
                        <McpServerStatusBadge status={serverStatus} />
                      </div>
                    );
                  })}
                </div>
              ) : catalogState.loading ? (
                <Icon name="loader-4" className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="px-2 py-5 text-center typography-meta text-muted-foreground">
                  {currentSessionId
                    ? catalogState.error ?? t('settings.varin.mcp.runtime.noStatus')
                    : t('settings.varin.mcp.runtime.noSession')}
                </p>
              )}
            </div>

            <div className="border-t border-border p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  setSettingsPage('mcp');
                  setSettingsDialogOpen(true);
                }}
              >
                <Icon name="settings-3" className="size-4" />
                {t('workbench.ide.settings')}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
