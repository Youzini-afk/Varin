import React from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
  type ThreadIdentity,
  type ThreadsAPI,
} from "@varin/application-client";
import type { MessageFeedEntry } from "@varin/protocol";
import { Icon } from "@/components/icon/Icon";
import { AgentAvatar } from "@/components/ui/AgentAvatar";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useThreadDraftStore } from "@/stores/useThreadDraftStore";
import { threadHostKey, threadComposerKey } from "@/stores/useThreadStore";
import { openThreadFromNavigation } from "@/lib/agent-runtime/threadNavigation";
import { ChildState } from "../conversation/childPresentation";
import {
  CollaborationFeed,
  type CollaborationMember,
} from "./collaborationFeed";
import { CollaborationComposer } from "./CollaborationComposer";
import { memberBranch, exchangeSummary } from "./collaborationPresentation";
import {
  CollaborationExchange,
  CollaborationExchangeCard,
} from "./CollaborationExchange";
const CollaborationConversation = React.lazy(() =>
  import("./CollaborationConversation").then((module) => ({
    default: module.CollaborationConversation,
  })),
);

type Props = { api: ThreadsAPI; identity: ThreadIdentity };
type Selection =
  | { kind: "member"; identity: ThreadIdentity }
  | { kind: "exchange"; message: MessageFeedEntry };
