import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerHarnessFollowUpRoutes } from "./follow-up-routes.js";
import { HarnessServiceError } from "./service-error.js";

const followUp = {
  createdAt: 1,
  id: "fu-1",
  instruction: "handle the result",
  pausedGoal: false,
  revision: "3",
  sessionId: "session-1",
  source: { kind: "manual" },
  status: "waiting",
  threadId: "thread-1",
  updatedAt: 1,
  waitingSummary: "Waiting for explicit trigger",
  workspaceId: "workspace-1",
};

const scope = {
  scopeId: "workspace-1",
  parent: { kind: "session" as const, id: "session-1" },
  snapshot: null,
};

const fixture = (options: { bound?: boolean; authenticated?: boolean } = {}) => {
  const bound = options.bound ?? true;
  const registry = {
    getSessionBinding: vi.fn(async () => bound ? { threadId: "thread-1", runId: "run-1" } : null),
    resolveSessionOwner: vi.fn(async () => bound ? { owningScopeId: "workspace-1", threadId: "thread-1", runId: "run-1", owner: "spawned-child" } : null),
    getThreadById: vi.fn(async () => bound
      ? { id: "thread-1", lifecycle: "settled", parent: { kind: "session", id: "session-1" } }
      : null),
    listThreads: vi.fn(async () => []),
  };
  const followUps = {
    register: vi.fn(async () => ({ followUp, firedImmediately: false })),
    cancel: vi.fn(async () => ({ followUp: { ...followUp, status: "cancelled" }, occurrences: [] })),
    check: vi.fn(async () => ({ fired: false, followUp, observed: { note: "no program-evaluable condition" } })),
    fire: vi.fn(async () => ({ followUp: { ...followUp, status: "delivered" }, occurrences: [] })),
    get: vi.fn(async () => ({ followUp, occurrences: [] })),
    list: vi.fn(async () => ({ followUps: [followUp] })),
    listForHost: vi.fn(async () => ({ followUps: [followUp] })),
    update: vi.fn(async () => ({ followUp: { ...followUp, instruction: "revised" } })),
  };
  const runtime = { scopeForSession: vi.fn(async () => scope) };
  const app = express();
  app.use(express.json());
  registerHarnessFollowUpRoutes(app, {
    followUps: followUps as never,
    registry: registry as never,
    runtime: runtime as never,
    requireAuth: (_request, response, next) => {
      if (options.authenticated === false) response.sendStatus(401);
      else next();
    },
  });
  return { app, followUps, registry, runtime };
};

