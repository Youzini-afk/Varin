import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  parseMcpAdapterStatus,
  type McpAdapterServerSnapshot,
  type McpAdapterServerStatus,
} from '@/components/sections/mcp/mcpAdapterStatus';

const statusTooltip = (
  status: McpAdapterServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  switch (status) {
    case 'connected':
      return t('mcpDropdown.status.connected');
    case 'cached':
      return t('mcpDropdown.status.cached');
    case 'failed':
      return t('mcpDropdown.status.failed', {
        error: t('mcpDropdown.status.unknownError'),
      });
    case 'needs-auth':
      return t('mcpDropdown.status.needsAuth');
    default:
      return status;
  }
};

const statusTone = (
  status: McpAdapterServerStatus,
): 'default' | 'success' | 'warning' | 'error' => {
  switch (status) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'error';
    case 'needs-auth':
      return 'warning';
    default:
      return 'default';
  }
};

const safeCommandArgument = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const useMcpAdapterRuntime = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const sessionCwd = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.records[state.currentSessionId]?.snapshot?.cwd
  ));
  const extensionState = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.records[state.currentSessionId]?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL]
  ));
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const status = React.useMemo(() => parseMcpAdapterStatus(extensionState), [extensionState]);
  const cwd = sessionCwd || currentDirectory || '';

  const runCommand = React.useCallback(async (command: string, reload = false) => {
    if (!currentSessionId) return false;
    try {
      await executeCommand(currentSessionId, command);
      if (reload) await executeCommand(currentSessionId, '/reload');
      return true;
    } catch (error) {
      console.error(`Failed to execute Pi MCP command ${command}:`, error);
      toast.error(error instanceof Error ? error.message : t('settings.varin.mcp.toast.commandFailed'));
      return false;
    }
  }, [currentSessionId, executeCommand, t]);

  const reconnect = React.useCallback(() => runCommand('/mcp reconnect'), [runCommand]);
  const setServerEnabled = React.useCallback((serverName: string, enabled: boolean) => (
    runCommand(`/mcp ${enabled ? 'enable' : 'disable'} ${safeCommandArgument(serverName)}`, status?.owner !== 'native')
  ), [runCommand, status?.owner]);

  return {
    currentSessionId,
    cwd,
    reconnect,
    servers: status?.servers ?? [],
    setServerEnabled,
    status,
  };
};

interface McpServerRowsProps {
  busyName: string | null;
  emptyMessage: string;
  mobileListDensity?: boolean;
  onToggle: (server: McpAdapterServerSnapshot, enabled: boolean) => void;
  servers: McpAdapterServerSnapshot[];
}

const McpServerRows: React.FC<McpServerRowsProps> = ({
  busyName,
  emptyMessage,
  mobileListDensity = false,
  onToggle,
  servers,
}) => {
  const { t } = useI18n();
  return (
    <>
      {servers.map((server) => {
        const tone = statusTone(server.status);
        const tooltip = statusTooltip(server.status, t);
        return (
          <div
            key={server.name}
            className={cn(
              'flex items-center justify-between rounded-lg hover:bg-interactive-hover/50',
              mobileListDensity ? 'gap-3 px-4 py-3' : 'gap-2 px-2.5 py-2',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'flex-shrink-0 rounded-full',
                        mobileListDensity ? 'h-2.5 w-2.5' : 'h-2 w-2',
                        tone === 'success' && 'bg-status-success',
                        tone === 'error' && 'bg-status-error',
                        tone === 'warning' && 'bg-status-warning',
                        tone === 'default' && 'bg-muted-foreground/40',
                      )}
                      aria-label={tooltip}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{tooltip}</p>
                  </TooltipContent>
                </Tooltip>
                <span className={cn(
                  'truncate',
                  mobileListDensity ? 'text-[17px] leading-6 font-medium' : 'typography-ui-label',
                )}>
                  {server.name}
                </span>
              </div>
              <p className={cn(
                'mt-0.5 text-muted-foreground',
                mobileListDensity ? 'typography-meta' : 'typography-micro',
              )}>
                {t('settings.varin.mcp.runtime.serverCounts', {
                  tools: server.toolCount,
                  resources: server.resourceCount ?? 0,
                })}
              </p>
            </div>
            <Switch
              checked={!server.disabled}
              disabled={busyName !== null}
              className="data-[checked]:bg-status-info"
              onCheckedChange={(enabled) => onToggle(server, enabled)}
            />
          </div>
        );
      })}
      {servers.length === 0 ? (
        <div className="px-4 py-5 text-center typography-ui-label text-muted-foreground">
          {emptyMessage}
        </div>
      ) : null}
    </>
  );
};

interface McpDropdownProps {
  headerIconButtonClass: string;
}

interface McpDropdownContentProps {
  active: boolean;
  className?: string;
  headerAction?: React.ReactNode;
  listClassName?: string;
  hideHeader?: boolean;
  mobileListDensity?: boolean;
}

