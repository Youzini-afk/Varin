import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { registerHarnessContextRoutes } from "./context-routes.js";

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

  it("uses the session's effective auto-accept policy for explicit suggestions", async () => {
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async () => store,
      getBranchEntryIds: async () => [],
      getSuggestionSettings: async () => ({
        autoAcceptSuggestions: { workspace: true, user: false, session: false },
      }),
    });

    await request(app)
      .post("/api/harness/sessions/session-1/knowledge/suggestions")
      .send({ scope: "workspace", content: "Keep this policy" })
      .expect(201)
      .expect(({ body }) => expect(body.suggestion.status).toBe("accepted"));
    await expect(store.listKnowledge({ scope: "workspace", status: "accepted" }))
      .resolves.toEqual([expect.objectContaining({ content: "Keep this policy" })]);
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
    const base = "/api/harness/sessions/session-1/knowledge/suggestions";
    await request(app).get(base).expect(401);
    await request(app).get("/api/harness/sessions/missing/knowledge/suggestions").set("x-test-auth", "yes").expect(404);
    await request(app)
      .post("/api/harness/sessions/missing/knowledge/suggestions")
      .set("x-test-auth", "yes")
      .send({ scope: "user", content: "forged source" })
      .expect(404);
    expect(await userStore.listKnowledge({ status: "suggested" })).toEqual([]);
    const workspaceCreate = await request(app)
      .post(base)
      .set("x-test-auth", "yes")
      .send({ scope: "workspace", content: "Use bun", trigger: "package management", kind: "block" })
      .expect(201);
    const userCreate = await request(app)
      .post(base)
      .set("x-test-auth", "yes")
      .send({ scope: "user", content: "Prefer concise replies", trigger: "response style", kind: "block" })
      .expect(201);
    const workspaceId = workspaceCreate.body.suggestion.id as number;
    const userId = userCreate.body.suggestion.id as number;

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
    expect(changed).toEqual(["session-1", "session-1", "session-1", "session-1", "session-1"]);
  });
});
