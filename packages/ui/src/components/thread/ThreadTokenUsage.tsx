import { useI18n } from "@/lib/i18n";
import React from "react";
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
} from "@varin/application-client";
import type { ThreadUsage } from "@varin/protocol";
import type { ThreadIdentity } from "@varin/application-client";
import { useRuntimeAPIs } from "@/hooks/useRuntimeAPIs";
import { useThreadStore } from "@/stores/useThreadStore";
import { Button } from "@/components/ui/button";

import { Icon } from "@/components/icon/Icon";
import { ThreadUsageView } from "./ThreadUsageView";

/** Visible-demand projection of the original Catalog receipt metadata. */
export function ThreadTokenUsage({
  active = true,
  hostLabel,
  identity: requestedIdentity,
}: {
  active?: boolean;
  hostLabel?: string;
  identity?: ThreadIdentity;
}) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const selectedIdentity = useThreadStore((state) => state.selectedIdentity);
  const identity = requestedIdentity ?? selectedIdentity;
  const generation = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeEndpointGeneration,
    getRuntimeEndpointGeneration,
  );
  const owner = JSON.stringify([
    generation,
    identity?.threadId,
    identity?.branchId,
  ]);
  const [refresh, setRefresh] = React.useState(0);
  const [view, setView] = React.useState<{
    owner: string;
    data?: ThreadUsage;
    error?: string;
  }>({ owner: "" });
  React.useEffect(() => {
    if (!active || !identity || !api) {
      setView({ owner });
      return;
    }
    let alive = true;
    let dirty = false;
    let loading: Promise<void> | undefined;
    const controller = new AbortController();
    const current = () =>
      alive && generation === getRuntimeEndpointGeneration();
    const read = (): Promise<void> => {
      dirty = true;
      if (loading) return loading;
      loading = (async () => {
        while (dirty && current()) {
          dirty = false;
          const data = await api.usage(identity, controller.signal);
          if (
            data.threadId !== identity.threadId ||
            data.branchId !== identity.branchId
          )
            throw new Error(t("chat.usage.identityMismatch"));
          if (current()) setView({ owner, data });
        }
      })().finally(() => {
        loading = undefined;
      });
      return loading;
    };
    const fail = (error: unknown) => {
      if (current())
        setView((previous) => ({
          ...(previous.owner === owner ? previous : { owner }),
          error:
            error instanceof Error
              ? error.message
              : t("chat.usage.unavailable"),
        }));
    };
    void (async () => {
      const first = await api.usage(identity, controller.signal);
      if (!current()) return;
      if (
        first.threadId !== identity.threadId ||
        first.branchId !== identity.branchId
      )
        throw new Error(t("chat.usage.identityMismatch"));
      setView({ owner, data: first });
      await api.observe(
        first.throughCursor,
        (event) => {
          if (current() && "cursor" in event && "kind" in event)
            void read().catch(fail);
        },
        { signal: controller.signal },
      );
      if (current()) fail(new Error(t("chat.usage.disconnected")));
    })().catch(fail);
    return () => {
      alive = false;
      controller.abort();
    };
  }, [active, api, owner, generation, identity, refresh, t]);
  const shown = view.owner === owner ? view : undefined;
  return (
    <section className="py-4" aria-label={t("chat.usage.title")}>
      <div className="mb-4 flex items-center gap-3 px-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">
            {t("chat.usage.currentConversation")}
          </h3>
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={t("chat.usage.scopeHint")}
          >
            {[hostLabel, t("chat.usage.branchScope")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {identity && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("chat.mcp.refresh")}
            title={t("chat.mcp.refresh")}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Icon name="refresh" className="size-4" />
          </Button>
        )}
      </div>
      {!identity ? (
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">
          {t("chat.usage.selectConversation")}
        </p>
      ) : !api ? (
        <p role="alert" className="px-5 text-sm text-destructive">
          {t("chat.usage.unavailable")}
        </p>
      ) : (
        <>
          {shown?.error && (
            <p
              role="alert"
              className="mb-3 break-words px-5 text-xs text-destructive"
            >
              {shown.error}
            </p>
          )}
          {!shown?.data && !shown?.error && (
            <p
              role="status"
              className="px-5 py-6 text-sm text-muted-foreground"
            >
              {t("common.loading")}
            </p>
          )}
          {shown?.data && (
            <ThreadUsageView data={shown.data} active={active} owner={owner} />
          )}
        </>
      )}
    </section>
  );
}
