import {
  HARNESS_METHOD_CAPABILITY,
  isHarnessMethod,
  type HarnessActorContext,
  type HarnessActorIdentity,
  type HarnessError,
  type HarnessMethod,
  type HarnessCancelData,
  type HarnessRequestData,
  type HarnessServiceMap,
  buildHarnessRespondParams,
  HARNESS_MAX_REQUEST_TIMEOUT_MS,
  parseAgentInputContext,
  type AgentInputContext,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";
import { looksLikePathObject } from "./explore-query.js";

export { buildHarnessRespondParams };

export interface HarnessAuthorizedPath {
  authorityId: string;
  workspaceId: string;
  canonicalResourceId: string;
  /** Actual resolved filesystem spelling; never derive an open path from the normalized identity key. */
  resolvedPath?: string;
  inputPath: string;
  resourceId: string;
}

export interface HarnessServiceContext {
  actor: HarnessActorContext;
  /** Set only by an authenticated Host UI adapter, never from worker params. */
  requestSource?: "user";
  authorizedPaths: readonly HarnessAuthorizedPath[];
  sessionId: HarnessActorContext["sessionId"];
  workspaceId: HarnessActorContext["workspaceId"];
  workspaceScope?: readonly string[];
  inputContext?: AgentInputContext;
  signal: AbortSignal;
  /** Register state that advances only after the Host response reaches pi-host. */
  deferResponseDelivery?(commit: () => void, abort: () => void): void;
}

export interface HarnessService<M extends HarnessMethod> {
  handle(
    params: HarnessServiceMap[M]["params"],
    ctx: HarnessServiceContext,
  ): Promise<HarnessServiceMap[M]["result"]>;
}

export interface HarnessRouterOptions {
  /**
   * Deliver the outcome to the requesting worker. Auxiliary workers (a
   * session's compaction worker) are not the session's registered worker, so
   * the response must route by worker identity, not by session lookup.
   */
  respond: (identity: HarnessActorIdentity, requestId: string, outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError }) => Promise<void>;
  resolveActor: (identity: HarnessActorIdentity, signal?: AbortSignal) => Promise<HarnessActorContext | null>;
  authorizeWorkspacePath?: (
    actor: HarnessActorContext,
    path: string,
    options: { allowMissing: boolean },
  ) => Promise<HarnessAuthorizedPath | null>;
  defaultTimeoutMs?: number;
  cancelExploreQuery?: (actor: HarnessActorContext, queryId: string) => boolean;
}

interface RouterHostEvent {
  actor?: HarnessActorIdentity;
  workerId?: string;
  envelope?: {
    data?: unknown;
    event?: string;
    kind?: string;
  } | undefined;
  kind: string;
}

