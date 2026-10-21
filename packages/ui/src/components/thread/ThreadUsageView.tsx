import React from "react";
import type { ThreadUsage, ThreadUsageRow } from "@varin/protocol";
import { useI18n, type I18nKey } from "@/lib/i18n";
import { Icon } from "@/components/icon/Icon";
import { ModelLogo } from "@/components/ui/ModelLogo";
import { useModelChannels } from "@/components/sections/harness/ConfigurationModels";
import {
  compactUsage,
  exactUsage,
  groupUsage,
  sumUsage,
  usageMetrics,
  visibleUsageTotals,
} from "./thread-usage";

const kinds: Record<ThreadUsageRow["kind"], I18nKey> = {
  conversation: "chat.usage.conversation",
  context: "chat.usage.context",
  planning: "chat.usage.planning",
  mcp_sampling: "chat.usage.mcp_sampling",
  auxiliary: "chat.usage.auxiliary",
};
const requests = (rows: ThreadUsageRow[]) =>
  rows.reduce((sum, row) => sum + row.requests, 0);

function UsageAmounts({ rows }: { rows: ThreadUsageRow[] }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs tabular-nums">
      {usageMetrics.slice(0, 2).map(([key, label]) => {
        const value = sumUsage(rows, key);
        return (
          <span
            key={key}
            className="inline-flex items-center gap-1"
            title={`${t(`contextSidebar.tokens.${label}`)}: ${exactUsage(value)}`}
          >
            <Icon
              name={key === "inputTokens" ? "arrow-down" : "arrow-up"}
              className="size-3 text-muted-foreground"
            />
            {compactUsage(value)}
          </span>
        );
      })}
    </span>
  );
}

