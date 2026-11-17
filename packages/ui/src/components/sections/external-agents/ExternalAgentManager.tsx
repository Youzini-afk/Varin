import React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  createExternalAgentsHttpAPI,
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
  type ExternalAgentConfiguration,
  type ExternalAgentProfile,
  type ExternalAgentSettings,
  type ExternalAgentCapabilityCache,
  type ExternalAgentDetection,
  type ExternalAgentInstallations,
  type ExternalAgentInstallationRequest,
  type ThreadSourceTargets,
} from "@varin/application-client";
import type { SourceResourceOwner } from "@varin/protocol";
import { useRuntimeAPIs } from "@/hooks/useRuntimeAPIs";
import { useExternalAgentStore } from "@/stores/useExternalAgentStore";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
import { SettingsSection } from "@/components/sections/shared/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { HarnessIcon } from "@/components/thread/HarnessIcon";
import { Icon } from "@/components/icon/Icon";
import { useI18n, type I18nKey } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/url";
import { AgentDefaultsFields } from "./ExternalAgentDefaults";
import "./external-agents.css";

const profileFor = (
  settings: ExternalAgentSettings,
  agent: ExternalAgentConfiguration,
) =>
  settings.profiles?.find(
    (profile) => profile.id === (agent.profileId ?? agent.id),
  );
const disabled = (agent: ExternalAgentConfiguration) =>
  !agent.enabled || agent.availability === "disabled";
const active = (status?: string) =>
  status === "running" || status === "cancelling";
const mark = (
  agent: {
    harness: ExternalAgentConfiguration["harness"];
    id: string;
    profileId?: string;
  },
  large = false,
) => (
  <HarnessIcon
    harness={agent.harness}
    profileId={agent.profileId ?? agent.id}
    className={large ? "size-9" : "size-6"}
  />
);

