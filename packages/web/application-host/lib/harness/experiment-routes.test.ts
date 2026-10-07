import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerHarnessExperimentRoutes } from "./experiment-routes.js";
import { HarnessServiceError } from "./service-error.js";
import { ThreadRuntimeError } from "./thread-runtime.js";

const attempt = {
  attemptId: "attempt-1",
  specId: "spec-1",
  backend: "local",
  machineId: "local",
  state: "running",
  collection: "none",
  createdAt: 1,
};

const machine = {
  machineId: "local",
  kind: "local",
  state: "available",
  connection: { status: "connected", checkedAt: 1 },
  commitments: [],
  queued: [],
};

const source = {
  sourceId: "source-1",
  kind: "dataset",
  path: "data/fixtures",
  state: "available",
  createdAt: 1,
};

const scope = {
  scopeId: "workspace-1",
  parent: { kind: "session" as const, id: "session-1" },
  snapshot: null,
};

const emptyRegistry = () => ({
  getSessionBinding: vi.fn(async () => null),
  resolveSessionOwner: vi.fn(async () => null),
  getThreadById: vi.fn(async () => null),
  listThreads: vi.fn(async () => []),
});

const fixture = () => {
  const experiments = {
    list: vi.fn(async () => ({ attempts: [attempt], text: "1 attempt" })),
    get: vi.fn(async () => ({ attempt, artifacts: [] })),
    logs: vi.fn(async () => ({ attemptId: attempt.attemptId, stream: "stdout", offset: 0, nextOffset: 3, eof: true, text: "out", origin: "live" })),
    cancel: vi.fn(async () => ({ ...attempt, state: "stopping" })),
    collect: vi.fn(async () => ({ attempt: { ...attempt, collection: "done" }, artifacts: [] })),
    readArtifact: vi.fn(async () => ({ name: "results/answer.txt", byteLength: 9, chunks: (async function* () { yield Buffer.from("answer="); yield Buffer.from("42"); })() })),
  };
  const resources = { list: vi.fn(async () => ({ machines: [machine], generatedAt: 2, text: "local" })) };
  const sources = { list: vi.fn(async () => ({ sources: [source], text: "1 source" })) };
  const runtime = {
    rootScopeForSession: vi.fn(async () => scope),
    scopeForSession: vi.fn(async () => scope),
  };
  const app = express();
  app.use(express.json());
  registerHarnessExperimentRoutes(app, {
    runtime: runtime as never,
    registry: emptyRegistry(),
    experiments: experiments as never,
    resources: resources as never,
    sources: sources as never,
  });
  return { app, experiments, resources, sources, runtime };
};

