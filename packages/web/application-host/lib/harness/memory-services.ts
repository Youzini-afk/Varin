import type {
  HarnessServiceMap,
  MemoryItem,
  MemoryScope,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { KnowledgeMutationError } from "../knowledge/store.js";
import type { MemoryOwner, MemoryService } from "../memory/memory-service.js";
import { MemoryOwnerUnavailableError } from "../memory/memory-service.js";
import { botIdFromScopeId, isBotScopeId, isSessionScopeId, sessionIdFromScopeId } from "./owner-scope.js";

/**
 * BC1 memory harness services. The worker-facing tools (`memory_remember`,
 * `memory_correct`, `memory_forget`, `memory_get`) and the UI routes share
 * this service layer, so "received vs committed" and dedupe/correction rules
 * are identical for every writer.
 */

const MEMORY_NATURES = new Set(["experience", "decision", "preference", "judgment", "instruction"]);

const natureOf = (value: unknown): import("@varin/protocol").MemoryNature | undefined => (
  typeof value === "string" && MEMORY_NATURES.has(value)
    ? value as import("@varin/protocol").MemoryNature
    : undefined
);

const mutationError = (error: KnowledgeMutationError): HarnessServiceError => new HarnessServiceError(
  error.code === "not-found" ? "not-found" : error.code === "invalid" ? "invalid-params" : "failed",
  error.message,
);

const toMemoryItem = (k: {
  id: number;
  scope: MemoryScope;
  status: "suggested" | "accepted" | "dismissed";
  content: string;
  trigger: string;
  nature?: import("@varin/protocol").MemoryNature;
  source?: { kind: string; sessionId?: string; threadId?: string; runId?: string; entryId?: string };
  createdAt: number;
  invalidAt?: number;
  recallCount: number;
  recalledAt?: number;
}): MemoryItem => k;

const ownerForExplicitScope = (scope: MemoryScope, ctx: HarnessServiceContext): MemoryOwner => {
  if (scope === "user") return { scope: "user", ownerId: null };
  if (scope === "bot") {
    // A worker may only write Bot memory for its own owning Bot scope.
    throw new HarnessServiceError("invalid-params", "memory writes use the caller's owning scope; cross-bot writes are not a worker action");
  }
  if (scope === "session") return { scope: "session", ownerId: ctx.sessionId };
  if (scope === "workspace") {
    if (!ctx.workspaceId || ctx.workspaceId === "user") {
      throw new HarnessServiceError("unavailable", "No workspace memory scope for this session");
    }
    return { scope: "workspace", ownerId: ctx.workspaceId };
  }
  throw new HarnessServiceError("invalid-params", `Unknown memory scope: ${String(scope)}`);
};

/**
 * The caller's owning memory scope: a session bound under `bot:<id>` writes
 * Bot memory; a workspace-bound session writes workspace memory; an unbound
 * session writes its own session scope.
 */
const defaultOwnerFor = async (service: MemoryService, ctx: HarnessServiceContext): Promise<MemoryOwner> => (
  service.ownerForSession(ctx.sessionId)
);

const explicitOwnerFor = async (
  service: MemoryService,
  ctx: HarnessServiceContext,
  scope: MemoryScope | undefined,
): Promise<MemoryOwner> => {
  if (!scope) return defaultOwnerFor(service, ctx);
  if (scope === "bot") {
    const owner = await defaultOwnerFor(service, ctx);
    if (owner.scope !== "bot") throw new HarnessServiceError("unavailable", "This session is not associated with a Bot");
    return owner;
  }
  return ownerForExplicitScope(scope, ctx);
};

export function createMemoryRememberService(host: HarnessServiceHost): HarnessService<"memory.remember"> {
  return {
    handle: async (params, ctx) => {
      const service = host.memoryService;
      if (!service) throw new HarnessServiceError("unavailable", "Memory service is not configured");
      const content = typeof params.content === "string" ? params.content : "";
      if (!content.trim()) {
        throw new HarnessServiceError("invalid-params", "memory.remember requires content");
      }
      const owner = await explicitOwnerFor(service, ctx, params.scope);
      const nature = natureOf(params.nature);
      const result = await service.remember(owner, {
        content,
        ...(typeof params.trigger === "string" ? { trigger: params.trigger } : {}),
        ...(nature ? { nature } : {}),
        source: {
          kind: ctx.requestSource === "user" ? "user-mark" : "memory.remember",
          sessionId: ctx.sessionId,
        },
      });
      return { created: result.created, ...(result.duplicate ? { duplicate: true } : {}), item: toMemoryItem(result.item) };
    },
  };
}

export function createMemoryCorrectService(host: HarnessServiceHost): HarnessService<"memory.correct"> {
  return {
    handle: async (params, ctx) => {
      const service = host.memoryService;
      if (!service) throw new HarnessServiceError("unavailable", "Memory service is not configured");
      const id = typeof params.id === "number" ? params.id : Number(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new HarnessServiceError("invalid-params", "memory.correct requires a memory id");
      }
      const content = typeof params.content === "string" ? params.content : "";
      if (!content.trim()) {
        throw new HarnessServiceError("invalid-params", "memory.correct requires the corrected content");
      }
      const owner = await explicitOwnerFor(service, ctx, params.scope);
      const nature = natureOf(params.nature);
      try {
        const result = await service.correct(owner, id, {
          content,
          ...(typeof params.trigger === "string" ? { trigger: params.trigger } : {}),
          ...(nature ? { nature } : {}),
          source: {
            kind: "memory.correct",
            sessionId: ctx.sessionId,
          },
        });
        return { corrected: true, id: result.id };
      } catch (error) {
        if (error instanceof KnowledgeMutationError) throw mutationError(error);
        throw error;
      }
    },
  };
}

export function createMemoryForgetService(host: HarnessServiceHost): HarnessService<"memory.forget"> {
  return {
    handle: async (params, ctx) => {
      const service = host.memoryService;
      if (!service) throw new HarnessServiceError("unavailable", "Memory service is not configured");
      const id = typeof params.id === "number" ? params.id : Number(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new HarnessServiceError("invalid-params", "memory.forget requires a memory id");
      }
      const owner = await explicitOwnerFor(service, ctx, params.scope);
      try {
        await service.forget(owner, id);
        return { forgotten: true };
      } catch (error) {
        if (error instanceof KnowledgeMutationError) throw mutationError(error);
        throw error;
      }
    },
  };
}

export function createMemoryGetService(host: HarnessServiceHost): HarnessService<"memory.get"> {
  return {
    handle: async (params, ctx) => {
      const service = host.memoryService;
      if (!service) throw new HarnessServiceError("unavailable", "Memory service is not configured");
      const id = typeof params.id === "number" ? params.id : Number(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new HarnessServiceError("invalid-params", "memory.get requires a memory id");
      }
      const owner = await explicitOwnerFor(service, ctx, params.scope);
      try {
        const { item, chain } = await service.get(owner, id);
        return {
          item: toMemoryItem(item),
          ...(chain ? { chain: chain.chain.map(toMemoryItem) } : {}),
        };
      } catch (error) {
        if (error instanceof KnowledgeMutationError) throw mutationError(error);
        throw error;
      }
    },
  };
}

export function createMemorySearchService(host: HarnessServiceHost): HarnessService<"memory.search"> {
  return {
    handle: async (params, ctx) => {
      const service = host.memoryService;
      if (!service) throw new HarnessServiceError("unavailable", "Memory service is not configured");
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new HarnessServiceError("invalid-params", "memory.search requires a query");
      }
      const owner = await explicitOwnerFor(service, ctx, params.scope);
      const k = typeof params.k === "number" && Number.isSafeInteger(params.k) && params.k > 0
        ? params.k : 8;
      const results = await service.search(owner, query, k);
      const items: Array<{ item: MemoryItem; score: number }> = [];
      for (const result of results) {
        if (result.node.type !== "knowledge") continue;
        const payload = result.node.payload as Record<string, unknown>;
        const nature = natureOf(payload["nature"]);
        const source = payload["source"] && typeof payload["source"] === "object"
          ? payload["source"] as MemoryItem["source"] : undefined;
        items.push({
          item: {
            id: result.node.id,
            scope: payload["scope"] as MemoryScope,
            status: payload["status"] as MemoryItem["status"],
            content: String(payload["content"] ?? ""),
            trigger: String(payload["trigger"] ?? ""),
            ...(nature ? { nature } : {}),
            ...(source ? { source } : {}),
            createdAt: Number(payload["createdAt"] ?? 0),
            ...(typeof payload["invalidAt"] === "number" ? { invalidAt: payload["invalidAt"] } : {}),
            recallCount: Number(payload["recallCount"] ?? 0),
            ...(typeof payload["recalledAt"] === "number" ? { recalledAt: payload["recalledAt"] } : {}),
          },
          score: result.score,
        });
      }
      return { results: items };
    },
  };
}

export function registerMemoryServices(
  router: { register: <M extends keyof HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
): void {
  if (!host.memoryService) return;
  router.register("memory.remember", createMemoryRememberService(host));
  router.register("memory.correct", createMemoryCorrectService(host));
  router.register("memory.forget", createMemoryForgetService(host));
  router.register("memory.get", createMemoryGetService(host));
  router.register("memory.search", createMemorySearchService(host));
}

// Re-exported for wiring-time scope derivation in index.ts.
export { botIdFromScopeId, isBotScopeId, isSessionScopeId, sessionIdFromScopeId };
export { MemoryOwnerUnavailableError };