export function ExternalAgentsPage() {
  const generation = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeEndpointGeneration,
    getRuntimeEndpointGeneration,
  );
  return <AgentDevices key={generation} generation={generation} />;
}
function AgentDevices({ generation }: { generation: number }) {
  const { t } = useI18n();
  const { threads } = useRuntimeAPIs();
  const [targets, setTargets] = React.useState<ThreadSourceTargets>();
  const [device, setDevice] = React.useState("local");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const controller = new AbortController();
    if (threads)
      void threads.sources
        .list(null, controller.signal)
        .then(setTargets, (error) => {
          if (!controller.signal.aborted) setError(String(error));
        });
    return () => controller.abort();
  }, [threads]);
  const remote =
    targets?.targets.filter(
      (target) => target.resourceOwner.kind === "managed_host",
    ) ?? [];
  const selected = remote.find(
    (target) => JSON.stringify(target.resourceOwner) === device,
  );
  const picker = (
    <div className="ea-device">
      <Icon name="computer" className="size-5" />
      <div>
        <Select value={device} onValueChange={setDevice}>
          <SelectTrigger aria-label={t("external.executionDevice")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">{t("external.currentDevice")}</SelectItem>
            {remote.map((target) => (
              <SelectItem
                key={JSON.stringify(target.resourceOwner)}
                value={JSON.stringify(target.resourceOwner)}
              >
                {target.label}
              </SelectItem>
            ))}
            {targets?.unavailable.map((target) => (
              <SelectItem
                key={target.connectionId}
                value={`offline:${target.connectionId}`}
                disabled
              >
                {target.label} · {t("external.manage.offline")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p>{t("external.manage.deviceHint")}</p>
      </div>
    </div>
  );
  return (
    <AgentManager
      key={device}
      generation={generation}
      owner={selected?.resourceOwner}
      deviceLabel={selected?.label ?? t("external.currentDevice")}
      picker={picker}
      deviceError={error}
    />
  );
}

function AgentManager({
  generation,
  owner,
  deviceLabel,
  picker,
  deviceError,
}: {
  generation: number;
  owner?: SourceResourceOwner;
  deviceLabel: string;
  picker: React.ReactNode;
  deviceError: string;
}) {
  const { t } = useI18n();
  const api = React.useMemo(
    () => createExternalAgentsHttpAPI(generation),
    [generation],
  );
  const [settings, setSettings] = React.useState<ExternalAgentSettings>();
  const [detections, setDetections] = React.useState<
    Record<string, ExternalAgentDetection>
  >({});
  const [observationError, setObservationError] = React.useState(false);
  const [operations, setOperations] =
    React.useState<ExternalAgentInstallations>();
  const [selected, setSelected] = React.useState<string>();
  const [adding, setAdding] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [error, setError] = React.useState("");
  const lifetime = React.useRef(new AbortController());
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const report = React.useCallback((error: unknown) => {
    if (!lifetime.current.signal.aborted)
      setError(error instanceof Error ? error.message : String(error));
  }, []);
  const detect = React.useCallback(
    async (id: string) => {
      const signal = lifetime.current.signal;
      try {
        const result = await api.detect(id, signal, owner);
        if (!signal.aborted)
          setDetections((previous) => ({ ...previous, [id]: result }));
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
    [api, owner],
  );
  const refresh = React.useCallback(
    async (scan = false, force = false) => {
      const signal = lifetime.current.signal;
      try {
        const next = await api.settings(signal, owner);
        if (signal.aborted) return;
        setSettings(next);
        if (next.detections)
          setDetections((previous) => ({
            ...previous,
            ...Object.fromEntries(
              next.detections!.map((detection) => [detection.id, detection]),
            ),
          }));
        if (scan) {
          setScanning(true);
          try {
            await Promise.all(
              next.agents
                .filter(
                  (agent) =>
                    !disabled(agent) &&
                    (force ||
                      !next.detections?.some(
                        (detection) => detection.id === agent.id,
                      )),
                )
                .map((agent) => detect(agent.id)),
            );
          } finally {
            if (!signal.aborted) setScanning(false);
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
    [api, owner, detect],
  );
  React.useEffect(() => {
    void refresh(true).catch(report);
  }, [refresh, report]); // Device/Host changes remount the owner.
  React.useEffect(() => {
    const controller = new AbortController();
    let previous: ExternalAgentInstallations | undefined;
    void api
      .observeInstallations(
        async (snapshot) => {
          setObservationError(false);
          setOperations(snapshot);
          const finished = snapshot.operations.filter(
            (operation) =>
              !active(operation.status) &&
              JSON.stringify(
                previous?.operations.find(
                  (old) => old.configurationId === operation.configurationId,
                ),
              ) !== JSON.stringify(operation),
          );
          const restarted = previous?.operations.some(
            (old) =>
              active(old.status) &&
              !snapshot.operations.some(
                (operation) =>
                  operation.configurationId === old.configurationId,
              ),
          );
          if (finished.length || restarted) {
            await refresh(Boolean(restarted));
            await Promise.all(
              finished.map((operation) => detect(operation.configurationId)),
            );
            if (!owner) void useExternalAgentStore.getState().refresh();
          }
          previous = snapshot;
        },
        controller.signal,
        owner,
        () => setObservationError(true),
      )
      .catch((error) => {
        if (!controller.signal.aborted) report(error);
      });
    return () => controller.abort();
  }, [api, owner, detect, refresh, report]);
  const save = async (agent: ExternalAgentConfiguration, remove = false) => {
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      const agents = remove
        ? settings.agents.filter((value) => value.id !== agent.id)
        : settings.agents.some((value) => value.id === agent.id)
          ? settings.agents.map((value) =>
              value.id === agent.id ? agent : value,
            )
          : [...settings.agents, agent];
      await api.configure(
        {
          agents,
          defaultAgent:
            remove && settings.defaultAgent === agent.id
              ? null
              : settings.defaultAgent,
        },
        settings.revision,
        crypto.randomUUID(),
        owner,
      );
      await refresh();
      if (!owner) void useExternalAgentStore.getState().refresh();
    } finally {
      if (!lifetime.current.signal.aborted) setSaving(false);
    }
  };
  const request = async (input: ExternalAgentInstallationRequest) => {
    setError("");
    const snapshot = await api.installations(
      input,
      lifetime.current.signal,
      owner,
    );
    if (!lifetime.current.signal.aborted) setOperations(snapshot);
  };
  const configuration = settings?.agents.find((agent) => agent.id === selected);
  const rows =
    settings?.agents.filter(
      (agent) =>
        agent.availability !== "auto" ||
        detections[agent.id]?.status === "available" ||
        active(
          operations?.operations.find(
            (operation) => operation.configurationId === agent.id,
          )?.status,
        ),
    ) ?? [];
  const row = (agent: ExternalAgentConfiguration) => {
    const detection = detections[agent.id];
    const operation = operations?.operations.find(
      (operation) => operation.configurationId === agent.id,
    );
    return (
      <div className="ea-row" key={agent.id}>
        <button className="ea-row-main" onClick={() => setSelected(agent.id)}>
          {mark(agent)}
          <span>
            <strong>{agent.name}</strong>
            <small>
              {active(operation?.status)
                ? t(`external.manage.stage.${operation!.stage}`)
                : disabled(agent)
                  ? t("external.manage.disabled")
                  : detection?.status === "available"
                    ? (detection.version ?? t("external.manage.installed"))
                    : detection?.status === "missing"
                      ? t("external.manage.notInstalled")
                      : detection?.status === "failed"
                        ? t("external.manage.needsAttention")
                        : t("external.detecting")}
              <span> · </span>
              {t(
                detection?.managed
                  ? "external.manage.managed"
                  : "external.manage.existing",
              )}
            </small>
          </span>
        </button>
        {disabled(agent) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() =>
              void save({ ...agent, enabled: true, availability: "enabled" })
                .then(() => detect(agent.id))
                .catch(report)
            }
          >
            {t("external.manage.enable")}
          </Button>
        )}
        <button
          aria-label={t("external.manage.details", { name: agent.name })}
          className="ea-open"
          onClick={() => setSelected(agent.id)}
        >
          <Icon name="arrow-right-s" className="size-4" />
        </button>
      </div>
    );
  };
  return (
    <div className="external-agent-manager h-full min-h-0">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={configuration?.id ?? "list"}
          className="h-full min-h-0"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -6 }}
          transition={{ duration: 0.16 }}
        >
          {configuration && settings ? (
            <AgentDetail
              key={configuration.id}
              agent={configuration}
              profile={profileFor(settings, configuration)}
              cache={settings.capabilityCache?.[configuration.id]}
              detection={detections[configuration.id]}
              operation={operations?.operations.find(
                (operation) => operation.configurationId === configuration.id,
              )}
              saving={saving}
              deviceLabel={deviceLabel}
              back={() => setSelected(undefined)}
              save={save}
              detect={() => detect(configuration.id)}
              request={request}
              log={() =>
                api.installationLog(
                  configuration.id,
                  lifetime.current.signal,
                  owner,
                )
              }
              report={report}
            />
          ) : (
            <SettingsPageLayout
              title={t("external.title")}
              description={t("external.manage.description")}
              headerEnd={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={scanning || !settings}
                  onClick={() => void refresh(true, true).catch(report)}
                >
                  <Icon
                    name="refresh"
                    className={`size-4 ${scanning ? "animate-spin" : ""}`}
                  />
                  {t("external.refreshDevice")}
                </Button>
              }
            >
              <div className="ea-device-bar">
                {picker}
                <Button
                  size="sm"
                  onClick={() => setAdding(true)}
                  disabled={!settings}
                >
                  <Icon name="add" className="size-4" />
                  {t("external.manage.add")}
                </Button>
              </div>
              {!settings && !error && (
                <p className="ea-hint">{t("common.loading")}</p>
              )}
              {rows.filter((agent) => !disabled(agent)).map(row)}
              {settings && !rows.length && (
                <p className="ea-empty">{t("external.manage.empty")}</p>
              )}
              {rows.some(disabled) && (
                <details className="ea-disabled">
                  <summary>
                    {t("external.manage.disabled")} ·{" "}
                    {rows.filter(disabled).length}
                  </summary>
                  {rows.filter(disabled).map(row)}
                </details>
              )}
              <button
                className="ea-catalog-entry"
                onClick={() => setAdding(true)}
                disabled={!settings}
              >
                <Icon name="add" className="size-5" />
                <span>
                  {t("external.manage.browse")}
                  <small>{t("external.manage.browseHint")}</small>
                </span>
                <Icon name="arrow-right-s" className="size-4" />
              </button>
            </SettingsPageLayout>
          )}
        </motion.div>
      </AnimatePresence>
      {(error || deviceError || observationError) && (
        <p role="alert" className="ea-error">
          {error || deviceError || t("external.manage.reconnecting")}
        </p>
      )}
      {settings && (
        <AgentCatalog
          open={adding}
          close={() => setAdding(false)}
          settings={settings}
          detections={detections}
          busy={saving}
          deviceLabel={deviceLabel}
          add={async (agent, install, version) => {
            await save(agent);
            setAdding(false);
            setSelected(agent.id);
            if (install)
              await request({
                action: "install",
                id: agent.id,
                ...(version ? { version } : {}),
              });
            else await detect(agent.id);
          }}
          report={report}
        />
      )}
    </div>
  );
}

function AgentDetail({
  agent,
  profile,
  cache,
  detection,
  operation,
  saving,
  deviceLabel,
  back,
  save,
  detect,
  request,
  log,
  report,
}: {
  agent: ExternalAgentConfiguration;
  profile?: ExternalAgentProfile;
  cache?: ExternalAgentCapabilityCache;
  detection?: ExternalAgentDetection;
  operation?: ExternalAgentInstallations["operations"][number];
  saving: boolean;
  deviceLabel: string;
  back(): void;
  save(agent: ExternalAgentConfiguration, remove?: boolean): Promise<void>;
  detect(): Promise<void>;
  request(input: ExternalAgentInstallationRequest): Promise<void>;
  log(): Promise<string>;
  report(error: unknown): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(agent);
  const [output, setOutput] = React.useState<string>();
  const [uninstall, setUninstall] = React.useState(false);
  const agentKey = JSON.stringify(agent);
  React.useEffect(() => setDraft(JSON.parse(agentKey)), [agentKey]);
  const working = active(operation?.status);
  const managed = detection?.managed;
  const canInstall =
    profile?.installation?.kind && profile.installation.kind !== "external";
  const act = (action: "install" | "check" | "cancel" | "uninstall") =>
    void request({ action, id: agent.id }).catch(report);
  return (
    <div className="ea-detail-frame h-full min-h-0 flex flex-col">
      <div className="ea-nav">
        <Button variant="ghost" size="sm" onClick={back}>
          <Icon name="arrow-left" className="size-4" />
          {t("external.title")}
        </Button>
      </div>
      <SettingsPageLayout
        className="ea-detail"
        outerClassName="flex-1"
        title={
          <div className="ea-title">
            {mark(agent, true)}
            <div>
              <h1>{agent.name}</h1>
              <p>
                {deviceLabel}
                {profile?.installation?.community
                  ? ` · ${t("external.manage.community")}`
                  : ""}
              </p>
            </div>
          </div>
        }
        headerEnd={
          <div className="ea-header-actions">
            <label className="ea-enable">
              <span>{t("external.manage.enable")}</span>
              <Switch
                aria-label={t("external.enabled")}
                checked={!disabled(agent)}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  void save({
                    ...agent,
                    enabled,
                    availability: enabled ? "enabled" : "disabled",
                  }).catch(report)
                }
              />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("external.manage.more")}
                >
                  <Icon name="more" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {profile?.installUrl && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void openExternalUrl(profile.installUrl!).catch(report)
                    }
                  >
                    {t("external.installGuide")}
                  </DropdownMenuItem>
                )}
                {managed ? (
                  <DropdownMenuItem
                    disabled={working}
                    onSelect={() => setUninstall(true)}
                  >
                    {t("external.manage.uninstall")}
                  </DropdownMenuItem>
                ) : (
                  agent.id !== profile?.id && (
                    <DropdownMenuItem
                      disabled={saving}
                      onSelect={() =>
                        void save(agent, true).then(back).catch(report)
                      }
                    >
                      {t("external.manage.remove")}
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      >
        <SettingsSection title={t("external.manage.program")}>
          <div className="ea-program">
            <div>
              <strong>
                {detection?.status === "available"
                  ? (detection.version ??
                    managed?.version ??
                    t("external.manage.installed"))
                  : detection?.status === "missing"
                    ? t("external.manage.notInstalled")
                    : t("external.manage.notDetected")}
              </strong>
              <span className="ea-source">
                {t(
                  managed
                    ? "external.manage.managed"
                    : "external.manage.existing",
                )}
              </span>
            </div>
            <div className="ea-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={working}
                onClick={() => void detect().catch(report)}
              >
                {t("external.detect")}
              </Button>
              {managed ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onClick={() => act("check")}
                >
                  {t("external.manage.checkUpdates")}
                </Button>
              ) : (
                canInstall && (
                  <Button
                    variant={
                      detection?.status === "available" ? "outline" : "default"
                    }
                    size="sm"
                    disabled={working}
                    onClick={() => act("install")}
                  >
                    {t(
                      detection?.status === "available"
                        ? "external.manage.installManagedVersion"
                        : "external.manage.install",
                    )}
                  </Button>
                )
              )}
              {!canInstall && profile?.installUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void openExternalUrl(profile.installUrl!).catch(report)
                  }
                >
                  {t("external.installGuide")}
                </Button>
              )}
            </div>
          </div>
          {detection?.status === "failed" && (
            <p role="alert" className="ea-error">
              {detection.message}
            </p>
          )}
          {operation && (
            <div className="ea-operation" role="status">
              <span>
                {working
                  ? t(`external.manage.stage.${operation.stage}`)
                  : operation.status === "succeeded" &&
                      operation.operation === "check"
                    ? t("external.manage.availableVersion", {
                        version: operation.version ?? "",
                      })
                    : t(
                        `external.manage.result.${operation.status}` as I18nKey,
                      )}
              </span>
              {working &&
                !["activating", "removing"].includes(operation.stage) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={operation.status === "cancelling"}
                    onClick={() => act("cancel")}
                  >
                    {t(
                      operation.status === "cancelling"
                        ? "external.manage.cancelling"
                        : "external.manage.cancel",
                    )}
                  </Button>
                )}
              {operation.status === "succeeded" &&
                operation.operation === "check" &&
                operation.version !== managed?.version && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void request({
                        action: "install",
                        id: agent.id,
                        version: operation.version,
                      }).catch(report)
                    }
                  >
                    {t("external.manage.update")}
                  </Button>
                )}
              {working && <div className="ea-progress" />}
            </div>
          )}
          {operation?.status === "failed" && (
            <p role="alert" className="ea-error">
              {operation.error}
            </p>
          )}
          {operation && (
            <details
              className="ea-log"
              onToggle={(event) => {
                if (event.currentTarget.open)
                  void log().then(setOutput).catch(report);
              }}
            >
              <summary>{t("external.manage.log")}</summary>
              <pre>{output ?? t("common.loading")}</pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void log().then(setOutput).catch(report)}
              >
                {t("external.refreshDevice")}
              </Button>
            </details>
          )}
          <details className="ea-location">
            <summary>{t("external.manage.location")}</summary>
            <code>{detection?.executable ?? agent.command}</code>
          </details>
          {["openclaw", "zcode", "hermes", "antigravity"].includes(
            profile?.id ?? "",
          ) && (
            <p className="ea-hint">
              {t(`external.manage.note.${profile!.id}` as I18nKey)}
            </p>
          )}
        </SettingsSection>
        <AgentDefaultsFields
          value={agent.defaults}
          cache={cache}
          disabled={saving}
          onChange={(defaults) =>
            void save({ ...agent, defaults }).catch(report)
          }
        />
        <details className="ea-advanced">
          <summary>{t("external.manage.advanced")}</summary>
          <label>
            {t("external.name")}
            <Input
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            {t("external.command")}
            <Input
              value={draft.command}
              onChange={(event) =>
                setDraft({ ...draft, command: event.target.value })
              }
            />
          </label>
          <Arguments
            value={draft.args}
            onChange={(args) => setDraft({ ...draft, args })}
          />
          <Button
            size="sm"
            disabled={
              saving ||
              !draft.command.trim() ||
              !draft.name.trim() ||
              JSON.stringify(draft) === JSON.stringify(agent)
            }
            onClick={() => void save(draft).then(detect).catch(report)}
          >
            {t("external.save")}
          </Button>
        </details>
        <Dialog open={uninstall} onOpenChange={setUninstall}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("external.manage.uninstall")}</DialogTitle>
              <DialogDescription>
                {t("external.manage.uninstallHint")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setUninstall(false)}>
                {t("external.manage.cancel")}
              </Button>
              <Button
                onClick={() => {
                  setUninstall(false);
                  act("uninstall");
                }}
              >
                {t("external.manage.uninstall")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </SettingsPageLayout>
    </div>
  );
}