const requestPaths = (
  method: HarnessMethod,
  params: unknown,
): Array<{ allowMissing: boolean; path: string }> | "invalid" => {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  if (method === "permission.inspect") {
    if (typeof record.cwd !== "string" || !record.cwd.trim()
      || !Array.isArray(record.paths) || !record.paths.every((path) => typeof path === "string" && path.trim())) {
      return "invalid";
    }
    return [
      { allowMissing: false, path: record.cwd },
      ...record.paths.map((path) => ({ allowMissing: true, path: path as string })),
    ];
  }
  if (method === "permission.audit") return [];
  if (method === "explore.search" || method === "explore.query.start") {
    if (record.paths !== undefined && (!Array.isArray(record.paths)
      || !record.paths.every((path) => typeof path === "string" && path.trim()))) return "invalid";
    if (record.anchors !== undefined && (!Array.isArray(record.anchors)
      || !record.anchors.every((anchor) => typeof anchor === "string"))) return "invalid";
    const paths = Array.isArray(record.paths)
      ? record.paths.map((path) => ({ allowMissing: false, path: path as string }))
      : [];
    // Explore anchors remain hints. Path-shaped anchors are separately
    // authorized here so the service can replace raw absolute/opDir paths with
    // the Router's workspace-relative resource IDs without turning symbols
    // into paths or silently broadening to the workspace after denial.
    const anchors = Array.isArray(record.anchors)
      ? record.anchors
        .filter((anchor): anchor is string => typeof anchor === "string" && looksLikePathObject(anchor.trim()))
        .map((anchor) => ({ allowMissing: true, path: anchor.trim() }))
      : [];
    return [...paths, ...anchors];
  }
  if (
    method === "explore.query.plan"
    || method === "explore.query.views"
    || method === "explore.query.select"
    || method === "explore.query.followup"
    || method === "explore.query.finish"
    || method === "explore.query.cancel"
    || method === "explore.query.release"
  ) {
    return [];
  }
  if (method === "related.query") {
    if (typeof record.anchor !== "string" || !record.anchor.trim()) return "invalid";
    return looksLikePathObject(record.anchor.trim())
      ? [{ allowMissing: true, path: record.anchor.trim() }]
      : [];
  }
  if (method === "search.content") {
    // RR4: `paths` authorizes a multi-scope query; it takes precedence over
    // the singular `path`. Both resolve through the actor's operation dir.
    if (record.paths !== undefined) {
      return Array.isArray(record.paths) && record.paths.length > 0
        && record.paths.every((path) => typeof path === "string" && path.trim())
        ? record.paths.map((path) => ({ allowMissing: false, path: path as string }))
        : "invalid";
    }
    if (record.path === undefined) return [];
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: false, path: record.path }]
      : "invalid";
  }
  if (method === "document.readSource") {
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "materials.read") {
    if (record.path === undefined) return [];
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "document.pathOverlay") {
    return typeof record.path === "string" && record.path.trim()
      && (record.pattern === undefined || typeof record.pattern === "string")
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "document.writeGuard") {
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "document.surfaceWrite") {
    const validAction = (action: unknown): action is "write" | "edit" | "delete" => (
      action === "write" || action === "edit" || action === "delete"
    );
    if (Array.isArray(record.changes)) {
      if (record.changes.length === 0) return "invalid";
      const paths: Array<{ allowMissing: boolean; path: string }> = [];
      for (const change of record.changes) {
        if (!change || typeof change !== "object" || Array.isArray(change)) return "invalid";
        const row = change as Record<string, unknown>;
        if (typeof row.path !== "string" || !row.path.trim() || !validAction(row.action)) return "invalid";
        paths.push({ allowMissing: true, path: row.path });
      }
      return paths;
    }
    return typeof record.path === "string" && record.path.trim() && validAction(record.action)
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "document.branchWrite") {
    const validAction = (action: unknown): action is "write" | "edit" | "delete" => (
      action === "write" || action === "edit" || action === "delete"
    );
    if (Array.isArray(record.changes)) {
      if (record.changes.length === 0) return "invalid";
      const paths: Array<{ allowMissing: boolean; path: string }> = [];
      for (const change of record.changes) {
        if (!change || typeof change !== "object" || Array.isArray(change)) return "invalid";
        const row = change as Record<string, unknown>;
        if (typeof row.path !== "string" || !row.path.trim() || !validAction(row.action)) return "invalid";
        paths.push({ allowMissing: true, path: row.path });
      }
      return paths;
    }
    return typeof record.path === "string" && record.path.trim() && validAction(record.action)
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "shell.exec") {
    if (record.cwd === undefined) return [];
    return typeof record.cwd === "string" && record.cwd.trim()
      ? [{ allowMissing: false, path: record.cwd }]
      : "invalid";
  }
  if (method === "experiment.submit") {
    if (record.cwd === undefined) return [];
    return typeof record.cwd === "string" && record.cwd.trim()
      ? [{ allowMissing: false, path: record.cwd }]
      : "invalid";
  }
  if (method === "thread.dispatch") {
    if (record.scope === undefined) return [];
    return Array.isArray(record.scope) && record.scope.every((path) => typeof path === "string" && path.trim())
      ? record.scope.map((path) => ({ allowMissing: true, path: path as string }))
      : "invalid";
  }
  if (method === "fs.lock") {
    if (record.action === "release") {
      return typeof record.leaseId === "string" && record.leaseId.length > 0 ? [] : "invalid";
    }
    if (record.action !== "acquire" || !Array.isArray(record.paths) || record.paths.length === 0) return "invalid";
    return record.paths.every((path) => typeof path === "string" && path.trim())
      ? record.paths.map((path) => ({ allowMissing: true, path: path as string }))
      : "invalid";
  }
  if (method === "lsp.symbols") {
    if (typeof record.query !== "string") return "invalid";
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "lsp.definition" || method === "lsp.references" || method === "lsp.hover") {
    if (!Number.isSafeInteger(record.line) || Number(record.line) < 1) return "invalid";
    if (record.character !== undefined && (!Number.isSafeInteger(record.character) || Number(record.character) < 1)) return "invalid";
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: true, path: record.path }]
      : "invalid";
  }
  if (method === "lsp.diagnostics" || method === "lsp.diagnosticsSnapshot") {
    if (method === "lsp.diagnosticsSnapshot" && record.full !== undefined && typeof record.full !== "boolean") return "invalid";
    return typeof record.path === "string" && record.path.trim()
      ? [{ allowMissing: false, path: record.path }]
      : "invalid";
  }
  return [];
};

