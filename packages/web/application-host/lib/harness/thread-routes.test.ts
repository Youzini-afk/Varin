import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerHarnessThreadRoutes } from "./thread-routes.js";
import { ThreadRuntimeError } from "./thread-runtime.js";

describe("harness thread routes", () => {
  it("projects the Host registry from an authoritative session scope", async () => {
    const app = express();
    const thread = { id: "thread-1", brief: "test" };
    registerHarnessThreadRoutes(app, {
      registry: {
        listThreads: vi.fn(async () => [thread]),
        resolveSessionOwner: vi.fn(async () => null),
        listTaskThreadSnapshots: vi.fn(async () => []),
        getActiveRun: vi.fn(async () => ({ id: "run-1", workerState: "running" })),
      } as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({
          scopeId: "workspace-1",
          parent: { kind: "session", id: "session-1" },
          snapshot: {},
        })),
      } as never,
    });
    const response = await request(app).get("/api/harness/sessions/session-1/threads").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      includeArchived: false,
      threads: [{ thread, activeRun: { id: "run-1", workerState: "running" } }],
      rootThreads: [],
      branches: [],
    });
  });

  it("creates and converts discussions without accepting a caller-supplied workspace identity", async () => {
    const app = express();
    app.use(express.json());
    const created = {
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      thread: { id: "thread-1", kind: "discussion" },
      activeRun: { id: "run-1", sessionId: "child-1" },
    };
    const createDiscussion = vi.fn(async () => created);
    const convertDiscussion = vi.fn(async () => ({
      ...created,
      thread: { id: "thread-1", kind: "implementation" },
      activeRun: { id: "run-2", sessionId: "child-1" },
    }));
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: { createDiscussion, convertDiscussion } as never,
    });

    const createResponse = await request(app)
      .post("/api/harness/sessions/session-1/threads")
      .send({ entryId: "entry-1", carryBlocks: false, workspaceId: "spoofed" })
      .expect(201);
    expect(createResponse.body).toEqual(created);
    expect(createDiscussion).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      entryId: "entry-1",
      carryBlocks: false,
    });

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/convert")
      .send({ workspaceId: "spoofed" })
      .expect(200);
    expect(convertDiscussion).toHaveBeenCalledWith({ parentSessionId: "session-1", threadId: "thread-1" });
  });

  it("previews, merges, and undoes through the Host runtime without accepting surface bodies", async () => {
    const app = express();
    app.use(express.json());
    const preview = {
      operationId: "op-1",
      threadId: "thread-1",
      resultRevision: 1,
      bindingFingerprint: "a".repeat(64),
      valid: true,
      mergeReady: true,
      binding: {},
      paths: [],
      conflictPaths: [],
      surfaceTargetPaths: ["draft.txt"],
      unavailablePaths: [],
      appliedPaths: [],
    };
    const previewIntegration = vi.fn(async () => preview);
    const merge = vi.fn(async () => ({
      merged: 0,
      conflicts: [],
      preview,
      operationId: "op-1",
      resultRevision: 1,
    }));
    const undoIntegration = vi.fn(async () => ({ status: "compensated", operationId: "op-1" }));
    const getThread = vi.fn(async () => ({ id: "thread-1", integration: "dirty" }));
    registerHarnessThreadRoutes(app, {
      registry: { getThread } as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({
          scopeId: "workspace-1",
          parent: { kind: "session", id: "session-1" },
        })),
        previewIntegration,
        merge,
        undoIntegration,
      } as never,
    });

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/integration")
      .send({ surfaceParents: [{ resourceId: "draft.txt", localEditRevision: 2, baseRevision: "base", content: "parent" }] })
      .expect(400);
    const sourceOwner = { ownerId: "document-surface", generation: 2 };
    const previewResponse = await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/integration")
      .send({ sourceOwner })
      .expect(200);
    expect(previewResponse.body.preview).toEqual(preview);
    expect(previewIntegration).toHaveBeenCalledWith(
      "workspace-1",
      { kind: "session", id: "session-1" },
      "thread-1",
      expect.objectContaining({ sourceOwner }),
    );

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/merge")
      .send({
        resultRevision: 1,
        sourceOwner,
        expectedBindingFingerprint: "a".repeat(64),
        resolutions: [{ path: "draft.txt", choice: "child", expectedParentRevision: "surface-revision", expectedLocalEditRevision: 2 }],
      })
      .expect(200);
    expect(merge).toHaveBeenCalledWith(
      "workspace-1",
      { kind: "session", id: "session-1" },
      "thread-1",
      1,
      undefined,
      expect.objectContaining({ sourceOwner, expectedBindingFingerprint: "a".repeat(64), resolutions: [expect.objectContaining({ path: "draft.txt", choice: "child" })] }),
    );

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/integration/undo")
      .send({ operationId: "op-1", sourceOwner })
      .expect(200);
    expect(undoIntegration).toHaveBeenCalledWith(
      "workspace-1",
      { kind: "session", id: "session-1" },
      "thread-1",
      expect.objectContaining({ operationId: "op-1", sourceOwner }),
    );
  });

  it("keeps stale fork points distinct from malformed input", async () => {
    const app = express();
    app.use(express.json());
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: {
        createDiscussion: vi.fn(async () => {
          throw new ThreadRuntimeError("conflict", "message left the branch");
        }),
      } as never,
    });
    await request(app)
      .post("/api/harness/sessions/session-1/threads")
      .send({ entryId: "entry-old" })
      .expect(409, { code: "conflict", error: "message left the branch" });
  });

  it("runs UI authentication before exposing thread metadata", async () => {
    const app = express();
    const listThreads = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: { listThreads } as never,
      runtime: { scopeForSession: vi.fn() } as never,
      requireAuth: (_req, res) => { res.status(401).json({ error: "auth required" }); },
    });
    await request(app)
      .get("/api/harness/sessions/session-1/threads")
      .expect(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("archives, restores, reclaims, and inspects space through the Host runtime", async () => {
    const app = express();
    app.use(express.json());
    const archived = { id: "thread-1", lifecycle: "archived", report: { conclusion: "done" } };
    const archiveUser = vi.fn(async () => ({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      thread: archived,
      activeRun: { id: "run-1", sessionId: "child-1", outcome: "cancelled" },
      reclaimed: true,
    }));
    const restoreUser = vi.fn(async () => ({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      thread: { ...archived, lifecycle: "settled" },
      activeRun: { id: "run-1", sessionId: "child-1", outcome: "cancelled" },
      restoreStatus: "path-occupied",
      message: "Original thread path is occupied by other content",
    }));
    const reclaimUser = vi.fn(async () => ({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      thread: archived,
      activeRun: null,
      reclaimed: false,
      message: "User requested keep_worktree",
    }));
    const inspectSpace = vi.fn(async () => ({
      workspaceId: "workspace-1",
      threads: [{ threadId: "thread-1", reclaimable: false, keepReasons: ["User requested keep_worktree"] }],
      status: "ok",
      note: "logical occupancy",
      uniqueObjectLogicalBytes: 12,
      uniqueObjectUnknown: false,
      materializedLogicalBytes: 0,
      freeBytes: 100,
    }));
    const listThreads = vi.fn(async () => [archived]);
    registerHarnessThreadRoutes(app, {
      registry: {
        listThreads,
        getActiveRun: vi.fn(async () => null),
        resolveSessionOwner: vi.fn(async () => null),
        listTaskThreadSnapshots: vi.fn(async () => []),
        setKeepWorktree: vi.fn(async () => ({ ...archived, keepWorktree: true })),
      } as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({
          scopeId: "workspace-1",
          parent: { kind: "session", id: "session-1" },
        })),
        archiveUser,
        restoreUser,
        reclaimUser,
        inspectSpace,
      } as never,
    });

    const hidden = await request(app).get("/api/harness/sessions/session-1/threads").expect(200);
    expect(hidden.body.includeArchived).toBe(false);
    expect(hidden.body.threads).toEqual([]);

    const shown = await request(app).get("/api/harness/sessions/session-1/threads?archived=1").expect(200);
    expect(shown.body.includeArchived).toBe(true);
    expect(shown.body.threads).toHaveLength(1);

    await request(app).post("/api/harness/sessions/session-1/threads/thread-1/archive").send({ keepWorktree: false }).expect(200);
    expect(archiveUser).toHaveBeenCalledWith("workspace-1", { kind: "session", id: "session-1" }, "thread-1", false);

    const restored = await request(app).post("/api/harness/sessions/session-1/threads/thread-1/restore").expect(200);
    expect(restored.body.restoreStatus).toBe("path-occupied");
    expect(restoreUser).toHaveBeenCalledWith("workspace-1", { kind: "session", id: "session-1" }, "thread-1");

    await request(app).post("/api/harness/sessions/session-1/threads/thread-1/reclaim").expect(200);
    expect(reclaimUser).toHaveBeenCalled();

    const space = await request(app).get("/api/harness/sessions/session-1/space").expect(200);
    expect(space.body.status).toBe("ok");
    expect(inspectSpace).toHaveBeenCalledWith("workspace-1", { kind: "session", id: "session-1" });
  });

  it("deletes a thread through the runtime lifecycle cascade on an authenticated route", async () => {
    const app = express();
    app.use(express.json());
    const deleteUser = vi.fn(async () => ({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      deletedThreadIds: ["child-2", "thread-1"],
      space: { status: "ok" },
    }));
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({
          scopeId: "workspace-1",
          parent: { kind: "session", id: "session-1" },
        })),
        deleteUser,
      } as never,
    });

    const response = await request(app)
      .delete("/api/harness/sessions/session-1/threads/thread-1")
      .expect(200);
    expect(response.body.deletedThreadIds).toEqual(["child-2", "thread-1"]);
    expect(deleteUser).toHaveBeenCalledWith("workspace-1", { kind: "session", id: "session-1" }, "thread-1");
  });

  it("rejects thread deletion without authentication and maps a missing thread", async () => {
    const app = express();
    const deleteUser = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: { scopeForSession: vi.fn(), deleteUser } as never,
      requireAuth: (_req, res) => { res.status(401).json({ error: "auth required" }); },
    });
    await request(app).delete("/api/harness/sessions/session-1/threads/thread-1").expect(401);
    expect(deleteUser).not.toHaveBeenCalled();

    const missing = express();
    registerHarnessThreadRoutes(missing, {
      registry: {} as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({ scopeId: "w", parent: { kind: "session", id: "s" } })),
        deleteUser: vi.fn(async () => { throw new ThreadRuntimeError("not-found", "Thread not found: thread-9"); }),
      } as never,
    });
    await request(missing)
      .delete("/api/harness/sessions/s/threads/thread-9")
      .expect(404, { code: "not-found", error: "Thread not found: thread-9" });
  });

  it("delivers directed messages through the send callback and returns the thread projection", async () => {
    const app = express();
    app.use(express.json());
    const sendToThread = vi.fn(async () => ({ status: "delivered", requestId: "req-1" }));
    const getThread = vi.fn(async () => ({ id: "thread-1", lifecycle: "active" }));
    const getActiveRun = vi.fn(async () => ({ id: "run-1", workerState: "running" }));
    const scopeForSession = vi.fn(async () => ({
      scopeId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
    }));
    registerHarnessThreadRoutes(app, {
      registry: { getThread, getActiveRun } as never,
      runtime: { scopeForSession } as never,
      sendToThread,
    });

    const response = await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "please revisit the diff", kind: "request", context: "continue", requestId: "req-1" })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      result: { status: "delivered", requestId: "req-1" },
      thread: { id: "thread-1", lifecycle: "active" },
      activeRun: { id: "run-1", workerState: "running" },
    });
    expect(sendToThread).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      threadId: "thread-1",
      message: "please revisit the diff",
      kind: "request",
      context: "continue",
      requestId: "req-1",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects malformed send bodies and reports missing configuration", async () => {
    const app = express();
    app.use(express.json());
    const sendToThread = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: { scopeForSession: vi.fn() } as never,
      sendToThread,
    });

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "" })
      .expect(400);
    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "hi", kind: "shout" })
      .expect(400);
    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "hi", workspaceId: "spoofed" })
      .expect(400);
    expect(sendToThread).not.toHaveBeenCalled();

    const unconfigured = express();
    unconfigured.use(express.json());
    registerHarnessThreadRoutes(unconfigured, {
      registry: {} as never,
      runtime: { scopeForSession: vi.fn() } as never,
    });
    await request(unconfigured)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "hi" })
      .expect(503);
  });

  it("rejects send without authentication and maps service failures", async () => {
    const app = express();
    app.use(express.json());
    const sendToThread = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: { scopeForSession: vi.fn() } as never,
      sendToThread,
      requireAuth: (_req, res) => { res.status(401).json({ error: "auth required" }); },
    });
    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/send")
      .send({ message: "hi" })
      .expect(401);
    expect(sendToThread).not.toHaveBeenCalled();

    const failing = express();
    failing.use(express.json());
    registerHarnessThreadRoutes(failing, {
      registry: {} as never,
      runtime: { scopeForSession: vi.fn(async () => ({ scopeId: "workspace-1", parent: { kind: "session", id: "session-1" } })) } as never,
      sendToThread: vi.fn(async () => { throw new ThreadRuntimeError("not-found", "Thread not found: thread-9"); }),
    });
    await request(failing)
      .post("/api/harness/sessions/session-1/threads/thread-9/send")
      .send({ message: "hi" })
      .expect(404, { code: "not-found", error: "Thread not found: thread-9" });
  });
});