export const McpDropdownContent: React.FC<McpDropdownContentProps> = ({
  active,
  className,
  headerAction,
  listClassName,
  hideHeader = false,
  mobileListDensity = false,
}) => {
  const { t } = useI18n();
  const { currentSessionId, cwd, reconnect, servers, setServerEnabled, status } = useMcpAdapterRuntime();
  const [isReconnecting, setIsReconnecting] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);
  const emptyMessage = !currentSessionId
    ? t('settings.varin.mcp.runtime.noSession')
    : !status
      ? t('settings.varin.mcp.runtime.noStatus')
      : t('settings.varin.mcp.runtime.empty');

  const handleReconnect = React.useCallback((event?: React.MouseEvent) => {
    event?.preventDefault();
    if (isReconnecting || !currentSessionId) return;
    setIsReconnecting(true);
    const minSpin = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([reconnect(), minSpin]).finally(() => setIsReconnecting(false));
  }, [currentSessionId, isReconnecting, reconnect]);

  const handleToggle = React.useCallback((server: McpAdapterServerSnapshot, enabled: boolean) => {
    setBusyName(server.name);
    void setServerEnabled(server.name, enabled).finally(() => setBusyName(null));
  }, [setServerEnabled]);

  const directoryName = cwd.split(/[\\/]/).pop() || cwd;
  return (
    <div className={cn('w-full', className)} data-active={active ? 'true' : 'false'}>
      {!hideHeader ? (
        <div className="border-b border-[var(--interactive-border)]">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <div className="typography-ui-header font-semibold text-foreground">{t('mcpDropdown.title')}</div>
              {directoryName ? (
                <div className="truncate typography-micro text-muted-foreground">{directoryName}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerAction}
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                disabled={isReconnecting || !currentSessionId}
                onClick={handleReconnect}
                aria-label={t('settings.varin.mcp.actions.reconnect')}
                title={t('settings.varin.mcp.actions.reconnect')}
              >
                <Icon name="refresh" className={cn('h-4 w-4', isReconnecting && 'animate-spin')} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className={cn(
        'max-h-64 overflow-y-auto',
        mobileListDensity ? 'space-y-1 py-3' : 'px-3 py-2.5',
        listClassName,
      )}>
        <div className={cn(!mobileListDensity && servers.length > 0 && 'rounded-xl bg-[var(--surface-muted)] p-1.5')}>
          <McpServerRows
            busyName={busyName}
            emptyMessage={emptyMessage}
            mobileListDensity={mobileListDensity}
            onToggle={handleToggle}
            servers={servers}
          />
        </div>
      </div>
    </div>
  );
};

export const McpDropdown: React.FC<McpDropdownProps> = ({ headerIconButtonClass }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const [isReconnecting, setIsReconnecting] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);
  const blockTooltipRef = React.useRef(false);
  const { isMobile } = useDeviceInfo();
  const { currentSessionId, cwd, reconnect, servers, setServerEnabled, status } = useMcpAdapterRuntime();
  const health = React.useMemo(() => ({
    connected: status?.connectedCount ?? 0,
    hasAuthRequired: servers.some((server) => server.status === 'needs-auth'),
    hasFailed: servers.some((server) => server.status === 'failed'),
    total: servers.length,
  }), [servers, status?.connectedCount]);
  const emptyMessage = !currentSessionId
    ? t('settings.varin.mcp.runtime.noSession')
    : !status
      ? t('settings.varin.mcp.runtime.noStatus')
      : t('settings.varin.mcp.runtime.empty');

  const handleDropdownOpenChange = React.useCallback((isOpen: boolean) => {
    if (!isOpen) {
      blockTooltipRef.current = true;
      setTooltipOpen(false);
      window.setTimeout(() => {
        blockTooltipRef.current = false;
      }, 200);
    }
    setOpen(isOpen);
  }, []);

  const handleTooltipOpenChange = React.useCallback((isOpen: boolean) => {
    if (blockTooltipRef.current) return;
    setTooltipOpen(isOpen);
  }, []);

  const handleReconnect = React.useCallback((event?: React.MouseEvent) => {
    event?.preventDefault();
    if (isReconnecting || !currentSessionId) return;
    setIsReconnecting(true);
    const minSpin = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([reconnect(), minSpin]).finally(() => setIsReconnecting(false));
  }, [currentSessionId, isReconnecting, reconnect]);

  const handleToggle = React.useCallback((server: McpAdapterServerSnapshot, enabled: boolean) => {
    setBusyName(server.name);
    void setServerEnabled(server.name, enabled).finally(() => setBusyName(null));
  }, [setServerEnabled]);

  const triggerButton = (
    <button
      type="button"
      aria-label={t('mcpDropdown.actions.openAria')}
      className={cn(headerIconButtonClass, 'relative')}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <McpIcon className="h-[1.0625rem] w-[1.0625rem]" />
      {health.total > 0 ? (
        <span
          className={cn(
            'absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full',
            health.hasFailed
              ? 'bg-status-error'
              : health.hasAuthRequired
                ? 'bg-status-warning'
                : health.connected > 0
                  ? 'bg-status-success'
                  : 'bg-muted-foreground/40',
          )}
          aria-label={t('mcpDropdown.statusAria')}
        />
      ) : null}
    </button>
  );

  if (isMobile) {
    const directoryName = cwd.split(/[\\/]/).pop() || cwd;
    return (
      <>
        {triggerButton}
        <MobileOverlayPanel
          open={open}
          title={t('mcpDropdown.title')}
          onClose={() => setOpen(false)}
          renderHeader={(closeButton) => (
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
              <div className="min-w-0">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('mcpDropdown.title')}</h2>
                {directoryName ? (
                  <p className="truncate typography-micro text-muted-foreground">{directoryName}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                  disabled={isReconnecting || !currentSessionId}
                  onClick={handleReconnect}
                  aria-label={t('settings.varin.mcp.actions.reconnect')}
                  title={t('settings.varin.mcp.actions.reconnect')}
                >
                  <Icon name="refresh" className={cn('h-4 w-4', isReconnecting && 'animate-spin')} />
                </button>
                {closeButton}
              </div>
            </div>
          )}
        >
          <div className="py-1">
            <McpServerRows
              busyName={busyName}
              emptyMessage={emptyMessage}
              onToggle={handleToggle}
              servers={servers}
            />
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleDropdownOpenChange}>
      <Tooltip open={open ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('mcpDropdown.title')}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <McpDropdownContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
