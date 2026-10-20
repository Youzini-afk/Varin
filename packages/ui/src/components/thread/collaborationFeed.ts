import type { ThreadIdentity, ThreadsAPI } from "@varin/application-client";
import type {
  FamilyMember,
  MessageFeedEntry,
  MessageFeedPage,
  MessageParticipant,
  RuntimeEvent,
} from "@varin/protocol";

export type CollaborationMember = MessageParticipant & {
  detail?: FamilyMember;
};
export interface CollaborationFeedState {
  rootThreadId: string;
  messages: MessageFeedEntry[];
  members: CollaborationMember[];
  ready: boolean;
  loadingEarlier: boolean;
  before: number | null;
  currentCursor?: string;
  historyCursor?: string;
  historyLoaded: boolean;
  error?: string;
}
const failureText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Disposable read projection. Native message IDs deduplicate peer notices and paginated reads. */
export class CollaborationFeed {
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private messages = new Map<string, MessageFeedEntry>();
  private members = new Map<string, CollaborationMember>();
  private value: CollaborationFeedState = {
    rootThreadId: "",
    messages: [],
    members: [],
    ready: false,
    loadingEarlier: false,
    before: null,
    historyLoaded: false,
  };
  private refreshing = false;
  private dirty = false;
  private directoryDirty = true;
  private feedDirty = true;
  private changingMembers = new Set<string>();
  private eventCursor: number | null = null;
  private latest = 0;
  private changingMessages = new Set<string>();
  private observation?: Promise<void>;
  constructor(
    private api: ThreadsAPI,
    private identity: ThreadIdentity,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.value;
  private publish(patch: Partial<CollaborationFeedState> = {}) {
    if (this.controller.signal.aborted) return;
    this.value = {
      ...this.value,
      ...patch,
      messages: [...this.messages.values()].sort(
        (a, b) => a.acceptedCursor - b.acceptedCursor,
      ),
      members: [...this.members.values()],
    };
    for (const listener of this.listeners) listener();
  }
  private accept(page: MessageFeedPage) {
    for (const message of page.messages) {
      this.messages.set(message.messageId, message);
      this.latest = Math.max(this.latest, message.acceptedCursor);
    }
    for (const member of page.participants) {
      const existing = this.members.get(member.threadId);
      this.members.set(
        member.threadId,
        existing?.detail ? existing : { ...existing, ...member },
      );
    }
    this.eventCursor = Math.max(this.eventCursor ?? 0, page.eventCursor);
    this.publish({ rootThreadId: page.rootThreadId });
  }
  private async directory(scope: "current" | "history", cursor?: string) {
    const page = await this.api.family!.list(
      this.identity,
      { includeSelf: true, scope, ...(cursor ? { cursor } : {}) },
      this.controller.signal,
    );
    if (this.controller.signal.aborted) return;
    if (scope === "current" && !cursor && !page.nextCursor) {
      const departed = [...this.members.values()].filter(
        (member) =>
          member.detail?.current &&
          !page.members.some((next) => next.threadId === member.threadId),
      );
      await Promise.all(
        departed.map((member) => this.resolveMember(member.threadId, true)),
      );
    }
    for (const member of page.members)
      this.members.set(member.threadId, {
        threadId: member.threadId,
        name: member.name ?? member.task ?? "",
        agentId: member.agentId ?? "",
        avatar: member.avatar ?? null,
        detail: member,
      });
    this.publish({
      rootThreadId: page.rootThreadId,
      ...(scope === "current"
        ? { currentCursor: page.nextCursor ?? undefined }
        : { historyCursor: page.nextCursor ?? undefined, historyLoaded: true }),
    });
  }
  async start() {
    void this.observe();
    await this.refresh();
  }
  close() {
    this.controller.abort();
  }
  private async observe() {
    if (this.observation) return this.observation;
    this.observation = (async () => {
      while (!this.controller.signal.aborted) {
        try {
          await this.api.observe(
            this.eventCursor,
            (event) => {
              if (this.controller.signal.aborted || "stream" in event) return;
              this.eventCursor = Math.max(this.eventCursor ?? 0, event.cursor);
              this.onEvent(event);
            },
            { signal: this.controller.signal },
          );
        } catch (error) {
          if (!this.controller.signal.aborted)
            this.publish({ error: failureText(error) });
        }
        if (this.controller.signal.aborted) return;
        // Match the native conversation reader's reconnect cadence; no model polling.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 1_000);
          this.controller.signal.addEventListener("abort", done, {
            once: true,
          });
        });
        if (!this.controller.signal.aborted) {
          this.directoryDirty = true;
          void this.refresh();
        }
      }
    })().finally(() => {
      this.observation = undefined;
    });
    return this.observation;
  }
  private onEvent(event: RuntimeEvent) {
    if (
      !/^(message\.|input\.|thread\.|child\.|run\.|execution\.committed|delivery\.)/.test(
        event.kind,
      )
    )
      return;
    const message = this.messages.get(event.subject);
    if (message) this.changingMessages.add(message.messageId);
    if (event.kind === "message.accepted") this.feedDirty = true;
    if (event.kind.startsWith("thread.") && this.members.has(event.subject))
      this.changingMembers.add(event.subject);
    if (/^(thread\.|child\.|run\.|delivery\.)/.test(event.kind)) {
      this.directoryDirty = true;
      for (const item of this.messages.values())
        if (item.state === "queued" || item.activation.state === "pending")
          this.changingMessages.add(item.messageId);
    }
    void this.refresh(false);
  }
  refresh = async (readNewMessages = true) => {
    this.feedDirty ||= readNewMessages;
    this.dirty = true;
    if (this.refreshing || this.controller.signal.aborted) return;
    this.refreshing = true;
    try {
      while (this.dirty && !this.controller.signal.aborted) {
        this.dirty = false;
        const initial = !this.value.ready;
        const readFeed = initial || this.feedDirty;
        this.feedDirty = false;
        const refreshDirectory = this.directoryDirty;
        this.directoryDirty = false;
        const changed = [...this.changingMessages];
        this.changingMessages.clear();
        const changedMembers = [...this.changingMembers];
        this.changingMembers.clear();
        const feed = async () => {
          let after: number | undefined = initial ? undefined : this.latest;
          do {
            const page = await this.api.messages!.feed(
              this.identity,
              after === undefined ? {} : { after },
              this.controller.signal,
            );
            if (this.controller.signal.aborted) return;
            this.accept(page);
            if (initial && after === undefined)
              this.publish({ before: page.before });
            after = page.after ?? undefined;
          } while (after !== undefined);
        };
        await Promise.all([
          readFeed ? feed() : undefined,
          refreshDirectory ? this.directory("current") : undefined,
          ...changedMembers.map((id) => this.resolveMember(id, true)),
          ...changed.map(async (id) => {
            const old = this.messages.get(id);
            if (!old) return;
            const message = await this.api.messages!.get(
              {
                runtime: "agent",
                threadId: old.senderThreadId,
                branchId: old.senderBranchId,
              },
              id,
              this.controller.signal,
            );
            if (!this.controller.signal.aborted)
              this.messages.set(id, { ...old, ...message });
          }),
        ]).catch((error) => {
          this.feedDirty ||= readFeed;
          this.directoryDirty ||= refreshDirectory;
          for (const id of changed) this.changingMessages.add(id);
          for (const id of changedMembers) this.changingMembers.add(id);
          throw error;
        });
        if (
          this.value.rootThreadId &&
          !this.members.get(this.value.rootThreadId)?.detail
        )
          await this.resolveMember(this.value.rootThreadId);
        this.publish({ ready: true, error: undefined });
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.directoryDirty = true;
        this.publish({ error: failureText(error) });
      }
    } finally {
      this.refreshing = false;
    }
  };
  retry = () => {
    void this.observe();
    this.directoryDirty = true;
    return this.refresh();
  };
  earlier = async () => {
    if (this.value.loadingEarlier || this.value.before === null) return;
    this.publish({ loadingEarlier: true });
    try {
      const page = await this.api.messages!.feed(
        this.identity,
        { before: this.value.before },
        this.controller.signal,
      );
      if (!this.controller.signal.aborted) {
        this.accept(page);
        this.publish({ before: page.before, error: undefined });
      }
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.publish({ error: failureText(error) });
    } finally {
      this.publish({ loadingEarlier: false });
    }
  };
  loadMembers = async (scope: "current" | "history") => {
    try {
      await this.directory(
        scope,
        scope === "current"
          ? this.value.currentCursor
          : this.value.historyCursor,
      );
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.publish({ error: failureText(error) });
    }
  };
  resolveMember = async (threadId: string, fresh = false) => {
    const existing = this.members.get(threadId);
    if (existing?.detail && !fresh) return existing;
    const page = await this.api.family!.list(
      this.identity,
      { includeSelf: true, scope: "all", query: threadId },
      this.controller.signal,
    );
    const detail = page.members.find((member) => member.threadId === threadId);
    if (this.controller.signal.aborted) return undefined;
    if (!detail) {
      if (existing) {
        this.members.set(threadId, { ...existing, detail: undefined });
        this.publish();
      }
      return undefined;
    }
    const member = {
      threadId,
      name: detail.name ?? detail.task ?? "",
      agentId: detail.agentId ?? "",
      avatar: detail.avatar ?? null,
      detail,
    };
    this.members.set(threadId, member);
    this.publish();
    return member;
  };
}
