import type {
  Knowledge,
  KnowledgeExpectedRevision,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeStore,
  KnowledgeSupersedeChain,
  MemoryNature,
  NodeId,
  RecallResult,
} from "../knowledge/store.js";
import { KnowledgeMutationError } from "../knowledge/store.js";
import { recallSources, type KnowledgeVectorRuntime, type MemoryRecallAssociation } from "../knowledge/vectors/index.js";
import { botScopeId, sessionScopeId } from "../harness/owner-scope.js";
import type { MemorySourceExcerpt, MemorySourceSpan, PiSessionEntry } from "@varin/protocol";
import { entrySourceText, sourceRevision } from "./memory-sources.js";

/**
 * Unified memory domain (BC1). One service backs every writer — the user's
 * explicit remember action, an agent's memory tools, the Bot's own recording,
 * and the background organizer (BC2). Accepted/suggested describes effective
 * recall eligibility, not durability or user authority. Every successful write
 * awaits the storage receipt; nature and provenance describe the claim.
 */

/** The store-level owner a memory row belongs to. */
export interface MemoryOwner {
  scope: KnowledgeScope;
  /**
   * `workspace` → workspace authority id, `bot` → bot id, `session` → session
   * id, `user` → null (the single user store).
   */
  ownerId: string | null;
}

export const memoryOwnerScopeId = (owner: MemoryOwner): string | null => {
  switch (owner.scope) {
    case "bot": return owner.ownerId ? botScopeId(owner.ownerId) : null;
    case "session": return owner.ownerId ? sessionScopeId(owner.ownerId) : null;
    case "workspace": return owner.ownerId;
    case "user": return null;
  }
};

export interface MemoryServiceDeps {
  /**
   * Resolve the owning store for a scope id (`workspaceId`, `bot:<id>`,
   * `session:<id>`). Return null when the store cannot be opened.
   */
  storeForScopeId(scopeId: string): Promise<KnowledgeStore | null>;
  /** The single user store. */
  userStore(): Promise<KnowledgeStore | null>;
  /** Existing session memory, if any; lookup must not create an empty store. */
  sessionStoreIfPresent?(sessionId: string): Promise<KnowledgeStore | null>;
  /**
   * Resolve the memory owner a session acts as: a session bound under a
   * `bot:<id>` scope writes Bot memory; an ordinary bound session writes its
   * workspace; an unbound session writes its own session store.
   */
  ownerForSession(sessionId: string): Promise<MemoryOwner>;
  /**
   * Hybrid vector runtime shared with automatic recall (BC3). Resolved lazily —
   * the service is created before the runtime is ready, and a direct search
   * must remain useful with text retrieval alone.
   */
  vectors?(): KnowledgeVectorRuntime | null;
  /**
   * Work/follow-up keys for the calling session (BC3): the bound thread, its
   * ancestor chain, and its follow-up threads/runs — the same association the
   * automatic recall closure builds.
   */
  associationForSession?(sessionId: string): Promise<MemoryRecallAssociation | undefined>;
  readSessionEntries?(sessionId: string, scope: "branch" | "all"): Promise<PiSessionEntry[]>;
  readRunReport?(scopeId: string, threadId: string, runId: string): Promise<string | null>;
  onChanged?(owner: MemoryOwner, ids: readonly NodeId[]): void;
  onError?(error: unknown): void;
}

export interface MemoryRecordInput {
  content: string;
  trigger?: string;
  nature?: MemoryNature;
  source?: KnowledgeSource;
  sourceText?: string;
  sourceEntryId?: string;
  /** `accepted` persists immediately; `suggested` is a reviewable proposal. */
  commit?: KnowledgeStatus;
  expectedRevision?: string;
  /** Existing memory in the same scope this row refines (supplements edge). */
  supplements?: NodeId;
}

export interface MemoryRecordResult {
  created: boolean;
  duplicate: boolean;
  item: Knowledge;
}

export class MemoryOwnerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryOwnerUnavailableError";
  }
}

