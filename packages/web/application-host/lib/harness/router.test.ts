import { describe, expect, it, vi } from "vitest";
import type {
  HarnessActorContext,
  HarnessActorIdentity,
  HarnessCapability,
} from "@varin/protocol";
import { createHarnessRouter, type HarnessService } from "./router.js";

const ACTOR: HarnessActorIdentity = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
};

const resolvedActor = (grantedCapabilities: readonly HarnessCapability[]): HarnessActorContext => ({
  ...ACTOR,
  workspaceId: "workspace-1",
  grantedCapabilities,
});

const harnessEvent = (method: string, params: unknown, data: Record<string, unknown> = {}) => ({
  actor: ACTOR,
  kind: "host",
  envelope: {
    event: "harness.request",
    kind: "event",
    data: { requestId: "req-1", method, params, ...data },
  },
});

describe("harness router", () => {
  it("pins inherited shell placement before authorizing paths on the correct machine", async () => {
    const authorizeWorkspacePath = vi.fn(async () => null);
    const handle = vi.fn(async () => ({ kind: "spawn-failed" as const, reason: "fixture", interpreter: "", hint: "fixture" }));
    const respond = vi.fn(async () => undefined);
    const router = createHarnessRouter({ respond, resolveActor: async () => resolvedActor(["process.shell"]),
      authorizeWorkspacePath, resolveWorkTarget: async () => "managed:cloud" });
    router.register("shell.exec", { handle });
    await router.processEvent(harnessEvent("shell.exec", { command: "pwd", cwd: "/remote" }));
    expect(authorizeWorkspacePath).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ target: "managed:cloud", cwd: "/remote" }), expect.anything());
    expect(respond).toHaveBeenCalledWith(ACTOR, "req-1", expect.objectContaining({ ok: true }));
    router.dispose();
  });
  it("cancels a retired worker's in-flight query after actor registration is gone", async () => {
    let registered = true;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let querySignal: AbortSignal | undefined;
    const router = createHarnessRouter({
      respond: async () => undefined,
      resolveActor: async () => registered ? resolvedActor(["read.output"]) : null,
    });
    router.register("output.read", { handle: async (_params, ctx) => {
      querySignal = ctx.signal;
      entered();
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new DOMException("retired", "AbortError")), { once: true });
      });
      throw new Error("query must be cancelled");
    } });
    const pending = router.processEvent(harnessEvent("output.read", { handle: "out_1" }));
    await started;
    registered = false;
    await router.processEvent({ kind: "worker.exit", workerId: "other-worker" });
    expect(querySignal?.aborted).toBe(false);
    await router.processEvent({ kind: "worker.exit", workerId: ACTOR.workerId });
    await pending;
    expect(querySignal?.aborted).toBe(true);
    router.dispose();
  });

  it("dispatches with a Host-resolved actor and responds to its trusted session", async () => {
    const responses: Array<{ sessionId: string; requestId: string; ok: boolean; result?: unknown }> = [];
    const router = createHarnessRouter({
      respond: async (identity, requestId, outcome) => {
        responses.push({ sessionId: identity.sessionId, requestId, ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    const echoService: HarnessService<"output.store"> = {
      handle: async (params, ctx) => {
        expect(ctx.actor).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" });
        return { ref: { durability: "ephemeral", generation: "test", handle: "out_echo" }, total: params.text.length };
      },
    };
    router.register("output.store", echoService);
    await router.processEvent(harnessEvent("output.store", { text: "hello" }, {
      // Unknown wire fields never override the broker-owned actor.
      sessionId: "session-forged",
    }));
    expect(responses).toEqual([{
      sessionId: "session-1",
      requestId: "req-1",
      ok: true,
      result: { ref: { durability: "ephemeral", generation: "test", handle: "out_echo" }, total: 5 },
    }]);
    router.dispose();
  });

  it("responds with unavailable for a permitted but unregistered method", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["process.shell"]),
    });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "unavailable" }]);
    router.dispose();
  });

  it("preserves a compaction stall across the Host bridge for the session retry policy", async () => {
    const responses: Array<{ code?: string; retryable?: boolean }> = [];
    const router = createHarnessRouter({
      respond: async (_identity, _requestId, outcome) => {
        if (!outcome.ok) responses.push({ code: outcome.error.code,
          ...(outcome.error.retryable === undefined ? {} : { retryable: outcome.error.retryable }) });
      },
      resolveActor: async () => resolvedActor(["context.session"]),
    });
    router.register("compaction.run", { handle: async () => {
      throw Object.assign(new Error("no response"), { code: "compaction_stalled" });
    } });
    await router.processEvent(harnessEvent("compaction.run", {}, { timeoutMs: 0 }));
    expect(responses).toEqual([{ code: "compaction-stalled", retryable: true }]);
    router.dispose();
  });

  it("rejects a method whose static capability was not granted", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("shell.exec", { handle: async () => ({ kind: "completed", exitCode: 0, durationMs: 0, cwd: ".", stdout: "", stderr: "", handle: null, shown: null }) });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("enforces an auxiliary actor's method allowlist and responds to its own worker", async () => {
    const auxActor: HarnessActorIdentity = { ...ACTOR, workerId: "worker-compaction" };
    const responses: Array<{ workerId: string; ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (identity, _requestId, outcome) => {
        responses.push({ workerId: identity.workerId, ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async (identity) => identity.workerId === "worker-compaction"
        ? { ...resolvedActor(["context.session", "read.output", "control.thread"]), allowedMethods: ["compaction.history"] }
        : null,
    });
    // A granted capability is not enough: the method must be in the allowlist.
    await router.processEvent({
      ...harnessEvent("output.read", { handle: "out_1" }),
      actor: auxActor,
    });
    expect(responses).toEqual([{ workerId: "worker-compaction", ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("rejects an out-of-workspace path before dispatch", async () => {
    const handle = vi.fn(async () => ({ held: true as const, leaseIds: ["lease-1"] }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["write.document"]),
      authorizeWorkspacePath: async () => null,
    });
    router.register("fs.lock", { handle });
    await router.processEvent(harnessEvent("fs.lock", { action: "acquire", paths: ["../outside.txt"] }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("authorizes native document reads with allowMissing for dirty-only files", async () => {
    const responses: Array<{ ok: boolean; result?: unknown }> = [];
    const authorize = vi.fn(async (_actor: HarnessActorContext, path: string, options: { allowMissing: boolean }) => ({
      authorityId: "host-1",
      canonicalResourceId: path,
      inputPath: path,
      resourceId: path,
      workspaceId: "workspace-1",
      ...options,
    }));
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.document"]),
      authorizeWorkspacePath: authorize,
    });
    router.register("document.readSource", { handle: async () => ({ source: "disk", base64: "dGVzdA==" }) });
    await router.processEvent(harnessEvent("document.readSource", { path: "new.ts" }));
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "new.ts", { allowMissing: true });
    expect(responses).toEqual([{ ok: true, result: { source: "disk", base64: "dGVzdA==" } }]);
    router.dispose();
  });

  it("authorizes native document path overlays with an allowMissing root", async () => {
    const authorize = vi.fn(async (_actor: HarnessActorContext, candidate: string, options: { allowMissing: boolean }) => ({
      authorityId: "host-1",
      canonicalResourceId: candidate,
      inputPath: candidate,
      resourceId: candidate,
      workspaceId: "workspace-1",
      ...options,
    }));
    const responses: Array<{ ok: boolean; result?: unknown }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.document"]),
      authorizeWorkspacePath: authorize,
    });
    router.register("document.pathOverlay", { handle: async () => ({ status: "disk" as const }) });
    await router.processEvent(harnessEvent("document.pathOverlay", { path: "src" }));
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "src", { allowMissing: true });
    expect(responses).toEqual([{ ok: true, result: { status: "disk" } }]);
    router.dispose();
  });

  it("authorizes explore path anchors separately and leaves symbol anchors untouched", async () => {
    const authorize = vi.fn(async (_actor: HarnessActorContext, candidate: string, options: { allowMissing: boolean }) => ({
      authorityId: "host-1",
      canonicalResourceId: `/workspace/${candidate}`,
      inputPath: candidate,
      resourceId: candidate.replace(/^C:\/workspace\//i, "").replaceAll("\\", "/"),
      workspaceId: "workspace-1",
      ...options,
    }));
    let authorizedPaths: readonly { resourceId: string }[] = [];
    const router = createHarnessRouter({
      respond: async () => undefined,
      resolveActor: async () => resolvedActor(["read.search"]),
      authorizeWorkspacePath: authorize,
    });
    router.register("explore.query.start", { handle: async (_params, ctx) => {
      authorizedPaths = ctx.authorizedPaths;
      return { queryId: "q1", question: "needle", deadlineAt: 1, parsed: { objects: [], relation: "unknown", domain: "unknown" }, vocab: { objects: [], anchors: [] }, sources: [], inputSource: "disk" };
    } });
    await router.processEvent(harnessEvent("explore.query.start", {
      question: "needle",
      paths: ["project-a"],
      anchors: ["C:/workspace/project-b/src/target.ts", "Target.method"],
    }));
    expect(authorize.mock.calls.map(([, candidate, options]) => [candidate, options.allowMissing])).toEqual([
      ["project-a", false],
      ["C:/workspace/project-b/src/target.ts", true],
    ]);
    expect(authorizedPaths.map(({ resourceId }) => resourceId)).toEqual([
      "project-a",
      "project-b/src/target.ts",
    ]);
    router.dispose();
  });

  it("fails closed when a path-shaped explore anchor is outside authorization", async () => {
    const handle = vi.fn(async () => ({
      queryId: "q1",
      question: "needle",
      deadlineAt: 1,
      parsed: { objects: [], relation: "unknown" as const, domain: "unknown" as const },
      vocab: { objects: [], anchors: [] },
      sources: [],
      inputSource: "disk" as const,
    }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.search"]),
      authorizeWorkspacePath: async () => null,
    });
    router.register("explore.query.start", { handle });
    await router.processEvent(harnessEvent("explore.query.start", {
      question: "needle",
      anchors: ["../outside/target.ts"],
    }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("validates every child scope path before creating a thread", async () => {
    const handle = vi.fn(async () => ({ text: "created", threadId: "thread-1", queued: false }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const authorize = vi.fn(async (_actor: HarnessActorContext, candidate: string) => (
      candidate === "src/new-file.ts"
        ? { authorityId: "host-1", workspaceId: "workspace-1", canonicalResourceId: candidate, inputPath: candidate, resourceId: candidate }
        : null
    ));
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["control.thread"]),
      authorizeWorkspacePath: authorize,
    });
    router.register("thread.dispatch", { handle });
    await router.processEvent(harnessEvent("thread.dispatch", {
      preset: "check",
      task: "inspect",
      scope: ["src/new-file.ts", "../outside"],
    }));
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "src/new-file.ts", { allowMissing: true });
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("applies workspace path authorization to LSP navigation", async () => {
    const handle = vi.fn(async () => ({ status: "empty" as const, text: "No definition found" }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
      authorizeWorkspacePath: async () => null,
    });
    router.register("lsp.definition", { handle });
    await router.processEvent(harnessEvent("lsp.definition", { path: "../other/a.ts", line: 1 }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("rejects non-one-based LSP positions before calling the service", async () => {
    const handle = vi.fn(async () => ({ status: "empty" as const, text: "No hover information" }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
    });
    router.register("lsp.hover", { handle });
    await router.processEvent(harnessEvent("lsp.hover", { path: "src/a.ts", line: 0 }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "invalid-params" }]);
    router.dispose();
  });

  it("rejects a non-boolean diagnostics full selector before calling the service", async () => {
    const handle = vi.fn(async () => ({ status: "ready" as const, diagnostics: [] }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
      authorizeWorkspacePath: async (_actor, path) => ({ authorityId: "host", workspaceId: "workspace-1", canonicalResourceId: path, inputPath: path, resourceId: path }),
    });
    router.register("lsp.diagnosticsSnapshot", { handle });
    await router.processEvent(harnessEvent("lsp.diagnosticsSnapshot", { path: "src/a.ts", full: "yes" }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "invalid-params" }]);
    router.dispose();
  });

  it("responds with failed when a service throws", async () => {
    const responses: Array<{ ok: boolean; code?: string; message?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push(outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.error.code, message: outcome.error.message });
      },
      resolveActor: async () => resolvedActor(["process.shell"]),
    });
    router.register("shell.exec", { handle: async () => { throw new Error("boom"); } });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "failed", message: "boom" }]);
    router.dispose();
  });

  it("commits deferred observation state only after the success response is delivered", async () => {
    const commit = vi.fn();
    const abort = vi.fn();
    const router = createHarnessRouter({
      respond: async () => undefined,
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("output.store", {
      handle: async (_params, ctx) => {
        ctx.deferResponseDelivery?.(commit, abort);
        return { ref: { durability: "ephemeral", generation: "g", handle: "out_1" }, total: 1 };
      },
    });
    await router.processEvent(harnessEvent("output.store", { text: "x" }));
    expect(commit).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    router.dispose();
  });

  it("aborts deferred observation state when the success response cannot be delivered", async () => {
    const commit = vi.fn();
    const abort = vi.fn();
    let responses = 0;
    const router = createHarnessRouter({
      respond: async () => {
        responses += 1;
        if (responses === 1) throw new Error("delivery failed");
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("output.store", {
      handle: async (_params, ctx) => {
        ctx.deferResponseDelivery?.(commit, abort);
        return { ref: { durability: "ephemeral", generation: "g", handle: "out_1" }, total: 1 };
      },
    });
    await router.processEvent(harnessEvent("output.store", { text: "x" }));
    expect(abort).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    router.dispose();
  });

  it("responds with unavailable for unknown method names", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor([]),
    });
    await router.processEvent(harnessEvent("nonexistent.method", {}));
    expect(responses).toEqual([{ ok: false, code: "unavailable" }]);
    router.dispose();
  });

  it("allows a thread actor to cancel its admitted merge without granting search access", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const cancelExploreQuery = vi.fn(() => true);
    const router = createHarnessRouter({
      respond: async () => {},
      resolveActor: async () => resolvedActor(["control.thread"]),
      cancelExploreQuery,
    });
    let signal!: AbortSignal;
    router.register("thread.merge", {
      handle: async (_params, ctx) => {
        signal = ctx.signal;
        entered();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
        return { text: "", merged: 0, conflicts: [] };
      },
    });
    const request = router.processEvent(harnessEvent("thread.merge", { threadId: "thread-1" }));
    try {
      await ready;
      await router.processEvent({
        actor: ACTOR, kind: "host",
        envelope: { kind: "event", event: "harness.cancel", data: { requestId: "req-1", queryId: "eq_ungranted" } },
      });
      expect(signal.aborted).toBe(true);
      expect(cancelExploreQuery).not.toHaveBeenCalled();
    } finally {
      router.dispose();
      await request;
    }
  });

  it("aborts the inflight request and the explore query on harness.cancel", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const cancelled: string[] = [];
    let sawAbort = false;
    let entered!: () => void;
    const enteredHandle = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.search"]),
      cancelExploreQuery: (actor, queryId) => {
        cancelled.push(`${actor.sessionId}:${queryId}`);
        return true;
      },
    });
    router.register("explore.query.views", {
      handle: async (_params, ctx) => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            sawAbort = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (ctx.signal.aborted) fail();
          else ctx.signal.addEventListener("abort", fail, { once: true });
        });
        return { queryId: "eq_1", question: "x", views: [], unevaluated: 0, sources: [], deadlineAt: Date.now() };
      },
    });
    const pending = router.processEvent(harnessEvent("explore.query.views", { queryId: "eq_1" }, { requestId: "req-wait" }));
    await enteredHandle;
    await router.processEvent({
      actor: ACTOR,
      kind: "host",
      envelope: {
        event: "harness.cancel",
        kind: "event",
        data: { requestId: "req-wait", queryId: "eq_1" },
      },
    });
    await pending;
    expect(sawAbort).toBe(true);
    expect(cancelled).toEqual(["session-1:eq_1"]);
    expect(responses).toEqual([{ ok: false, code: "timeout" }]);
    router.dispose();
  });

  it("does not abort another session's inflight requestId on harness.cancel", async () => {
    const cancelled: string[] = [];
    let sawAbort = false;
    let entered!: () => void;
    const enteredHandle = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const router = createHarnessRouter({
      respond: async () => undefined,
      resolveActor: async (identity) => ({
        ...identity,
        workspaceId: "workspace-1",
        grantedCapabilities: ["read.search"],
      }),
      cancelExploreQuery: (actor, queryId) => {
        cancelled.push(`${actor.sessionId}:${queryId}`);
        return true;
      },
    });
    router.register("explore.query.views", {
      handle: async (_params, ctx) => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            sawAbort = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (ctx.signal.aborted) fail();
          else ctx.signal.addEventListener("abort", fail, { once: true });
        });
        return { queryId: "eq_1", question: "x", views: [], unevaluated: 0, sources: [], deadlineAt: Date.now() };
      },
    });
    const pending = router.processEvent(harnessEvent("explore.query.views", { queryId: "eq_1" }, { requestId: "req-wait" }));
    await enteredHandle;
    await router.processEvent({
      actor: { ...ACTOR, sessionId: "session-other", workerId: "worker-other" },
      kind: "host",
      envelope: {
        event: "harness.cancel",
        kind: "event",
        data: { requestId: "req-wait", queryId: "eq_1" },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(sawAbort).toBe(false);
    expect(cancelled).toEqual(["session-other:eq_1"]);
    router.dispose();
    await pending.catch(() => undefined);
  });

  it("ignores non-harness events and harness events without a broker actor", async () => {
    const respond = vi.fn(async () => undefined);
    const router = createHarnessRouter({
      respond,
      resolveActor: async () => null,
    });
    await router.processEvent({
      actor: ACTOR,
      kind: "host",
      envelope: { event: "agent.event", kind: "event", data: {} },
    });
    await router.processEvent({
      kind: "host",
      envelope: { event: "harness.request", kind: "event", data: { requestId: "req-2", method: "output.read", params: {} } },
    });
    expect(respond).not.toHaveBeenCalled();
    router.dispose();
  });
});