const harnessError = (code: HarnessError["code"], message: string, retryable = false): HarnessError => ({
  code,
  message,
  ...(retryable ? { retryable } : {}),
});

export const createHarnessRouter = (options: HarnessRouterOptions) => {
  const services = new Map<HarnessMethod, HarnessService<HarnessMethod>>();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const inflight = new Map<string, {
    controller: AbortController;
    identity: HarnessActorIdentity;
    sessionId: string;
    queryId?: string;
  }>();
  let disposed = false;

  const register = <M extends HarnessMethod>(method: M, service: HarnessService<M>): void => {
    services.set(method, service as HarnessService<HarnessMethod>);
  };

  const abortInflight = (key: string): boolean => {
    const pending = inflight.get(key);
    if (!pending) return false;
    pending.controller.abort();
    return true;
  };

  // Worker retirement is authoritative even after its actor registration has
  // been removed. Query cancellation must not depend on resolving that actor.
  const cancelWorker = (workerId: string): void => {
    for (const pending of inflight.values()) {
      if (pending.identity.workerId === workerId) pending.controller.abort();
    }
  };

  const requestKey = (identity: HarnessActorIdentity, requestId: string): string => [
    identity.authorityInstanceId,
    identity.sessionId,
    identity.workerId,
    identity.workerGeneration,
    identity.runId ?? "",
    requestId,
  ].join("\0");

  const sameRequestActor = (stored: HarnessActorIdentity, current: HarnessActorIdentity): boolean => (
    stored.authorityInstanceId === current.authorityInstanceId
    && stored.sessionId === current.sessionId
    && stored.workerId === current.workerId
    && stored.workerGeneration === current.workerGeneration
    && (stored.runId ?? "") === (current.runId ?? "")
  );

  const processCancel = async (event: RouterHostEvent): Promise<void> => {
    const data = event.envelope?.data as HarnessCancelData | undefined;
    const identity = event.actor;
    if (!data || !identity) return;
    const actor = await options.resolveActor(identity);
    if (!actor) return;
    if (typeof data.requestId === "string" && data.requestId) {
      const key = requestKey(actor, data.requestId);
      const pending = inflight.get(key);
      if (pending && sameRequestActor(pending.identity, actor)) abortInflight(key);
    }
    if (typeof data.queryId === "string" && data.queryId) {
      if (!actor.grantedCapabilities.includes(HARNESS_METHOD_CAPABILITY["explore.query.cancel"])) return;
      for (const [key, pending] of inflight) {
        if (pending.queryId === data.queryId && sameRequestActor(pending.identity, actor)) {
          abortInflight(key);
        }
      }
      options.cancelExploreQuery?.(actor, data.queryId);
    }
  };

  const processEvent = async (event: RouterHostEvent): Promise<void> => {
    if (disposed) return;
    if (event.kind === "worker.exit" && event.workerId) {
      cancelWorker(event.workerId);
      return;
    }
    if (event.kind !== "host" || event.envelope?.kind !== "event") return;
    if (event.envelope.event === "harness.cancel") {
      await processCancel(event);
      return;
    }
    if (event.envelope.event !== "harness.request") return;
    const data = event.envelope.data as HarnessRequestData | undefined;
    const identity = event.actor;
    if (!data || typeof data.requestId !== "string" || !identity) return;
    const respond = (outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError }) => (
      options.respond(identity, data.requestId, outcome)
    );
    if (!isHarnessMethod(data.method)) {
      await respond({
        ok: false,
        error: harnessError("unavailable", `Unknown harness method: ${data.method}`),
      });
      return;
    }
    const method = data.method;
    const controller = new AbortController();
    const queryId = data.params && typeof data.params === "object" && !Array.isArray(data.params)
      && typeof (data.params as { queryId?: unknown }).queryId === "string"
      ? (data.params as { queryId: string }).queryId
      : undefined;
    const inflightKey = requestKey(identity, data.requestId);
    inflight.set(inflightKey, {
      controller,
      identity,
      sessionId: identity.sessionId,
      ...(queryId ? { queryId } : {}),
    });
    const deferredDeliveries: Array<{ commit: () => void; abort: () => void }> = [];
    let deliveriesSettled = false;
    const settleDeliveries = (outcome: "commit" | "abort"): void => {
      if (deliveriesSettled) return;
      deliveriesSettled = true;
      for (const delivery of deferredDeliveries) {
        try {
          delivery[outcome]();
        } catch {
          // Delivery bookkeeping cannot rewrite an already-sent response.
        }
      }
    };
    // Per-request timeout override (e.g. thread.wait carries a longer
    // timeout), clamped so a worker cannot pin a handler open forever.
    const requestTimeoutMs = (typeof data.timeoutMs === "number" && data.timeoutMs > 0)
      ? Math.min(data.timeoutMs, HARNESS_MAX_REQUEST_TIMEOUT_MS)
      : defaultTimeoutMs;
    // Scheduler waits and shell observations may own their requested wait
    // duration. Worker cancellation, generation replacement, and Host disposal
    // still abort these zero-transport-timeout requests.
    const timer = (data.method === "thread.wait" || data.method === "thread.send" || data.method === "experiment.wait" || data.method === "compaction.run" || data.method === "materials.read" || data.method === "shell.exec" || data.method === "shell.read") && data.timeoutMs === 0
      ? undefined : setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const actor = await options.resolveActor(identity, controller.signal);
      if (!actor) {
        await respond({
          ok: false,
          error: harnessError("forbidden", "Harness actor is not registered for this session"),
        });
        return;
      }
      const inputContext = data.inputContext === undefined
        ? { source: "disk" as const }
        : parseAgentInputContext(data.inputContext);
      if (!inputContext) {
        await respond({
          ok: false,
          error: harnessError("invalid-params", "Harness input source is invalid"),
        });
        return;
      }
      if (actor.allowedMethods !== undefined && !actor.allowedMethods.includes(method)) {
        await respond({
          ok: false,
          error: harnessError("forbidden", `Harness method is outside this actor's allowlist: ${method}`),
        });
        return;
      }
      const requiredCapability = HARNESS_METHOD_CAPABILITY[method];
      if (!actor.grantedCapabilities.includes(requiredCapability)) {
        await respond({
          ok: false,
          error: harnessError("forbidden", `Harness capability is not granted: ${requiredCapability}`),
        });
        return;
      }
      const scopedPaths = requestPaths(method, data.params);
      if (scopedPaths === "invalid") {
        await respond({
          ok: false,
          error: harnessError("invalid-params", `Harness method ${method} requires a valid path`),
        });
        return;
      }
      const authorizedPaths: HarnessAuthorizedPath[] = [];
      for (const scopedPath of scopedPaths) {
        const authorized = await options.authorizeWorkspacePath?.(
          actor,
          scopedPath.path,
          { allowMissing: scopedPath.allowMissing },
        ) ?? null;
        if (!authorized) {
          await respond({
            ok: false,
            error: harnessError("forbidden", "Harness path is outside the actor workspace"),
          });
          return;
        }
        authorizedPaths.push(authorized);
      }
      const service = services.get(method);
      if (!service) {
        await respond({
          ok: false,
          error: harnessError("unavailable", `Harness method not registered: ${method}`),
        });
        return;
      }
      const result = await service.handle(data.params as never, {
        actor,
        authorizedPaths,
        sessionId: actor.sessionId,
        workspaceId: actor.workspaceId,
        inputContext,
        ...(actor.workspaceScope ? { workspaceScope: actor.workspaceScope } : {}),
        signal: controller.signal,
        deferResponseDelivery: (commit, abort) => {
          deferredDeliveries.push({ commit, abort });
        },
      });
      try {
        await respond({ ok: true, result });
      } catch (error) {
        settleDeliveries("abort");
        throw error;
      }
      settleDeliveries("commit");
    } catch (error) {
      settleDeliveries("abort");
      let code: HarnessError["code"];
      let message: string;
      let retryable = false;
      if (error instanceof HarnessServiceError) {
        code = error.harnessCode;
        message = error.message;
        retryable = error.harnessRetryable;
      } else if (method === "compaction.run" && error instanceof Error
        && "code" in error && error.code === "compaction_stalled") {
        code = "compaction-stalled";
        message = error.message;
        retryable = true;
      } else if (error instanceof Error && error.name === "AbortError") {
        code = "timeout";
        message = error.message;
        retryable = true;
      } else {
        code = "failed";
        message = error instanceof Error ? error.message : String(error);
      }
      await respond({
        ok: false,
        error: harnessError(code, message, retryable),
      });
    } finally {
      clearTimeout(timer);
      inflight.delete(inflightKey);
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const pending of inflight.values()) pending.controller.abort();
    inflight.clear();
    services.clear();
  };

  return { register, processEvent, cancelWorker, dispose };
};