export function createMemoryService(deps: MemoryServiceDeps) {
  const notify = (owner: MemoryOwner, ids: readonly NodeId[]) => {
    try { deps.onChanged?.(owner, ids); } catch (error) { deps.onError?.(error); }
  };

  const storeFor = async (owner: MemoryOwner): Promise<KnowledgeStore> => {
    const store = owner.scope === "user"
      ? await deps.userStore()
      : await (async () => {
        const scopeId = memoryOwnerScopeId(owner);
        return scopeId ? deps.storeForScopeId(scopeId) : null;
      })();
    if (!store) {
      throw new MemoryOwnerUnavailableError(
        `Memory store is unavailable for ${owner.scope}${owner.ownerId ? ` "${owner.ownerId}"` : ""}`,
      );
    }
    return store;
  };

  const requireRow = async (store: KnowledgeStore, owner: MemoryOwner, id: NodeId): Promise<Knowledge> => {
    const item = await store.getKnowledge(id);
    if (!item || item.scope !== owner.scope) {
      throw new KnowledgeMutationError("not-found", `Memory not found in ${owner.scope}: ${id}`);
    }
    return item;
  };

  const captureSource = async (input: Pick<MemoryRecordInput, "content" | "source" | "sourceText" | "sourceEntryId">): Promise<KnowledgeSource | undefined> => {
    const source = input.source;
    if (!source?.sessionId || source.kind === "memory-organizer" || source.spans || !deps.readSessionEntries) return source;
    const entries = await deps.readSessionEntries(source.sessionId, "branch");
    const quote = input.sourceText ?? input.content;
    if (!quote.trim()) throw new KnowledgeMutationError("invalid", "Memory source passage is empty");
    const candidates = entries.filter((entry) => !input.sourceEntryId || entry.id === input.sourceEntryId)
      .flatMap((entry) => {
        const text = entrySourceText(entry);
        const start = text.indexOf(quote);
        return start < 0 ? [] : [{ entry, text, start }];
      });
    // No transcript means a standalone explicit note, with no historical
    // passage for the organizer to replay. Otherwise require real evidence.
    if (!candidates.length) {
      if (!entries.length && !input.sourceText && !input.sourceEntryId) return source;
      throw new KnowledgeMutationError("invalid", "Provide sourceText as an exact passage from this conversation (and sourceEntryId if needed)");
    }
    const { entry, text, start } = candidates.at(-1)!;
    return { ...source, entryId: entry.id, spans: [{
      kind: "pi-entry", id: entry.id, sessionId: source.sessionId,
      revision: sourceRevision(text), start, end: start + quote.length,
    }] };
  };

  const readSource = async (owner: MemoryOwner, id: NodeId): Promise<MemorySourceExcerpt[]> => {
    // Authorization is the memory owner lookup. Only its persisted ranges are
    // readable; callers cannot substitute another session or request its history.
    const item = await requireRow(await storeFor(owner), owner, id);
    return Promise.all((item.source?.spans ?? []).map(async (span: MemorySourceSpan): Promise<MemorySourceExcerpt> => {
      let text: string | undefined;
      try {
        if (span.kind === "pi-entry" && span.sessionId && deps.readSessionEntries) {
          const entry = (await deps.readSessionEntries(span.sessionId, "all")).find((entry) => entry.id === span.id);
          if (entry) text = entrySourceText(entry);
        } else if (span.kind === "event" && span.scopeId && span.sessionId) {
          const sourceStore = await deps.storeForScopeId(span.scopeId);
          text = (await sourceStore?.listEvents({ sessionId: span.sessionId }))?.find((event) => String(event.id) === span.id)?.text;
        } else if (span.kind === "run-report" && span.scopeId && span.threadId) {
          text = await deps.readRunReport?.(span.scopeId, span.threadId, span.id) ?? undefined;
        }
      } catch { return { span, status: "unavailable" }; }
      if (text === undefined) return { span, status: "unavailable" };
      if (sourceRevision(text) !== span.revision || span.end > text.length) return { span, status: "changed" };
      return { span, status: "available", text: text.slice(span.start, span.end) };
    }));
  };

  /**
   * Persist one memory row. Direct user/agent statements default to
   * `accepted` — the per-row review tray is no longer the gate for something
   * a caller explicitly asked to remember. Automatic source retries respect
   * forgetting; a new explicit instruction can intentionally remember it again.
   */
  const remember = async (owner: MemoryOwner, input: MemoryRecordInput): Promise<MemoryRecordResult> => {
    const store = await storeFor(owner);
    const content = input.content.trim();
    if (!content) throw new KnowledgeMutationError("invalid", "Memory content is required");
    const source = await captureSource(input);
    const result = await store.createKnowledgeIfAbsent({
      scope: owner.scope,
      status: input.commit ?? "accepted",
      content,
      trigger: input.trigger?.trim() ?? "",
      ...(input.nature ? { nature: input.nature } : {}),
      ...(source ? { source } : {}),
      ...(input.supplements !== undefined ? { supplements: input.supplements } : {}),
    }, { explicit: input.source?.kind !== "memory-organizer", ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}) });
    if (result.created) notify(owner, [result.knowledge.id]);
    return { created: result.created, duplicate: result.duplicate, item: result.knowledge };
  };

  /** A correction replaces the row: new accepted revision, predecessor retired behind a supersedes edge. */
  const correct = async (
    owner: MemoryOwner,
    id: NodeId,
    patch: { content: string; trigger?: string; nature?: MemoryNature; source?: KnowledgeSource; sourceText?: string; sourceEntryId?: string; expected?: KnowledgeExpectedRevision },
  ): Promise<{ id: NodeId; previous: Knowledge }> => {
    const store = await storeFor(owner);
    const source = await captureSource(patch);
    const result = await store.supersedeKnowledge(id, {
      scope: owner.scope,
      status: "accepted",
      content: patch.content,
      trigger: patch.trigger?.trim() ?? "",
      ...(patch.nature ? { nature: patch.nature } : {}),
      ...(source ? { source } : {}),
    }, owner.scope, patch.expected);
    notify(owner, [result.id, id]);
    return result;
  };

  /** Forget removes the row from current-effective recall while keeping history inspectable. */
  const forget = async (
    owner: MemoryOwner,
    id: NodeId,
    expected?: KnowledgeExpectedRevision,
  ): Promise<void> => {
    const store = await storeFor(owner);
    await requireRow(store, owner, id);
    await store.retireKnowledge(id, owner.scope, expected);
    notify(owner, [id]);
  };

  const get = async (
    owner: MemoryOwner,
    id: NodeId,
  ): Promise<{ item: Knowledge; chain: KnowledgeSupersedeChain | null }> => {
    const store = await storeFor(owner);
    const item = await requireRow(store, owner, id);
    return { item, chain: await store.getSupersedeChain(id, owner.scope) };
  };

  const list = async (
    owner: MemoryOwner,
    filter?: { status?: KnowledgeStatus; activeOnly?: boolean },
  ): Promise<Knowledge[]> => {
    const store = await storeFor(owner);
    return store.listKnowledge({ scope: owner.scope, ...(filter ?? {}) });
  };

  const search = async (
    owner: MemoryOwner,
    query: string,
    k = 8,
    context?: { sessionId?: string; includeShared?: boolean },
  ): Promise<RecallResult[]> => {
    const store = await storeFor(owner);
    const scopeId = memoryOwnerScopeId(owner) ?? owner.scope;
    const associated = context?.sessionId
      ? await deps.associationForSession?.(context.sessionId)
      : undefined;
    const vectors = deps.vectors?.() ?? undefined;
    const sources = [{ authority: store, scope: owner.scope, scopeId }];
    if (context?.includeShared && owner.scope !== "user") {
      const userStore = await deps.userStore();
      if (!userStore) throw new MemoryOwnerUnavailableError("User memory store is unavailable");
      sources.push({ authority: userStore, scope: "user", scopeId: "user" });
    }
    if (context?.includeShared && context.sessionId && owner.scope !== "session") {
      const sessionStore = await deps.sessionStoreIfPresent?.(context.sessionId);
      if (sessionStore) sources.push({ authority: sessionStore, scope: "session", scopeId: sessionScopeId(context.sessionId) });
    }
    // Active default-scope lookup and automatic Zone 2 recall now use the
    // same sources and selection service. Explicit scope searches stay narrow.
    const { results } = await recallSources({
      sources,
      query,
      k,
      ...(vectors ? { vectors } : {}),
      workspaceId: scopeId,
      ...(associated ? { associated } : {}),
    });
    return results;
  };

  return {
    remember,
    correct,
    forget,
    get,
    list,
    search,
    readSource,
    revision: async (owner: MemoryOwner) => (await storeFor(owner)).knowledgeRevision(),
    ownerForSession: deps.ownerForSession,
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