describe("harness follow-up routes", () => {
  it("creates a follow-up for the selected session and ignores caller-supplied scope", async () => {
    const { app, followUps } = fixture();
    const source = { kind: "time", at: 2_000_000_000_000, timezone: "Asia/Shanghai" };
    await request(app).post("/api/harness/sessions/session-1/follow-ups").send({
      instruction: "  continue the experiment  ", source,
      workspaceId: "wrong-workspace", sessionId: "wrong-session", threadId: "wrong-thread",
    }).expect(201);
    expect(followUps.register).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", sessionId: "session-1", threadId: "thread-1" }),
      { instruction: "continue the experiment", source, pause: false },
    );
  });

  it("validates creation input and retains shared source validation errors", async () => {
    const { app, followUps } = fixture();
    await request(app).post("/api/harness/sessions/session-1/follow-ups").send({ instruction: 42 }).expect(400);
    expect(followUps.register).not.toHaveBeenCalled();
    followUps.register.mockRejectedValueOnce(new HarnessServiceError("invalid-params", "invalid source"));
    await request(app).post("/api/harness/sessions/session-1/follow-ups").send({ instruction: "continue", source: {} }).expect(400);
  });

  it("updates a trigger through the same revision-checked service", async () => {
    const { app, followUps } = fixture();
    const source = { kind: "file", path: "results.json", condition: "exists" };
    await request(app).post("/api/harness/sessions/session-1/follow-ups/fu-1/update")
      .send({ source, expectedRevision: "3" }).expect(200);
    expect(followUps.update).toHaveBeenCalledWith(expect.anything(), { id: "fu-1", source, expectedRevision: "3" });
  });
  it("provides an authenticated Host overview without changing session-scoped actions", async () => {
    const { app, followUps } = fixture();
    const response = await request(app).get("/api/harness/follow-ups?includeInactive=true").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.followUps[0].sessionId).toBe("session-1");
    expect(followUps.listForHost).toHaveBeenCalledWith({ includeInactive: true });
    expect(followUps.list).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated overview before reading registrations", async () => {
    const { app, followUps } = fixture({ authenticated: false });
    await request(app).get("/api/harness/follow-ups").expect(401);
    expect(followUps.listForHost).not.toHaveBeenCalled();
  });
  it("lists the session's follow-ups through its owning workspace", async () => {
    const { app, followUps } = fixture();
    const response = await request(app)
      .get("/api/harness/sessions/session-1/follow-ups")
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.followUps).toHaveLength(1);
    expect(followUps.list).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", threadId: "thread-1", workspaceId: "workspace-1" }),
      { includeInactive: false },
    );
  });

  it("keeps check (program evaluation) and fire (agent invocation) as separate endpoints", async () => {
    const { app, followUps } = fixture();
    const check = await request(app)
      .post("/api/harness/sessions/session-1/follow-ups/fu-1/check")
      .send({})
      .expect(200);
    expect(check.body.fired).toBe(false);
    expect(followUps.check).toHaveBeenCalledWith(expect.anything(), { id: "fu-1" });
    expect(followUps.fire).not.toHaveBeenCalled();

    await request(app)
      .post("/api/harness/sessions/session-1/follow-ups/fu-1/fire")
      .send({ reason: "user asked" })
      .expect(200);
    expect(followUps.fire).toHaveBeenCalledWith(expect.anything(), { id: "fu-1", reason: "user asked" });
  });

  it("cancels a wait without touching the watched work", async () => {
    const { app, followUps } = fixture();
    const response = await request(app)
      .post("/api/harness/sessions/session-1/follow-ups/fu-1/cancel")
      .send({})
      .expect(200);
    expect(response.body.followUp.status).toBe("cancelled");
    expect(followUps.cancel).toHaveBeenCalledWith(expect.anything(), { id: "fu-1" });
  });

  it("lists and cancels a settled child's registration through durable ownership", async () => {
    const { app, followUps, registry, runtime } = fixture();
    registry.getSessionBinding.mockRejectedValue(new Error("Thread session binding is no longer the current owner"));
    runtime.scopeForSession.mockRejectedValue(new Error("Pi worker is closed"));
    await request(app).get("/api/harness/sessions/session-1/follow-ups").expect(200);
    await request(app).post("/api/harness/sessions/session-1/follow-ups/fu-1/cancel").send({ expectedRevision: "3" }).expect(200);
    expect(followUps.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", sessionId: "session-1", threadId: "thread-1" }),
      { id: "fu-1", expectedRevision: "3" },
    );
    expect(registry.getSessionBinding).not.toHaveBeenCalled();
    expect(runtime.scopeForSession).not.toHaveBeenCalled();
  });

  it("updates the instruction with a CAS revision", async () => {
    const { app, followUps } = fixture();
    const response = await request(app)
      .post("/api/harness/sessions/session-1/follow-ups/fu-1/update")
      .send({ expectedRevision: "3", instruction: "revised" })
      .expect(200);
    expect(response.body.followUp.instruction).toBe("revised");
    expect(followUps.update).toHaveBeenCalledWith(expect.anything(), {
      expectedRevision: "3",
      id: "fu-1",
      instruction: "revised",
    });
  });

  it("maps service errors to honest statuses", async () => {
    const { app, followUps } = fixture();
    followUps.get.mockRejectedValueOnce(new HarnessServiceError("not-found", "unknown follow-up"));
    await request(app).get("/api/harness/sessions/session-1/follow-ups/nope").expect(404);
    followUps.cancel.mockRejectedValueOnce(new HarnessServiceError("invalid-params", "bad revision"));
    await request(app)
      .post("/api/harness/sessions/session-1/follow-ups/fu-1/cancel")
      .send({ expectedRevision: "0" })
      .expect(400);
  });
});