export function ThreadCollaboration(props: Props) {
  const host = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeEndpointGeneration,
    getRuntimeEndpointGeneration,
  );
  const identity = React.useMemo(
    () => ({
      runtime: "agent" as const,
      threadId: props.identity.threadId,
      branchId: props.identity.branchId,
    }),
    [props.identity.threadId, props.identity.branchId],
  );
  return (
    <CollaborationRoom
      key={`${host}:${identity.threadId}:${identity.branchId}`}
      api={props.api}
      identity={identity}
      host={host}
    />
  );
}
function CollaborationRoom({ api, identity, host }: Props & { host: number }) {
  const { t } = useI18n();
  const [feed, setFeed] = React.useState<CollaborationFeed>();
  React.useEffect(() => {
    const reader = new CollaborationFeed(api, identity);
    setFeed(reader);
    void reader.start();
    return () => reader.close();
  }, [api, identity]);
  return feed ? (
    <CollaborationRoomContent
      api={api}
      identity={identity}
      host={host}
      feed={feed}
    />
  ) : (
    <p className="p-4 typography-meta text-muted-foreground">
      {t("common.loading")}
    </p>
  );
}
function CollaborationRoomContent({
  api,
  identity,
  host,
  feed,
}: Props & { host: number; feed: CollaborationFeed }) {
  const { t } = useI18n();
  const state = React.useSyncExternalStore(
    feed.subscribe,
    feed.getSnapshot,
    feed.getSnapshot,
  );
  const [selection, setSelection] = React.useState<Selection>();
  const selectionRequest = React.useRef(0);
  const select = (next?: Selection) => {
    selectionRequest.current += 1;
    setSelection(next);
  };
  const [memberMenu, setMemberMenu] = React.useState(false);
  const [actionError, setActionError] = React.useState<string>();
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const root = state.members.find(
    (member) => member.threadId === state.rootThreadId,
  );
  const current = state.members
    .filter(
      (member) =>
        member.detail?.current || member.threadId === state.rootThreadId,
    )
    .sort((a, b) =>
      a.threadId === state.rootThreadId
        ? -1
        : b.threadId === state.rootThreadId
          ? 1
          : 0,
    );
  const ended = state.members.filter(
    (member) =>
      member.detail &&
      !member.detail.current &&
      member.threadId !== state.rootThreadId,
  );
  const find = (id: string) =>
    state.members.find((member) => member.threadId === id);
  const name = (id: string) => find(id)?.name || find(id)?.agentId || id;
  const roomKey = `${threadComposerKey(threadHostKey(), identity)}:collaboration`;
  const draftKey =
    selection?.kind === "member"
      ? `${roomKey}:${selection.identity.threadId}:${selection.identity.branchId}`
      : roomKey;
  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await action();
    } catch (failure) {
      if (alive.current && host === getRuntimeEndpointGeneration())
        setActionError(
          failure instanceof Error ? failure.message : String(failure),
        );
    }
  };
  const openMember = (threadId: string, branchId?: string) => {
    const request = ++selectionRequest.current;
    setActionError(undefined);
    void feed.resolveMember(threadId).then(
      (member) => {
        const targetBranch =
          branchId ??
          memberBranch(
            member,
            threadId === identity.threadId ? identity.branchId : undefined,
          );
        if (
          !targetBranch ||
          !alive.current ||
          host !== getRuntimeEndpointGeneration() ||
          selectionRequest.current !== request
        )
          return;
        setMemberMenu(false);
        setSelection({
          kind: "member",
          identity: { runtime: "agent", threadId, branchId: targetBranch },
        });
      },
      (failure) => {
        if (
          alive.current &&
          host === getRuntimeEndpointGeneration() &&
          selectionRequest.current === request
        )
          setActionError(
            failure instanceof Error ? failure.message : String(failure),
          );
      },
    );
  };
  const reply = (message: MessageFeedEntry) => {
    const target =
      message.actor.kind === "user"
        ? {
            runtime: "agent" as const,
            threadId: message.targetThreadId,
            branchId: message.targetBranchId,
          }
        : {
            runtime: "agent" as const,
            threadId: message.senderThreadId,
            branchId: message.senderBranchId,
          };
    useThreadDraftStore.getState().patch(roomKey, (draft) => ({
      collaboration: draft.collaboration?.attempts
        ? draft.collaboration
        : { targets: [target], reply: message },
    }));
    select();
  };
  const quote = React.useCallback(
    (text: string) =>
      useThreadDraftStore
        .getState()
        .patch(draftKey, (draft) =>
          draft.collaboration?.attempts
            ? {}
            : { text: [draft.text, text].filter(Boolean).join("\n\n") },
        ),
    [draftKey],
  );
  const list = React.useRef<LegendListRef>(null);
  const [atEnd, setAtEnd] = React.useState(true);
  const selectedMember =
    selection?.kind === "member"
      ? find(selection.identity.threadId)
      : undefined;
  const memberItem = (member: CollaborationMember) => (
    <DropdownMenuItem
      key={member.threadId}
      onClick={() => openMember(member.threadId)}
    >
      <AgentAvatar
        identity={member.threadId}
        avatar={member.avatar}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate typography-meta">
          {member.name || member.agentId}
        </p>
        <p className="typography-micro text-muted-foreground">
          {member.agentId}
        </p>
      </div>
      {member.detail && <ChildState state={member.detail.state} />}
    </DropdownMenuItem>
  );
  const viewMember = (id: string, branch: string, className = "") => (
    <button
      type="button"
      className={cn("min-w-0 truncate hover:text-primary", className)}
      onClick={() => openMember(id, branch)}
    >
      {name(id)}
    </button>
  );
  const renderMessage = ({
    item: message,
    index,
  }: {
    item: MessageFeedEntry;
    index: number;
  }) => {
    const sender = find(message.senderThreadId);
    const exchange = exchangeSummary(message);
    const original = message.replyTo
      ? state.messages.find((item) => item.messageId === message.replyTo)
      : undefined;
    const day = new Date(message.acceptedAtMs).toLocaleDateString();
    const previous = state.messages[index - 1];
    const showDay =
      !previous || day !== new Date(previous.acceptedAtMs).toLocaleDateString();
    const sourceId =
      exchange && typeof exchange.source?.threadId === "string"
        ? exchange.source.threadId
        : message.senderThreadId;
    const targetId =
      exchange && typeof exchange.target?.threadId === "string"
        ? exchange.target.threadId
        : message.targetThreadId;
    return (
      <div className="px-4 pb-6">
        {showDay && (
          <div className="mb-5 mt-1 flex items-center gap-3 typography-micro text-muted-foreground">
            <span className="h-px flex-1 bg-border/40" />
            {day}
            <span className="h-px flex-1 bg-border/40" />
          </div>
        )}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <article
              className="group/collaboration-message relative flex gap-2.5"
              data-message-id={message.messageId}
            >
              {message.actor.kind === "user" ? (
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 typography-micro text-primary">
                  {t("collaboration.you")}
                </span>
              ) : (
                <button
                  type="button"
                  className="mt-0.5 self-start"
                  onClick={() =>
                    openMember(message.senderThreadId, message.senderBranchId)
                  }
                  aria-label={t("collaboration.viewMember", {
                    name: name(message.senderThreadId),
                  })}
                >
                  <AgentAvatar
                    identity={message.senderThreadId}
                    avatar={sender?.avatar}
                    size={28}
                  />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 typography-micro text-muted-foreground">
                  {message.actor.kind === "user" ? (
                    <span className="font-medium text-foreground">
                      {t("collaboration.you")}
                    </span>
                  ) : (
                    viewMember(
                      sourceId,
                      sourceId === message.senderThreadId
                        ? message.senderBranchId
                        : message.targetBranchId,
                      "font-medium text-foreground",
                    )
                  )}
                  <Icon name="arrow-right" className="size-3 shrink-0" />
                  {viewMember(
                    targetId,
                    targetId === message.targetThreadId
                      ? message.targetBranchId
                      : message.senderBranchId,
                  )}
                  <time
                    className="ml-auto pl-1"
                    dateTime={new Date(message.acceptedAtMs).toISOString()}
                  >
                    {new Date(message.acceptedAtMs).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {message.replyTo && (
                  <div className="mb-1 mt-2 truncate border-l-2 border-border pl-2 typography-micro text-muted-foreground">
                    {t("chat.messages.reply")} ·{" "}
                    {original
                      ? original.codeExchangeOperationId
                        ? t("collaboration.fileExchange")
                        : original.text
                      : t("collaboration.earlierMessage")}
                  </div>
                )}
                {exchange ? (
                  <CollaborationExchangeCard
                    message={message}
                    onOpen={() => select({ kind: "exchange", message })}
                  />
                ) : (
                  <div
                    className={cn(
                      "mt-1 break-words typography-meta leading-relaxed",
                      message.actor.kind === "user" &&
                        "rounded-r-lg rounded-bl-lg bg-primary/10 px-3 py-2",
                    )}
                  >
                    <MarkdownRenderer
                      messageId={`collaboration:${message.messageId}`}
                      content={message.text}
                      enableFileReferences={false}
                    />
                  </div>
                )}
                {message.activation.state === "failed" ? (
                  <p
                    role="status"
                    title={message.activation.code}
                    className="mt-1 typography-micro text-destructive"
                  >
                    {t("chat.messages.failed")}
                  </p>
                ) : message.state === "cancelled" ? (
                  <p className="mt-1 typography-micro text-muted-foreground">
                    {t("chat.messages.cancelled")}
                  </p>
                ) : message.actor.kind === "user" &&
                  message.state === "queued" ? (
                  <p className="mt-1 typography-micro text-muted-foreground">
                    {t("chat.messages.queued")}
                  </p>
                ) : null}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="absolute -right-1 -top-5 rounded bg-[var(--surface-elevated)] p-1 text-muted-foreground opacity-100 sm:opacity-0 sm:group-hover/collaboration-message:opacity-100 sm:group-focus-within/collaboration-message:opacity-100"
                    aria-label={t("collaboration.messageActions")}
                  >
                    <Icon name="more" className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => reply(message)}>
                    <Icon name="reply" className="size-4" />
                    {t("chat.messages.reply")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void runAction(() =>
                        navigator.clipboard.writeText(message.text),
                      )
                    }
                  >
                    <Icon name="file-copy" className="size-4" />
                    {t("collaboration.copyMessage")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </article>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => reply(message)}>
              <Icon name="reply" className="size-4" />
              {t("chat.messages.reply")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                openMember(message.senderThreadId, message.senderBranchId)
              }
            >
              <Icon name="chat-1" className="size-4" />
              {t("harness.threads.openConversation")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                void runAction(() =>
                  navigator.clipboard.writeText(message.text),
                )
              }
            >
              <Icon name="file-copy" className="size-4" />
              {t("collaboration.copyMessage")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    );
  };
  const error = actionError ?? state.error;
  const defaultBranch = memberBranch(
    root,
    state.rootThreadId === identity.threadId ? identity.branchId : undefined,
  );
  const defaultTarget: ThreadIdentity | undefined = defaultBranch
    ? {
        runtime: "agent",
        threadId: state.rootThreadId,
        branchId: defaultBranch,
      }
    : undefined;
  return (
    <section
      className="collaboration-room flex h-full min-h-0 flex-col bg-background"
      aria-label={t("collaboration.title")}
    >
      {selection?.kind === "exchange" && (
        <CollaborationExchange
          api={api}
          identity={identity}
          message={selection.message}
          members={state.members}
          onBack={() => select()}
          onReply={() => reply(selection.message)}
          onMember={openMember}
        />
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          selection?.kind === "exchange" && "hidden",
        )}
      >
        <header className="shrink-0 border-b border-border/50 px-4 pb-3 pt-3">
          {selection?.kind === "member" ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1 size-7"
                onClick={() => select()}
                aria-label={t("collaboration.back")}
              >
                <Icon name="arrow-left" className="size-4" />
              </Button>
              <AgentAvatar
                identity={selection.identity.threadId}
                avatar={selectedMember?.avatar}
                size={30}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate typography-ui-label">
                  {name(selection.identity.threadId)}
                </p>
                <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                  {selectedMember?.detail && (
                    <ChildState state={selectedMember.detail.state} />
                  )}
                  <span>{selectedMember?.agentId}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() =>
                  void runAction(() =>
                    openThreadFromNavigation(selection.identity),
                  )
                }
                aria-label={t("collaboration.openMain")}
                title={t("collaboration.openMain")}
              >
                <Icon name="external-link" className="size-4" />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
                  {root?.name || t("collaboration.team")}
                </p>
                <DropdownMenu open={memberMenu} onOpenChange={setMemberMenu}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={t("collaboration.members")}
                    >
                      <Icon name="group" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-h-[70vh] w-72 overflow-y-auto"
                  >
                    <DropdownMenuLabel>
                      {t("collaboration.currentMembers")}
                    </DropdownMenuLabel>
                    {current.map(memberItem)}
                    {state.currentCursor && (
                      <DropdownMenuItem
                        closeOnClick={false}
                        onClick={() => void feed.loadMembers("current")}
                      >
                        {t("collaboration.moreMembers")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      {t("chat.family.history")}
                    </DropdownMenuLabel>
                    {ended.map(memberItem)}
                    {(!state.historyLoaded || state.historyCursor) && (
                      <DropdownMenuItem
                        closeOnClick={false}
                        onClick={() => void feed.loadMembers("history")}
                      >
                        {t("collaboration.moreEnded")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {current.slice(0, 3).map((member) => (
                  <button
                    type="button"
                    key={member.threadId}
                    className="flex max-w-full items-center gap-1.5 rounded-lg py-1 pl-0.5 pr-2 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    onClick={() => openMember(member.threadId)}
                  >
                    <AgentAvatar
                      identity={member.threadId}
                      avatar={member.avatar}
                      size={27}
                    />
                    <span className="max-w-32 truncate">
                      {member.name || member.agentId}
                    </span>
                  </button>
                ))}
                {current.length > 3 && (
                  <button
                    type="button"
                    className="rounded-lg px-2 typography-micro text-muted-foreground hover:bg-interactive-hover"
                    aria-label={t("collaboration.members")}
                    onClick={() => setMemberMenu(true)}
                  >
                    +{current.length - 3}
                  </button>
                )}
              </div>
            </>
          )}
          {selection?.kind === "member" &&
            (selectedMember?.detail?.branches.length ?? 0) > 1 && (
              <select
                aria-label={t("chat.family.branch")}
                value={selection.identity.branchId}
                className="mt-2 w-full rounded border border-border bg-background p-1 typography-micro"
                onChange={(event) =>
                  openMember(selection.identity.threadId, event.target.value)
                }
              >
                {selectedMember!.detail!.branches.map((branch, index) => (
                  <option value={branch.branchId} key={branch.branchId}>
                    {t("chat.family.branch")} {index + 1}
                  </option>
                ))}
              </select>
            )}
        </header>
        {error && (
          <p
            role="alert"
            className="shrink-0 px-4 py-2 typography-meta text-destructive"
          >
            {error}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActionError(undefined);
                void feed.retry();
              }}
            >
              {t("chat.family.retry")}
            </Button>
          </p>
        )}
        <div
          className={cn(
            "collaboration-feed relative flex min-h-0 flex-1",
            selection && "hidden",
          )}
          aria-hidden={Boolean(selection)}
        >
          {state.ready && state.messages.length ? (
            <LegendList
              ref={list}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
              contentContainerClassName="pt-4"
              data={state.messages}
              dataKey={roomKey}
              keyExtractor={(item) => item.messageId}
              renderItem={renderMessage}
              recycleItems={false}
              initialScrollIndex={{
                index: state.messages.length - 1,
                viewPosition: 1,
              }}
              maintainScrollAtEnd
              maintainVisibleContentPosition={{ data: true, size: true }}
              onStartReached={() => {
                if (!selection && !state.error) void feed.earlier();
              }}
              onStartReachedThreshold={1}
              onScroll={(event) => {
                const { contentOffset, contentSize, layoutMeasurement } =
                  event.nativeEvent;
                setAtEnd(
                  contentSize.height -
                    contentOffset.y -
                    layoutMeasurement.height <
                    48,
                );
              }}
              ListHeaderComponent={
                state.error && state.before !== null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void feed.earlier()}
                  >
                    {t("chat.history.retry")}
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
              <Icon name="chat-1" className="size-7 opacity-60" />
              <p className="max-w-64 typography-meta">
                {t(state.ready ? "collaboration.empty" : "common.loading")}
              </p>
            </div>
          )}
          {!atEnd && (
            <Button
              variant="outline"
              size="sm"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-sm"
              onClick={() => list.current?.scrollToEnd({ animated: false })}
            >
              <Icon name="arrow-down" className="size-3.5" />
              {t("chat.scrollToBottom.aria")}
            </Button>
          )}
        </div>
        {selection?.kind === "member" && (
          <React.Suspense
            fallback={
              <p className="p-4 typography-meta text-muted-foreground">
                {t("common.loading")}
              </p>
            }
          >
            <CollaborationConversation
              key={`${selection.identity.threadId}:${selection.identity.branchId}`}
              api={api}
              identity={selection.identity}
              host={host}
              onQuote={quote}
            />
          </React.Suspense>
        )}
        <CollaborationComposer
          api={api}
          identity={identity}
          draftKey={draftKey}
          members={state.members}
          defaultTarget={defaultTarget}
          direct={selection?.kind === "member" ? selection.identity : undefined}
          onSent={() => void feed.refresh()}
          moreMembers={
            !state.historyLoaded ||
            Boolean(state.historyCursor || state.currentCursor)
          }
          loadMembers={() =>
            void feed.loadMembers(state.currentCursor ? "current" : "history")
          }
        />
      </div>
    </section>
  );
}
