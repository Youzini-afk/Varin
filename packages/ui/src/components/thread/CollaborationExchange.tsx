import React from "react";
import type {
  ThreadCodeExchange,
  ThreadExchangeFileContent,
  ThreadIdentity,
  ThreadsAPI,
} from "@varin/application-client";
import type { MessageFeedEntry } from "@varin/protocol";
import { Icon } from "@/components/icon/Icon";
import { Button } from "@/components/ui/button";
import { useI18n, type I18nKey } from "@/lib/i18n";
import { getLanguageFromExtension } from "@/lib/toolHelpers";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/ui/AgentAvatar";
import type { CollaborationMember } from "./collaborationFeed";
import { exchangeSummary } from "./collaborationPresentation";

const PierreDiffViewer = React.lazy(() =>
  import("@/components/views/PierreDiffViewer").then((module) => ({
    default: module.PierreDiffViewer,
  })),
);
const stateLabels: Record<string, I18nKey> = {
  complete: "collaboration.exchangeApplied",
  applied: "collaboration.exchangeApplied",
  conflict: "collaboration.exchangeConflict",
  compensated: "collaboration.exchangeCompensated",
  undone: "collaboration.exchangeCompensated",
  "needs-attention": "collaboration.exchangeAttention",
  needs_attention: "collaboration.exchangeAttention",
  aborted: "collaboration.exchangeAborted",
  unchanged: "collaboration.exchangeUnchanged",
};
export function ExchangeState({ state }: { state: string }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "typography-micro",
        ["complete", "applied"].includes(state)
          ? "text-[var(--status-success)]"
          : "text-muted-foreground",
      )}
    >
      {stateLabels[state] ? t(stateLabels[state]) : state}
    </span>
  );
}
export function CollaborationExchangeCard({
  message,
  onOpen,
}: {
  message: MessageFeedEntry;
  onOpen(): void;
}) {
  const { t } = useI18n();
  const summary = exchangeSummary(message);
  if (!summary) return null;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-[var(--surface-elevated)]">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3 typography-meta">
        <Icon name="file-transfer" className="size-4 text-primary" />
        <span className="font-medium">{t("collaboration.fileExchange")}</span>
        <span className="ml-auto typography-micro text-muted-foreground">
          {t("collaboration.fileCount", { count: summary.files.length })}
        </span>
      </div>
      <div className="space-y-1 px-3 pb-3">
        {summary.files.slice(0, 3).map((path) => (
          <div
            key={path}
            className="flex items-center gap-2 typography-micro text-muted-foreground"
          >
            <Icon name="file-code" className="size-3.5 shrink-0" />
            <span className="truncate" title={path}>
              {path}
            </span>
          </div>
        ))}
        {summary.files.length > 3 && (
          <button
            type="button"
            onClick={onOpen}
            className="typography-micro text-muted-foreground hover:text-foreground"
          >
            {t("collaboration.remainingFiles", {
              count: summary.files.length - 3,
            })}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
        <ExchangeState state={summary.state} />
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 typography-micro hover:text-primary"
        >
          {t("collaboration.viewChanges")}
          <Icon name="arrow-right-s" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
const textOf = (content: ThreadExchangeFileContent) =>
  content.kind === "text"
    ? content.text
    : content.kind === "missing"
      ? ""
      : undefined;
export function CollaborationExchange({
  api,
  identity,
  message,
  members,
  onBack,
  onReply,
  onMember,
}: {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  message: MessageFeedEntry;
  members: CollaborationMember[];
  onBack(): void;
  onReply(): void;
  onMember(threadId: string): void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = React.useState<ThreadCodeExchange>();
  const [selected, setSelected] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void api
      .collaboration!.exchange(
        identity,
        {
          messageId: message.messageId,
          senderThreadId: message.senderThreadId,
          senderBranchId: message.senderBranchId,
          ...(selected === undefined ? {} : { path: selected }),
        },
        controller.signal,
      )
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          setDetail(value);
          if (selected === undefined && value.files.length)
            setSelected(value.files[0]!.path);
        },
        (failure) => {
          if (!controller.signal.aborted)
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
        },
      );
    return () => controller.abort();
  }, [
    api,
    identity,
    message.messageId,
    message.senderThreadId,
    message.senderBranchId,
    selected,
    retry,
  ]);
  const file =
    detail?.file && detail.file.path === selected ? detail.file : undefined;
  const before = file && textOf(file.before),
    after = file && textOf(file.after);
  const member = (id: string) => {
    const item = members.find((member) => member.threadId === id);
    return (
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 hover:text-primary"
        onClick={() => onMember(id)}
      >
        <AgentAvatar identity={id} avatar={item?.avatar} size={25} />
        <span className="truncate">{item?.name || item?.agentId || id}</span>
      </button>
    );
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("collaboration.fileExchange")}
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-3 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onBack}
          aria-label={t("collaboration.back")}
        >
          <Icon name="arrow-left" className="size-4" />
        </Button>
        <div>
          <p className="typography-ui-label">
            {t("collaboration.fileExchange")}
          </p>
          <p className="typography-micro text-muted-foreground">
            {new Date(message.acceptedAtMs).toLocaleString()}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="mb-3 typography-meta text-destructive">
            {error}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t("chat.family.retry")}
            </Button>
          </p>
        )}
        {detail && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 typography-meta">
              {member(detail.sourceThreadId)}
              <Icon
                name="arrow-right"
                className="size-3.5 text-muted-foreground"
              />
              {member(detail.targetThreadId)}
            </div>
            <ExchangeState state={detail.state} />
            {detail.targetDirectory && (
              <p className="mt-1 break-all typography-micro text-muted-foreground">
                {detail.targetDirectory}
              </p>
            )}
            <div className="my-3 overflow-hidden rounded-lg border border-border/60">
              {detail.files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  onClick={() => setSelected(file.path)}
                  aria-pressed={selected === file.path}
                  className={cn(
                    "flex w-full items-center gap-2 border-b border-border/30 px-3 py-2 text-left last:border-b-0 hover:bg-interactive-hover",
                    selected === file.path && "bg-primary/10",
                  )}
                >
                  <Icon
                    name="file-code"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 break-all typography-meta">
                    {file.path}
                  </span>
                  {file.state === "applied" ? (
                    file.target === "surface" ? (
                      <span className="typography-micro text-muted-foreground">
                        {t("chat.fileChange.draft")}
                      </span>
                    ) : (
                      <Icon
                        name="check"
                        className="size-3.5 text-[var(--status-success)]"
                      />
                    )
                  ) : (
                    <ExchangeState state={file.state} />
                  )}
                </button>
              ))}
            </div>
            <p className="mb-2 typography-micro text-muted-foreground">
              {t("collaboration.recordedChanges")}
            </p>
          </>
        )}
        {file && before !== undefined && after !== undefined ? (
          <React.Suspense
            fallback={
              <p
                role="status"
                className="typography-meta text-muted-foreground"
              >
                {t("common.loading")}
              </p>
            }
          >
            <PierreDiffViewer
              key={file.path}
              original={before}
              modified={after}
              fileName={file.path}
              language={getLanguageFromExtension(file.path) ?? "text"}
              renderSideBySide={false}
              wrapLines
              layout="inline"
              enableComments={false}
            />
          </React.Suspense>
        ) : file ? (
          <div className="space-y-2 typography-meta text-muted-foreground">
            <p>{t("collaboration.nonTextVersions")}</p>
            <p>
              {file.before.kind} → {file.after.kind}
            </p>
            {file.before.kind === "binary" && (
              <p>{file.before.byteLength.toLocaleString()} B</p>
            )}
            {file.after.kind === "binary" && (
              <p>{file.after.byteLength.toLocaleString()} B</p>
            )}
          </div>
        ) : !error ? (
          <p role="status" className="typography-meta text-muted-foreground">
            {t(
              detail && !detail.files.length
                ? "collaboration.exchangeUnchanged"
                : "common.loading",
            )}
          </p>
        ) : null}
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-border/50 p-3">
        <Button type="button" size="sm" variant="ghost" onClick={onReply}>
          <Icon name="reply" className="size-4" />
          {t("collaboration.replyExchange")}
        </Button>
        {detail && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onMember(detail.targetThreadId)}
          >
            <Icon name="chat-1" className="size-4" />
            {t("collaboration.recipientConversation")}
          </Button>
        )}
      </footer>
    </section>
  );
}
