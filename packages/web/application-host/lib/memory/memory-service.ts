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
import { recallSources } from "../knowledge/vectors/index.js";
import { botScopeId, sessionScopeId } from "../harness/owner-scope.js";

/**
 * Unified memory domain (BC1). One service backs every writer — the user's
 * explicit remember action, an agent's memory tools, the Bot's own recording,
 * and later the background organizer (BC2). "Received" vs "committed" is the
 * `commit` argument: direct user/agent statements persist as `accepted`;
 * model-inferred proposals commit as `suggested` and keep their inferred
 * nature — they are never silently promoted to user instructions.
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
  /**
   * Resolve the memory owner a session acts as: a session bound under a
   * `bot:<id>` scope writes Bot memory; an ordinary bound session writes its
   * workspace; an unbound session writes its own session store.
   */
  ownerForSession(sessionId: string): Promise<MemoryOwner>;
  onChanged?(owner: MemoryOwner, ids: readonly NodeId[]): void;
  onError?(error: unknown): void;
}

export interface MemoryRecordInput {
  content: string;
  trigger?: string;
  nature?: MemoryNature;
  source?: KnowledgeSource;
  /** `accepted` persists immediately; `suggested` is a reviewable proposal. */
  commit?: KnowledgeStatus;
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

  /**
   * Persist one memory row. Direct user/agent statements default to
   * `accepted` — the per-row review tray is no longer the gate for something
   * a caller explicitly asked to remember. Identity dedupe covers dismissed
   * and retired rows so a restated memory never resurrects forgotten history.
   */
  const remember = async (owner: MemoryOwner, input: MemoryRecordInput): Promise<MemoryRecordResult> => {
    const store = await storeFor(owner);
    const content = input.content.trim();
    if (!content) throw new KnowledgeMutationError("invalid", "Memory content is required");
    const result = await store.createKnowledgeIfAbsent({
      scope: owner.scope,
      status: input.commit ?? "accepted",
      content,
      trigger: input.trigger?.trim() ?? "",
      ...(input.nature ? { nature: input.nature } : {}),
      ...(input.source ? { source: input.source } : {}),
    });
    if (result.created) notify(owner, [result.knowledge.id]);
    return { created: result.created, duplicate: result.duplicate, item: result.knowledge };
  };

  /** A correction replaces the row: new accepted revision, predecessor retired behind a supersedes edge. */
  const correct = async (
    owner: MemoryOwner,
    id: NodeId,
    patch: { content: string; trigger?: string; nature?: MemoryNature; source?: KnowledgeSource; expected?: KnowledgeExpectedRevision },
  ): Promise<{ id: NodeId; previous: Knowledge }> => {
    const store = await storeFor(owner);
    const result = await store.supersedeKnowledge(id, {
      scope: owner.scope,
      status: "accepted",
      content: patch.content,
      trigger: patch.trigger?.trim() ?? "",
      ...(patch.nature ? { nature: patch.nature } : {}),
      ...(patch.source ? { source: patch.source } : {}),
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
  ): Promise<RecallResult[]> => {
    const store = await storeFor(owner);
    // The same selection service backs automatic Zone 2 recall (BC3).
    const { results } = await recallSources({
      sources: [{ authority: store, scope: owner.scope, scopeId: memoryOwnerScopeId(owner) ?? owner.scope }],
      query,
      k,
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
    ownerForSession: deps.ownerForSession,
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
