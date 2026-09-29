import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { registerHarnessContextRoutes } from "./context-routes.js";
import { createMemoryService } from "../memory/memory-service.js";

const TEST_DIR = join(tmpdir(), "varin-harness-context-routes");

describe("harness context routes", () => {
  let store: KnowledgeStore;
  let userStore: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "workspace-1",
      embedding: null,
    });
    userStore = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "user",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    await userStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("requires UI auth and supports conflict-checked session block editing", async () => {
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async (sessionId) => sessionId === "session-1" ? store : null,
      getBranchEntryIds: async () => [],
      requireAuth: (req, res, next) => {
        if (req.header("x-test-auth") === "yes") next();
        else res.status(401).json({ error: "auth required" });
      },
    });

    await request(app).get("/api/harness/sessions/session-1/blocks").expect(401);
    let openedRevision = 0;
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .set("x-test-auth", "yes")
      .send({ content: "User corrected the current state", expectedUpdatedAt: null, expectedBranchLeafId: null })
      .expect(200)
      .expect(({ body }) => {
        expect(body.block).toMatchObject({ label: "progress", updatedBy: "user" });
        openedRevision = body.block.updatedAt;
      });
    await request(app)
      .get("/api/harness/sessions/session-1/blocks")
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => expect(body.blocks).toMatchObject([{ content: "User corrected the current state" }]));
    await store.upsertBlock({
      sessionId: "session-1",
      label: "progress",
      content: "Background update",
      updatedBy: "agent",
    });
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .set("x-test-auth", "yes")
      .send({ content: "Stale editor draft", expectedUpdatedAt: openedRevision, expectedBranchLeafId: null })
      .expect(409)
      .expect(({ body }) => expect(body.current).toMatchObject({ content: "Background update" }));
    await expect(store.getBlocks("session-1")).resolves.toMatchObject([{ content: "Background update" }]);
  });

  it("derives the active branch server-side for reads and user block edits", async () => {
    let branchEntryIds = ["root", "leaf-a"];
    const ancestor = await store.upsertBlock({
      sessionId: "session-1",
      label: "progress",
      content: "ancestor",
      updatedBy: "agent",
      sourceLeafId: "leaf-a",
    });
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async () => store,
      getBranchEntryIds: async () => branchEntryIds,
    });

    await request(app)
      .get("/api/harness/sessions/session-1/blocks")
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        branchLeafId: "leaf-a",
        blocks: [{ content: "ancestor" }],
      }));

    branchEntryIds = ["root", "leaf-a", "leaf-a1"];
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .send({ content: "descendant edit", expectedUpdatedAt: ancestor.updatedAt, expectedBranchLeafId: "leaf-a1" })
      .expect(200);

    await expect(store.getBlocks("session-1", branchEntryIds))
      .resolves.toMatchObject([{ content: "descendant edit", sourceLeafId: "leaf-a1" }]);
    await expect(store.getBlocks("session-1", ["root", "leaf-a", "leaf-a2"]))
      .resolves.toMatchObject([{ content: "ancestor", sourceLeafId: "leaf-a" }]);

    branchEntryIds = ["root", "leaf-b"];
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .send({ content: "stale branch draft", expectedUpdatedAt: ancestor.updatedAt, expectedBranchLeafId: "leaf-a1" })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe("branch-conflict"));
  });

  it("commits an explicit user remember immediately through the unified memory service", async () => {
    const memoryService = createMemoryService({
      storeForScopeId: async (scopeId) => scopeId === "workspace-1" ? store : null,
      userStore: async () => userStore,
      ownerForSession: async (sessionId) => sessionId === "session-1"
        ? { scope: "workspace", ownerId: "workspace-1" }
        : { scope: "session", ownerId: sessionId },
    });
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async () => store,
      getBranchEntryIds: async () => [],
      memoryService,
      memoryOwnerForSession: (sessionId) => memoryService.ownerForSession(sessionId),
    });

    // Direct remember persists as accepted — the auto-accept review policy no
    // longer gates an explicit user mark.
    await request(app)
      .post("/api/harness/sessions/session-1/knowledge/remember")
      .send({ content: "Keep this policy", nature: "decision", kind: "message:user" })
      .expect(201)
      .expect(({ body }) => {
        expect(body.created).toBe(true);
        expect(body.item.status).toBe("accepted");
        expect(body.item.nature).toBe("decision");
        expect(body.item.source).toMatchObject({ kind: "message:user", sessionId: "session-1" });
      });
    await expect(store.listKnowledge({ scope: "workspace", status: "accepted" }))
      .resolves.toEqual([expect.objectContaining({ content: "Keep this policy" })]);

    // `scope: "user"` writes the user store.
    await request(app)
      .post("/api/harness/sessions/session-1/knowledge/remember")
      .send({ scope: "user", content: "Prefer concise replies" })
      .expect(201);
    await expect(userStore.listKnowledge({ scope: "user", status: "accepted" }))
      .resolves.toEqual([expect.objectContaining({ content: "Prefer concise replies" })]);
  });

  it("reviews workspace and user suggestions through authenticated scoped actions", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use npm",
      trigger: "package management",
    });
    const changed: string[] = [];
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async (sessionId) => sessionId === "session-1" ? store : null,
      getBranchEntryIds: async () => [],
      getUserStore: async () => userStore,
      onKnowledgeChanged: (sessionId) => { changed.push(sessionId); },
      requireAuth: (req, res, next) => {
        if (req.header("x-test-auth") === "yes") next();
        else res.status(401).json({ error: "auth required" });
      },
    });
    // Inferred suggestions arrive through the agent's knowledge.suggest bridge
    // method; the route test seeds them directly at the store layer.
    const workspaceId = await store.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "Use bun",
      trigger: "package management",
      source: { sessionId: "session-1", kind: "block" },
    });
    const userId = await userStore.putKnowledge({
      scope: "user",
      status: "suggested",
      content: "Prefer concise replies",
      trigger: "response style",
      source: { sessionId: "session-1", kind: "block" },
    });
    const base = "/api/harness/sessions/session-1/knowledge/suggestions";
    await request(app).get(base).expect(401);
    await request(app).get("/api/harness/sessions/missing/knowledge/suggestions").set("x-test-auth", "yes").expect(404);

    await request(app)
      .get(base)
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.suggestions).toHaveLength(2);
        expect(body.suggestions.find((item: { id: number; scope: string }) => item.id === workspaceId && item.scope === "workspace")?.supersedesCandidates)
          .toEqual([expect.objectContaining({ id: oldId })]);
      });
    await request(app)
      .put(`${base}/workspace/${workspaceId}`)
      .set("x-test-auth", "yes")
      .send({
        content: "Use Bun for package management",
        trigger: "package management",
        expectedContent: "Use bun",
        expectedTrigger: "package management",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(200);
    await request(app)
      .put(`${base}/workspace/${workspaceId}`)
      .set("x-test-auth", "yes")
      .send({
        content: "Stale overwrite",
        trigger: "package management",
        expectedContent: "Use bun",
        expectedTrigger: "package management",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(409);
    await request(app)
      .post(`${base}/workspace/${workspaceId}/accept`)
      .set("x-test-auth", "yes")
      .send({
        supersedes: [oldId],
        content: "Always use Bun for package management",
        trigger: "package management",
        expectedContent: "Use Bun for package management",
        expectedTrigger: "package management",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(200);
    await userStore.updateSuggestedKnowledge(
      userId,
      { content: "Prefer very concise replies", trigger: "response style" },
      "user",
      { content: "Prefer concise replies", trigger: "response style", status: "suggested", invalidAt: null },
    );
    await request(app)
      .post(`${base}/user/${userId}/dismiss`)
      .set("x-test-auth", "yes")
      .send({
        expectedContent: "Prefer concise replies",
        expectedTrigger: "response style",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(409);
    await request(app)
      .post(`${base}/user/${userId}/dismiss`)
      .set("x-test-auth", "yes")
      .send({
        expectedContent: "Prefer very concise replies",
        expectedTrigger: "response style",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(200);

    expect(await store.listKnowledge({ scope: "workspace", status: "accepted", activeOnly: true }))
      .toEqual([expect.objectContaining({ id: workspaceId, content: "Always use Bun for package management" })]);
    expect(await userStore.listKnowledge({ scope: "user", status: "dismissed" }))
      .toEqual([expect.objectContaining({ id: userId })]);
    expect(changed).toEqual(["session-1", "session-1", "session-1"]);
  });
});