describe("scheduler wait admission transport", () => {
  it("does not time out thread.wait admission but disposal cancels the handler", async () => {
    let signal: AbortSignal | undefined;
    const router = createHarnessRouter({
      defaultTimeoutMs: 10, respond: async () => undefined,
      resolveActor: async () => resolvedActor(["control.thread"]),
    });
    router.register("thread.wait", {
      handle: async (_params, ctx) => {
        signal = ctx.signal;
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { text: "cancelled", done: 0, running: 0, waiting: 0, queued: 0, timedOut: false };
      },
    });
    const pending = router.processEvent(harnessEvent("thread.wait", { timeoutMs: 5 }, { timeoutMs: 0 }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal!.aborted).toBe(false);
    router.dispose();
    await pending;
    expect(signal!.aborted).toBe(true);
  });

  it("keeps an explicitly long shell observation alive until cancellation", async () => {
    let signal: AbortSignal | undefined;
    const router = createHarnessRouter({
      defaultTimeoutMs: 10, respond: async () => undefined,
      resolveActor: async () => resolvedActor(["process.shell"]),
    });
    router.register("shell.read", {
      handle: async (_params, ctx) => {
        signal = ctx.signal;
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: true, running: false };
      },
    });
    const pending = router.processEvent(harnessEvent("shell.read", { id: "sh_1", waitMs: 60_000 }, { timeoutMs: 0 }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal!.aborted).toBe(false);
    router.dispose();
    await pending;
    expect(signal!.aborted).toBe(true);
  });
});