function Arguments({
  value,
  onChange,
}: {
  value: string[];
  onChange(value: string[]): void;
}) {
  const { t } = useI18n();
  return (
    <div className="ea-arguments">
      <span>{t("external.manage.arguments")}</span>
      {value.map((argument, index) => (
        <div key={index}>
          <Input
            aria-label={`${t("external.manage.arguments")} ${index + 1}`}
            value={argument}
            onChange={(event) =>
              onChange(
                value.map((old, i) => (i === index ? event.target.value : old)),
              )
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("external.manage.removeArgument")}
            onClick={() => onChange(value.filter((_old, i) => i !== index))}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...value, ""])}
      >
        <Icon name="add" className="size-4" />
        {t("external.manage.addArgument")}
      </Button>
    </div>
  );
}

function AgentCatalog({
  open,
  close,
  settings,
  detections,
  busy,
  deviceLabel,
  add,
  report,
}: {
  open: boolean;
  close(): void;
  settings: ExternalAgentSettings;
  detections: Record<string, ExternalAgentDetection>;
  busy: boolean;
  deviceLabel: string;
  add(
    agent: ExternalAgentConfiguration,
    install: boolean,
    version: string,
  ): Promise<void>;
  report(error: unknown): void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = React.useState("");
  const [all, setAll] = React.useState(false);
  const [profile, setProfile] = React.useState<ExternalAgentProfile>();
  const [custom, setCustom] = React.useState(false);
  const [source, setSource] = React.useState("install");
  const [command, setCommand] = React.useState("");
  const [name, setName] = React.useState("");
  const [args, setArgs] = React.useState<string[]>([]);
  const [version, setVersion] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const choose = (profile: ExternalAgentProfile) => {
    setProfile(profile);
    setCommand(profile.launch.command);
    setArgs(profile.launch.args);
    setName(profile.name);
    setSource("install");
    setVersion("");
  };
  const supported = (profile: ExternalAgentProfile) =>
    !settings.host ||
    (profile.platforms.includes(settings.host.platform) &&
      (!profile.platformArchitectures?.[settings.host.platform] ||
        profile.platformArchitectures[settings.host.platform]!.includes(
          settings.host.architecture,
        )));
  const canInstall =
    profile?.installation &&
    profile.installation.kind !== "external" &&
    supported(profile);
  const profiles =
    settings.profiles?.filter(
      (profile) =>
        !profile.productId &&
        (all ||
          !settings.agents.some(
            (agent) =>
              (agent.profileId ?? agent.id) === profile.id &&
              (agent.availability !== "auto" ||
                detections[agent.id]?.status === "available"),
          )) &&
        `${profile.name} ${profile.launch.command}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  React.useEffect(() => {
    if (!open) {
      setProfile(undefined);
      setCustom(false);
      setSearch("");
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="external-agent-catalog">
        <DialogHeader>
          <DialogTitle>
            {profile || custom
              ? name || t("external.manage.custom")
              : t("external.manage.add")}
          </DialogTitle>
          <DialogDescription>
            {deviceLabel} · {t("external.manage.catalogHint")}
          </DialogDescription>
        </DialogHeader>
        {profile || custom ? (
          <div className="ea-setup">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setProfile(undefined);
                setCustom(false);
              }}
            >
              <Icon name="arrow-left" className="size-4" />
              {t("external.manage.browse")}
            </Button>
            {profile && (
              <div className="ea-title">
                {mark(profile, true)}
                <div>
                  <strong>{profile.name}</strong>
                  <p>
                    {t(
                      `external.manage.product.${profile.productId ?? profile.id}` as I18nKey,
                    )}
                  </p>
                </div>
              </div>
            )}
            {(profile?.id === "dsh" || profile?.productId === "dsh") && (
              <Select
                value={profile.id}
                onValueChange={(id) =>
                  choose(settings.profiles!.find((value) => value.id === id)!)
                }
              >
                <SelectTrigger aria-label={t("external.manage.route")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dsh">
                    {t("external.manage.officialACP")}
                  </SelectItem>
                  <SelectItem value="deepseek-acp">
                    {t("external.manage.community")}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
            {!custom && (
              <div className="ea-install-choices">
                {["install", "existing"].map((value) => (
                  <button
                    key={value}
                    className="ea-install-choice"
                    aria-pressed={source === value}
                    onClick={() => setSource(value)}
                  >
                    <span className="ea-radio">
                      {source === value && <span />}
                    </span>
                    <span>
                      {t(
                        value === "existing"
                          ? "external.manage.chooseExisting"
                          : canInstall
                            ? "external.manage.installManaged"
                            : "external.manage.officialInstaller",
                      )}
                      <small>
                        {t(
                          value === "existing"
                            ? "external.manage.existingHint"
                            : canInstall
                              ? "external.manage.installHint"
                              : "external.manage.officialHint",
                        )}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {profile?.installation?.community && (
              <p className="ea-hint">{t("external.manage.communityHint")}</p>
            )}
            {profile &&
              ["openclaw", "zcode", "hermes", "antigravity"].includes(
                profile.id,
              ) && (
                <p className="ea-hint">
                  {t(`external.manage.note.${profile.id}` as I18nKey)}
                </p>
              )}
            {source === "install" && canInstall ? (
              <label>
                {t("external.manage.version")}
                <Input
                  placeholder={t("external.manage.latest")}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                />
              </label>
            ) : (
              <>
                {custom && (
                  <label>
                    {t("external.name")}
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                )}
                <label>
                  {t("external.command")}
                  <Input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </label>
                <Arguments value={args} onChange={setArgs} />
              </>
            )}
            <div className="ea-setup-actions">
              {source === "install" && !canInstall && profile?.installUrl && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void openExternalUrl(profile.installUrl!).catch(report)
                  }
                >
                  {t("external.installGuide")}
                </Button>
              )}
              <Button
                disabled={busy || submitting || !name.trim() || !command.trim()}
                onClick={() => {
                  const existing =
                    profile &&
                    settings.agents.find(
                      (agent) =>
                        agent.id === profile.id &&
                        agent.availability === "auto",
                    );
                  const agent: ExternalAgentConfiguration = {
                    id: existing?.id ?? crypto.randomUUID(),
                    ...(profile ? { profileId: profile.id } : {}),
                    name,
                    harness: profile?.harness ?? "acp",
                    enabled: true,
                    availability: "enabled",
                    command,
                    args,
                  };
                  setSubmitting(true);
                  void add(
                    agent,
                    Boolean(source === "install" && canInstall),
                    version,
                  )
                    .catch(report)
                    .finally(() => setSubmitting(false));
                }}
              >
                {t(
                  source === "install" && canInstall
                    ? "external.manage.install"
                    : "external.manage.add",
                )}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Input
              aria-label={t("external.manage.search")}
              placeholder={t("external.manage.search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="ea-catalog-tabs">
              <button aria-pressed={!all} onClick={() => setAll(false)}>
                {t("external.manage.available")}
              </button>
              <button aria-pressed={all} onClick={() => setAll(true)}>
                {t("external.manage.all")}
              </button>
            </div>
            <div className="ea-catalog-list">
              {profiles.map((profile) => (
                <button
                  className="ea-catalog-row"
                  key={profile.id}
                  onClick={() => choose(profile)}
                >
                  {mark(profile)}
                  <span>
                    <strong>{profile.name}</strong>
                    <small>
                      {t(`external.manage.product.${profile.id}` as I18nKey)}
                    </small>
                  </span>
                  <Icon name="arrow-right-s" className="size-4" />
                </button>
              ))}
              <button
                className="ea-catalog-row"
                onClick={() => {
                  setCustom(true);
                  setSource("existing");
                  setCommand("");
                  setName("ACP Agent");
                  setArgs([]);
                }}
              >
                <Icon name="terminal" className="size-6" />
                <span>{t("external.manage.custom")}</span>
                <Icon name="add" className="size-4" />
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