describe("harness experiment routes", () => {
  it("lists attempts through the session's owning workspace, ignoring caller-supplied scope", async () => {
    const { app, experiments, runtime } = fixture();
    const response = await request(app)
      .get("/api/harness/sessions/session-1/experiments?workspaceId=spoofed")
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.attempts).toEqual([attempt]);
    expect(runtime.scopeForSession).toHaveBeenCalledWith("session-1");
    expect(experiments.list).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", executionWorkspaceId: "workspace-1", sessionId: "session-1", rootSessionId: "session-1", allowedThreadIds: [] },
      {},
    );
  });

  it("rejects invalid filters and preserves an explicit empty limit", async () => {
    const { app, experiments } = fixture();
    await request(app).get("/api/harness/sessions/session-1/experiments?state=running").expect(200);
    expect(experiments.list).toHaveBeenLastCalledWith(expect.anything(), { state: "running" });
    await request(app).get("/api/harness/sessions/session-1/experiments?state=bogus").expect(400);
    await request(app).get("/api/harness/sessions/session-1/experiments?limit=0").expect(200);
    expect(experiments.list).toHaveBeenLastCalledWith(expect.anything(), { limit: 0 });
    await request(app).get("/api/harness/sessions/session-1/experiments/attempt-1/logs?stream=bogus").expect(400);
    await request(app).get("/api/harness/sessions/session-1/experiments/attempt-1/logs?offset=9007199254740993").expect(400);
  });

  it("reads a single attempt and streams logs with a cursor", async () => {
    const { app, experiments } = fixture();
    const detail = await request(app)
      .get("/api/harness/sessions/session-1/experiments/attempt-1")
      .expect(200);
    expect(detail.body.attempt).toEqual(attempt);
    expect(experiments.get).toHaveBeenCalledWith(expect.anything(), "attempt-1");

    const logs = await request(app)
      .get("/api/harness/sessions/session-1/experiments/attempt-1/logs?stream=stderr&offset=12&maxBytes=256")
      .expect(200);
    expect(logs.body.text).toBe("out");
    expect(experiments.logs).toHaveBeenCalledWith(expect.anything(), {
      attemptId: "attempt-1", stream: "stderr", offset: 12, maxBytes: 256,
    });
  });

  it("cancels and collects through the same service methods as the agent tool", async () => {
    const { app, experiments } = fixture();
    const cancelled = await request(app)
      .post("/api/harness/sessions/session-1/experiments/attempt-1/cancel")
      .expect(200);
    expect(cancelled.body.attempt.state).toBe("stopping");
    expect(experiments.cancel).toHaveBeenCalledWith(expect.anything(), "attempt-1");

    const collected = await request(app)
      .post("/api/harness/sessions/session-1/experiments/attempt-1/collect")
      .expect(200);
    expect(collected.body.attempt.collection).toBe("done");
    expect(experiments.collect).toHaveBeenCalledWith(expect.anything(), "attempt-1");
  });

  it("lists machines and sources for the owning workspace", async () => {
    const { app, resources, sources } = fixture();
    const machines = await request(app).get("/api/harness/sessions/session-1/resources").expect(200);
    expect(machines.body.machines).toEqual([machine]);
    expect(resources.list).toHaveBeenCalledWith("workspace-1");

    const listed = await request(app).get("/api/harness/sessions/session-1/sources?kind=dataset").expect(200);
    expect(listed.body.sources).toEqual([source]);
    expect(sources.list).toHaveBeenCalledWith("workspace-1", { kind: "dataset" }, expect.objectContaining({ allowedThreadIds: [] }));
  });

  it("maps service errors to honest statuses", async () => {
    const app = express();
    registerHarnessExperimentRoutes(app, {
      runtime: { scopeForSession: vi.fn(async () => scope) } as never,
      registry: emptyRegistry(),
      experiments: {
        get: vi.fn(async () => { throw new HarnessServiceError("not-found", "no such attempt"); }),
        list: vi.fn(async () => ({ attempts: [], text: "" })),
      } as never,
      resources: { list: vi.fn(async () => ({ machines: [], generatedAt: 0, text: "" })) } as never,
      sources: { list: vi.fn(async () => ({ sources: [], text: "" })) } as never,
    });
    const response = await request(app)
      .get("/api/harness/sessions/session-1/experiments/missing")
      .expect(404);
    expect(response.body.code).toBe("not-found");
  });

  it("maps an unknown session scope to the runtime's error contract", async () => {
    const app = express();
    registerHarnessExperimentRoutes(app, {
      runtime: {
        scopeForSession: vi.fn(async () => { throw new ThreadRuntimeError("not-found", "unknown session"); }),
      } as never,
      registry: emptyRegistry(),
      experiments: { list: vi.fn() } as never,
      resources: { list: vi.fn() } as never,
      sources: { list: vi.fn() } as never,
    });
    const response = await request(app).get("/api/harness/sessions/ghost/experiments").expect(404);
    expect(response.body.code).toBe("not-found");
  });

  it("enforces the auth hook before resolving scope", async () => {
    const app = express();
    const requireAuth = vi.fn((_request: express.Request, response: express.Response) => {
      response.status(401).json({ error: "unauthorized" });
    });
    const runtime = { scopeForSession: vi.fn(async () => scope) };
    registerHarnessExperimentRoutes(app, {
      runtime: runtime as never,
      registry: emptyRegistry(),
      experiments: { list: vi.fn() } as never,
      resources: { list: vi.fn() } as never,
      sources: { list: vi.fn() } as never,
      requireAuth,
    });
    await request(app).get("/api/harness/sessions/session-1/experiments").expect(401);
    expect(runtime.scopeForSession).not.toHaveBeenCalled();
  });

  it("reads collected artifact bytes through the authorized attempt service", async () => {
    const { app, experiments } = fixture();
    const result = await request(app)
      .get("/api/harness/sessions/session-1/experiments/attempt-1/artifacts/artifact-1").expect(200);
    expect(result.headers["content-disposition"]).toContain('filename="answer.txt"');
    expect(result.body.toString()).toBe("answer=42");
    expect(experiments.readArtifact).toHaveBeenCalledWith(expect.objectContaining({ allowedThreadIds: [] }), "attempt-1", "artifact-1", expect.any(AbortSignal));
  });
});
