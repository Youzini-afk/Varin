import React from "react";
import {
  createMcpConnectionsHttpAPI,
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
  registerRuntimeEndpointSwitchBlocker,
  type McpConfigurationSnapshot,
} from "@varin/application-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { McpIcon } from "@/components/icons/McpIcon";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useI18n, type I18nKey } from "@/lib/i18n";
import { Icon } from "@/components/icon/Icon";
import { openMcpSettings } from "./mcp-settings-navigation";
import { cn } from "@/lib/utils";
import { subscribeVarinEvents } from "@/lib/varinEvents";

interface McpDropdownContentProps {
  active: boolean;
  hostLabel?: string;
  onNavigate?: () => void;
  className?: string;
  headerAction?: React.ReactNode;
  listClassName?: string;
  hideHeader?: boolean;
  mobileListDensity?: boolean;
}
export function McpDropdownContent({
  active,
  className,
  headerAction,
  listClassName,
  hideHeader,
  hostLabel,
  onNavigate,
}: McpDropdownContentProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState<string>();
  const [refresh, setRefresh] = React.useState(0);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const generation = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeEndpointGeneration,
    getRuntimeEndpointGeneration,
  );
  const api = React.useMemo(
    () => createMcpConnectionsHttpAPI(generation),
    [generation],
  );
  const [snapshot, setSnapshot] = React.useState<McpConfigurationSnapshot>();
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState<string>();
  const owner = React.useRef<{
    view?: string;
    controller: AbortController;
    revision: number;
    busy: boolean;
    refresh(): void;
  } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    const current = {
      view: undefined as string | undefined,
      controller: new AbortController(),
      revision: 0,
      busy: false,
      refresh: () => {},
    };
    owner.current = current;
    const isCurrent = () =>
      owner.current === current &&
      !current.controller.signal.aborted &&
      generation === getRuntimeEndpointGeneration();
    let refreshPending = false;
    current.refresh = () => {
      if (!isCurrent()) return;
      if (!current.view) {
        refreshPending = true;
        return;
      }
      const request = ++current.revision;
      void api.read(current.view, current.controller.signal).then(
        (value) => {
          if (isCurrent() && request === current.revision) {
            setSnapshot(value);
            setError(undefined);
          }
        },
        (error) => {
          if (isCurrent() && request === current.revision)
            setError(error instanceof Error ? error.message : String(error));
        },
      );
    };
    setSnapshot(undefined);
    setError(undefined);
    setBusy(undefined);
    setExpanded(undefined);
    const stop = subscribeVarinEvents((event) => {
      if (
        event.type === "stream-ready" ||
        (event.type === "settings-changed" &&
          event.owner === "agent-settings" &&
          event.ids.includes("mcp"))
      )
        current.refresh();
    });
    const opening = api.open(directory || undefined, current.controller.signal);
    void opening.then(
      (value) => {
        current.view = value.view;
        if (!isCurrent()) {
          void api.close(value.view).catch(() => {});
          return;
        }
        setSnapshot(value);
        if (refreshPending) current.refresh();
      },
      (error) => {
        if (isCurrent())
          setError(error instanceof Error ? error.message : String(error));
      },
    );
    const stopSwitch = registerRuntimeEndpointSwitchBlocker(async () => {
      const opened = await opening.catch(() => undefined);
      if (opened) await api.close(opened.view);
    });
    return () => {
      if (owner.current === current) owner.current = null;
      current.controller.abort();
      stop();
      stopSwitch();
      if (current.view) void api.close(current.view).catch(() => {});
    };
  }, [active, api, directory, generation, refresh]);
  const command = async (
    name: string,
    action: "connect" | "reconnect" | "disconnect",
  ) => {
    const current = owner.current;
    if (
      !current?.view ||
      current.busy ||
      !active ||
      generation !== getRuntimeEndpointGeneration()
    )
      return;
    const isCurrent = () =>
      owner.current === current &&
      !current.controller.signal.aborted &&
      generation === getRuntimeEndpointGeneration();
    current.busy = true;
    const request = ++current.revision;
    setBusy(name);
    setError(undefined);
    try {
      const next = await api.command(
        current.view,
        name,
        action,
        current.controller.signal,
      );
      if (isCurrent() && request === current.revision) setSnapshot(next);
    } catch (error) {
      if (isCurrent())
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      current.busy = false;
      if (isCurrent()) {
        setBusy(undefined);
        current.refresh();
      }
    }
  };
  const settings = (name?: string, signIn = false) =>
    openMcpSettings(
      name ? { mode: "server", name, signIn } : undefined,
      onNavigate,
    );
  const add = () => openMcpSettings({ mode: "new" }, onNavigate);
  const servers = [...(snapshot?.servers ?? [])].sort(
    (left, right) =>
      Number(needsAttention(right)) - Number(needsAttention(left)),
  );
  const connected = servers.filter(
    (server) => server.enabled && server.status === "connected",
  ).length;
  const attention = servers.filter(needsAttention).length;
  const project = directory
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return (
    <section
      aria-label={t("services.mcp.title")}
      className={cn("py-4", className)}
    >
      {!hideHeader && (
        <div className="mb-4 flex items-center gap-3 px-5">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("services.mcp.title")}</h3>
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={directory || undefined}
            >
              {[hostLabel, project || t("services.mcp.global")]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {headerAction}
          {servers.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("services.mcp.add")}
              title={t("services.mcp.add")}
              onClick={add}
            >
              <Icon name="add" className="size-4" />
            </Button>
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mx-5 mb-3 flex items-start gap-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() =>
              owner.current?.view
                ? owner.current.refresh()
                : setRefresh((value) => value + 1)
            }
          >
            {t("services.mcp.retry")}
          </Button>
        </div>
      )}
      {!snapshot && !error && (
        <p role="status" className="px-5 py-6 text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      )}
      {servers.length > 0 && (
        <>
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  connected
                    ? "bg-[var(--status-success)]"
                    : "bg-muted-foreground",
                )}
              />
              {t("services.mcp.connectedCount", { count: connected })}
            </span>
            {attention > 0 && (
              <span className="text-[var(--status-warning)]">
                {t("services.mcp.attentionCount", { count: attention })}
              </span>
            )}
          </p>
          <div className={cn("px-2", listClassName)}>
            {servers.map((server) => {
              const open = expanded === server.name;
              const status = server.enabled ? server.status : "disabled";
              const attention = needsAttention(server);
              const source = snapshot?.sources.find(
                (source) => source.path === (server.override ?? server.source),
              );
              const scope = t(
                source?.scope === "global"
                  ? "services.mcp.global"
                  : source?.scope === "project"
                    ? "services.mcp.project"
                    : "services.mcp.otherSource",
              );
              const connecting =
                status === "connecting" || busy === server.name;
              const connect = () =>
                void command(
                  server.name,
                  server.holdsConnection ? "reconnect" : "connect",
                );
              return (
                <div key={server.name}>
                  <div className="flex items-center gap-1 pr-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded(open ? undefined : server.name)
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-[var(--surface-muted)]">
                        <McpIcon className="size-4 text-muted-foreground" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium">
                          {server.name}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {scope}
                          {status === "connected"
                            ? ` · ${t("services.mcp.tools", { count: server.connectedToolCount })}`
                            : ""}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          status === "connected"
                            ? "text-[var(--status-success)]"
                            : attention
                              ? "text-[var(--status-warning)]"
                              : "text-muted-foreground",
                        )}
                      >
                        {t(statusKeys[status] ?? "services.mcp.unavailable")}
                      </span>
                      <Icon
                        name={open ? "arrow-down-s" : "arrow-right-s"}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    </button>
                    {attention &&
                      (server.signInRequired && server.canSignIn ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 px-2 text-xs text-primary"
                          disabled={Boolean(busy) || !server.enabled}
                          onClick={() => settings(server.name, true)}
                        >
                          {t("settings.mcp.signIn")}
                        </Button>
                      ) : server.canConnect ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 px-2 text-xs text-primary"
                          disabled={Boolean(busy) || connecting}
                          onClick={connect}
                        >
                          {t("services.mcp.retry")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 px-2 text-xs"
                          onClick={() => settings(server.name)}
                        >
                          {t("services.mcp.settings")}
                        </Button>
                      ))}
                  </div>
                  {open && (
                    <div className="mx-3 mb-2 space-y-3 border-b border-border/50 px-3 pb-4 pt-1 text-xs">
                      {server.error && (
                        <p
                          role="status"
                          className="break-words leading-relaxed text-destructive"
                        >
                          {server.error}
                        </p>
                      )}
                      <dl className="space-y-1.5 text-muted-foreground">
                        <div className="flex justify-between gap-3">
                          <dt>{t("services.mcp.availableTools")}</dt>
                          <dd className="text-foreground">
                            {status === "connected"
                              ? server.connectedToolCount.toLocaleString()
                              : "—"}
                          </dd>
                        </div>
                        {status !== "connected" &&
                          server.cachedToolCount > 0 && (
                            <div className="flex justify-between gap-3">
                              <dt>{t("services.mcp.cachedTools")}</dt>
                              <dd>{server.cachedToolCount.toLocaleString()}</dd>
                            </div>
                          )}
                        <div className="flex justify-between gap-3">
                          <dt>{t("services.mcp.exposure")}</dt>
                          <dd>
                            {t(
                              exposureKeys[server.exposure] ??
                                "services.mcp.unavailable",
                            )}
                          </dd>
                        </div>
                      </dl>
                      <p className="break-all text-[11px] leading-relaxed text-muted-foreground">
                        {server.source}
                        {server.override ? ` → ${server.override}` : ""}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {!attention && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={
                              Boolean(busy) || !server.canConnect || connecting
                            }
                            onClick={connect}
                          >
                            {t(
                              connecting
                                ? "settings.mcp.status.connecting"
                                : status === "connected" ||
                                    server.holdsConnection
                                  ? "settings.mcp.reconnect"
                                  : "settings.mcp.connect",
                            )}
                          </Button>
                        )}
                        {!server.signInRequired && server.canSignIn && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={
                              Boolean(busy) || !server.enabled || connecting
                            }
                            onClick={() => settings(server.name, true)}
                          >
                            {t("settings.mcp.signIn")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => settings(server.name)}
                        >
                          <Icon name="settings-3" className="mr-1 size-3.5" />
                          {t("services.mcp.settings")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {snapshot?.issues.length ? (
        <div className="mx-5 my-3 space-y-2">
          {snapshot.issues.map((issue) => (
            <p
              key={issue}
              role="status"
              className="break-words text-xs leading-relaxed text-[var(--status-warning)]"
            >
              {issue}
            </p>
          ))}
        </div>
      ) : null}
      {snapshot && !servers.length && (
        <div className="px-6 py-7 text-center">
          <span className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-[var(--surface-muted)]">
            <McpIcon className="size-5 text-muted-foreground" />
          </span>
          <p className="text-sm font-medium">{t("services.mcp.empty")}</p>
          <p className="mx-auto mb-5 mt-2 max-w-64 text-xs leading-relaxed text-muted-foreground">
            {t("services.mcp.emptyHint")}
          </p>
          <Button size="sm" onClick={add}>
            <Icon name="add" className="mr-1.5 size-4" />
            {t("services.mcp.add")}
          </Button>
        </div>
      )}
      {servers.length > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-border/50 px-5 pt-3">
          <span className="text-[11px] text-muted-foreground">
            {t("services.mcp.total", { count: servers.length })}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => settings()}
          >
            {t("services.mcp.manage")}
            <Icon name="arrow-right-s" className="size-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
const needsAttention = (server: McpConfigurationSnapshot["servers"][number]) =>
  server.enabled &&
  (server.signInRequired ||
    server.status === "failed" ||
    server.status === "stale" ||
    Boolean(server.error));
const exposureKeys: Record<string, I18nKey> = {
  direct: "settings.varin.mcp.native.exposure.catalog",
  codemode: "settings.varin.mcp.native.exposure.codemode",
  deferred: "settings.varin.mcp.native.exposure.deferred",
  hidden: "settings.varin.mcp.native.exposure.hidden",
};
const statusKeys: Record<string, I18nKey> = {
  disabled: "settings.mcp.status.disabled",
  unprepared: "settings.mcp.status.unprepared",
  connecting: "settings.mcp.status.connecting",
  connected: "settings.mcp.status.connected",
  disconnected: "settings.mcp.status.disconnected",
  "needs-auth": "settings.mcp.status.needs-auth",
  failed: "settings.mcp.status.failed",
  closed: "settings.mcp.status.closed",
  stale: "settings.mcp.status.stale",
};
export function McpDropdown({
  headerIconButtonClass,
}: {
  headerIconButtonClass?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={headerIconButtonClass}
          aria-label={t("services.mcp.title")}
        >
          <McpIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="max-h-[70vh] w-[min(27rem,calc(100vw-2rem))] overflow-y-auto bg-[var(--surface-elevated)] p-0"
        align="end"
      >
        <McpDropdownContent active={open} onNavigate={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