export function ThreadUsageView({
  data,
  active,
  owner,
}: {
  data: ThreadUsage;
  active: boolean;
  owner: string;
}) {
  const { t } = useI18n();
  const { channels } = useModelChannels(active);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const rows = data.rows;
  const reported = rows.filter((row) => row.measurement === "actual");
  const estimated = rows.filter((row) => row.measurement === "estimated");
  const primary = reported.length ? reported : estimated;
  const pending = rows.reduce((sum, row) => sum + row.pendingRequests, 0);
  const unreported = rows
    .filter((row) => row.measurement === "missing")
    .reduce((sum, row) => sum + row.requests - row.pendingRequests, 0);
  return (
    <>
      {!rows.length ? (
        <div className="px-5 py-6 text-center">
          <Icon
            name="bar-chart-2"
            className="mx-auto mb-3 size-6 text-muted-foreground"
          />
          <p className="text-sm">{t("chat.usage.empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("chat.usage.emptyHint")}
          </p>
        </div>
      ) : (
        <>
          <dl className="mx-5 mb-3 flex items-start gap-4 overflow-x-auto py-1" aria-label={t("chat.usage.title")}>
            {visibleUsageTotals(primary).map(({ key, label, value }) => {
              return (
                <div
                  key={key}
                  className="flex-1 whitespace-nowrap"
                >
                  <dt className="text-xs text-muted-foreground">
                    {t(`contextSidebar.tokens.${label}`)}
                  </dt>
                  <dd
                    className="mt-1 text-xl font-medium leading-tight tracking-tight tabular-nums"
                    title={exactUsage(value)}
                  >
                    {compactUsage(value)}
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="mx-5 mb-4 space-y-1.5 text-xs text-muted-foreground">
            <p>
              {t(
                reported.length
                  ? "chat.usage.reportedTotal"
                  : estimated.length
                    ? "chat.usage.estimatedTotal"
                    : "chat.usage.awaitingUsage",
              )}
            </p>
            <p className="flex flex-wrap gap-x-2 gap-y-1">
              <span>{t("chat.usage.requests", { count: requests(rows) })}</span>
              {reported.length > 0 && (
                <span>
                  ·{" "}
                  {t("chat.usage.reportedRequests", {
                    count: requests(reported),
                  })}
                </span>
              )}
              {estimated.length > 0 && (
                <span>
                  ·{" "}
                  {t("chat.usage.estimatedRequests", {
                    count: requests(estimated),
                  })}
                </span>
              )}
              {unreported > 0 && (
                <span className="text-[var(--status-warning)]">
                  · {t("chat.usage.unreportedRequests", { count: unreported })}
                </span>
              )}
              {pending > 0 && (
                <span role="status">
                  · {t("chat.usage.pending", { count: pending })}
                </span>
              )}
            </p>
            {reported.length > 0 && estimated.length > 0 && (
              <p className="flex items-center justify-between gap-2">
                <span>{t("chat.usage.estimated")}</span>
                <UsageAmounts rows={estimated} />
              </p>
            )}
          </div>
          <p className="mb-1 px-5 text-xs text-muted-foreground">
            {t("chat.usage.byModel")}
          </p>
          <div className="px-2">
            {groupUsage(rows).map((group) => {
              const channel = channels.find(
                (channel) => channel.id === group.providerId,
              );
              const model =
                channel?.models.find((model) => model.id === group.modelId) ??
                channel?.models.find(
                  (model) => model.requestModelId === group.modelId,
                );
              const name = model?.name || group.modelId;
              const actual = group.rows.filter(
                (row) => row.measurement === "actual",
              );
              const estimates = group.rows.filter(
                (row) => row.measurement === "estimated",
              );
              const measured = actual.length ? actual : estimates;
              const open = expanded === `${owner}:${group.key}`;
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded(open ? null : `${owner}:${group.key}`)
                    }
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ModelLogo modelId={group.modelId} displayName={name} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">
                        {name}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {channel?.name ||
                          t(
                            group.providerId
                              ? "chat.usage.unavailableChannel"
                              : "chat.usage.unrecordedChannel",
                          )}{" "}
                        ·{" "}
                        {t("chat.usage.requests", {
                          count: requests(group.rows),
                        })}
                      </span>
                    </span>
                    <span className="max-w-[40%] shrink-0 text-right">
                      {measured.length ? (
                        <>
                          <UsageAmounts rows={measured} />
                          {!actual.length && (
                            <span className="mt-1 block text-[11px] text-muted-foreground">
                              {t("chat.usage.estimated")}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t(
                            group.rows.every(
                              (row) => row.pendingRequests === row.requests,
                            )
                              ? "chat.usage.awaitingUsage"
                              : "chat.usage.unreported",
                          )}
                        </span>
                      )}
                    </span>
                    <Icon
                      name={open ? "arrow-down-s" : "arrow-right-s"}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  </button>
                  {open && (
                    <div className="mx-3 mb-2 space-y-3 border-b border-border/50 px-3 pb-4 pt-1">
                      {(["actual", "estimated"] as const).map((measurement) => {
                        const subset = group.rows.filter(
                          (row) => row.measurement === measurement,
                        );
                        if (!subset.length) return null;
                        return (
                          <div key={measurement}>
                            <p className="mb-2 text-xs font-medium">
                              {t(
                                measurement === "actual"
                                  ? "chat.usage.actual"
                                  : "chat.usage.estimated",
                              )}
                            </p>
                            <dl className="space-y-1.5 text-xs">
                              {visibleUsageTotals(subset)
                                .filter(
                                  ({ value }) => value.known !== null,
                                )
                                .map(({ key, label, value }) => (
                                  <div
                                    key={key}
                                    className="flex justify-between gap-3"
                                  >
                                    <dt className="text-muted-foreground">
                                      {t(`contextSidebar.tokens.${label}`)}
                                    </dt>
                                    <dd className="break-all text-right tabular-nums">
                                      {exactUsage(value)}
                                    </dd>
                                  </div>
                                ))}
                            </dl>
                          </div>
                        );
                      })}
                      <div className="space-y-1.5 border-t border-border/50 pt-2">
                        {Object.keys(kinds).map((kind) => {
                          const subset = group.rows.filter(
                            (row) => row.kind === kind,
                          );
                          return subset.length ? (
                            <div
                              key={kind}
                              className="flex justify-between gap-3 text-xs text-muted-foreground"
                            >
                              <span>
                                {t(kinds[kind as ThreadUsageRow["kind"]])}
                              </span>
                              <span>
                                {t("chat.usage.requests", {
                                  count: requests(subset),
                                })}
                              </span>
                            </div>
                          ) : null;
                        })}
                      </div>
                      {group.rows.some(
                        (row) =>
                          row.measurement === "missing" ||
                          usageMetrics.some(([key]) => row[key].missing > 0),
                      ) && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t("chat.usage.partialHint")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="mt-3 border-t border-border/50 px-5 pt-3 text-[11px] leading-relaxed text-muted-foreground">
        {t("chat.usage.scopeHint")}
        {data.notDispatchedRequests > 0
          ? ` · ${t("chat.usage.notDispatched", { count: data.notDispatchedRequests })}`
          : ""}
      </p>
    </>
  );
}
