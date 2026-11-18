import React from "react";
import {
  createExternalAgentsHttpAPI,
  type ExternalAgentCapabilityCache,
  type ExternalAgentDefaults,
} from "@varin/application-client";
import {
  useExternalAgents,
  useExternalAgentStore,
} from "@/stores/useExternalAgentStore";
import { SettingsFieldRow } from "@/components/sections/shared/SettingsSection";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n";
import { externalThinkingOptions } from "@/components/thread/externalSessionChoice";

export function AgentDefaultsFields({
  value,
  cache,
  disabled,
  onChange,
}: {
  value: ExternalAgentDefaults | undefined;
  cache: ExternalAgentCapabilityCache | undefined;
  disabled: boolean;
  onChange(value: ExternalAgentDefaults | undefined): void;
}) {
  const { t } = useI18n();
  const capabilities = cache?.capabilities;
  const levels =
    externalThinkingOptions(value ?? {}, capabilities).levels ?? [];
  const fields = [
    {
      key: "model" as const,
      label: t("external.model"),
      options: capabilities?.models ?? [],
    },
    {
      key: "thinking" as const,
      label: t("chat.context.thinking"),
      options: levels.map((id) => ({ id, name: id })),
    },
    {
      key: "mode" as const,
      label: t("external.mode"),
      options: capabilities?.modes ?? [],
    },
  ];
  const change = (key: keyof ExternalAgentDefaults, selected: string) => {
    const next = { ...value };
    if (selected === "inherit") delete next[key];
    else next[key] = selected.slice("value:".length);
    // Effort belongs to a particular model. Never leave a hidden override behind.
    if (
      key === "model" &&
      next.thinking &&
      !externalThinkingOptions(next, capabilities).levels?.includes(
        next.thinking,
      )
    )
      delete next.thinking;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <section className="ea-defaults space-y-3">
      <h2 className="typography-ui-label font-medium">
        {t("external.defaultsTitle")}
      </h2>
      <p className="typography-meta text-muted-foreground">
        {t("external.defaultsHint")}
      </p>
      {!cache && (
        <p className="typography-meta text-muted-foreground">
          {t("external.defaultsUnavailable")}
        </p>
      )}
      {fields
        .filter(
          (field) =>
            field.key !== "thinking" || field.options.length || value?.thinking,
        )
        .map((field) => {
          const selected = value?.[field.key];
          const stale = Boolean(
            selected && !field.options.some((option) => option.id === selected),
          );
          return (
            <div key={field.key} className="space-y-1">
              <SettingsFieldRow label={field.label}>
                <Select
                  value={selected ? `value:${selected}` : "inherit"}
                  disabled={disabled || (!field.options.length && !selected)}
                  onValueChange={(next) => change(field.key, next)}
                >
                  <SelectTrigger
                    className="w-56 max-w-full"
                    aria-label={`${t("external.defaultsTitle")} · ${field.label}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">
                      {t("external.inherit")}
                    </SelectItem>
                    {stale && (
                      <SelectItem value={`value:${selected}`} disabled>
                        {selected} · {t("external.notReported")}
                      </SelectItem>
                    )}
                    {field.options.map((option) => (
                      <SelectItem key={option.id} value={`value:${option.id}`}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
              {stale && (
                <p
                  role="status"
                  className="typography-meta text-muted-foreground"
                >
                  {t("external.defaultsStale")}
                </p>
              )}
            </div>
          );
        })}
    </section>
  );
}

export function ExternalAgentDefault() {
  const { t } = useI18n();
  const settings = useExternalAgents();
  const [error, setError] = React.useState("");
  return (
    <>
      <SettingsFieldRow label={t("external.default")} settingsItem="sessions.default-agent">
        <Select
          value={settings?.defaultAgent ?? "varin"}
          disabled={!settings}
          onValueChange={(value) => {
            if (!settings) return;
            void createExternalAgentsHttpAPI()
              .configure(
                {
                  agents: settings.agents,
                  defaultAgent: value === "varin" ? null : value,
                },
                settings.revision,
                crypto.randomUUID(),
              )
              .then(
                () => useExternalAgentStore.getState().refresh(),
                (error) => setError(String(error)),
              );
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="varin">Varin</SelectItem>
            {settings?.agents
              .filter((v) => v.enabled || v.id === settings.defaultAgent)
              .map((v) => (
                <SelectItem key={v.id} value={v.id} disabled={!v.enabled}>
                  {v.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {error && (
        <p role="alert" className="text-destructive typography-meta">
          {error}
        </p>
      )}
    </>
  );
}
