import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { registerHarnessKnowledgeCatalogRoutes } from "./knowledge-catalog-routes.js";

const TEST_DIR = join(tmpdir(), "varin-harness-knowledge-catalog");

describe("harness knowledge catalog routes", () => {
  let store: KnowledgeStore;
  let userStore: KnowledgeStore;
  let botStore: KnowledgeStore;

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
    botStore = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "bot-1",
      scope: "bot",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    await userStore.close();
    await botStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const appFor = () => {
    const changed: Array<{ scope: string; workspaceId?: string }> = [];
    const app = express();
    app.use(express.json());
    registerHarnessKnowledgeCatalogRoutes(app, {
      resolveWorkspace: async ({ workspaceId }) => {
        if (workspaceId !== "workspace-1") {
          const error = new Error("Workspace is not registered on this application host");
          (error as { statusCode?: number }).statusCode = 404;
          throw error;
        }
        return { workspaceId };
      },
      getWorkspaceStore: async (workspaceId) => {
        if (workspaceId === "workspace-1") return store;
        if (workspaceId === "bot:bot-1") return botStore;
        throw new Error("unexpected store open");
      },
      getUserStore: async () => userStore,
      onKnowledgeChanged: (change) => { changed.push(change); },
      requireAuth: (req, res, next) => {
        if (req.header("x-test-auth") === "yes") next();
        else res.status(401).json({ error: "auth required" });
      },
    });
    return { app, changed };
  };

  it("requires auth and a registered Documents workspace before opening a store", async () => {
    const { app } = appFor();
    await request(app).get("/api/harness/knowledge?scope=workspace&workspaceId=workspace-1").expect(401);
    await request(app)
      .get("/api/harness/knowledge?scope=workspace&workspaceId=forged")
      .set("x-test-auth", "yes")
      .expect(404);
    await request(app)
      .get("/api/harness/knowledge?scope=workspace")
      .set("x-test-auth", "yes")
      .expect(400);
  });

  it("lists, edits, retires, and walks a supersede chain without crossing scopes", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use npm",
      trigger: "packages",
    });
    const userId = await userStore.putKnowledge({
      scope: "user",
      status: "accepted",
      content: "Use npm",
      trigger: "packages",
    });
    const { app, changed } = appFor();
    const created = await request(app)
      .post("/api/harness/knowledge/workspace/0/accept")
      .set("x-test-auth", "yes")
      .send({ workspaceId: "workspace-1" })
      .expect(400);
    expect(created.body.error).toMatch(/valid scope/);

    await request(app)
      .get("/api/harness/knowledge?scope=user")
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual([expect.objectContaining({ id: userId, scope: "user" })]);
      });

    const suggestion = await store.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "Use bun",
      trigger: "packages",
    });
    await request(app)
      .post(`/api/harness/knowledge/workspace/${suggestion}/accept`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        supersedes: [oldId],
        expectedContent: "Use bun",
        expectedTrigger: "packages",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(200);

    await request(app)
      .put(`/api/harness/knowledge/workspace/${suggestion}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        content: "Always use bun",
        trigger: "packages",
        expectedContent: "Use bun",
        expectedTrigger: "packages",
        expectedStatus: "accepted",
        expectedInvalidAt: null,
      })
      .expect(200);

    await request(app)
      .put(`/api/harness/knowledge/workspace/${suggestion}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        content: "stale",
        trigger: "packages",
        expectedContent: "Use bun",
        expectedTrigger: "packages",
        expectedStatus: "accepted",
        expectedInvalidAt: null,
      })
      .expect(409);

    await request(app)
      .get(`/api/harness/knowledge/workspace/${oldId}/chain?workspaceId=workspace-1`)
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.chain.chain.map((item: { id: number }) => item.id)).toEqual([oldId, suggestion]);
      });

    await request(app)
      .delete(`/api/harness/knowledge/user/${userId}`)
      .set("x-test-auth", "yes")
      .send({
        expectedContent: "Use npm",
        expectedTrigger: "packages",
        expectedStatus: "accepted",
        expectedInvalidAt: null,
      })
      .expect(200);

    expect((await userStore.getKnowledge(userId))?.invalidAt).toEqual(expect.any(Number));
    expect((await store.getKnowledge(oldId))?.invalidAt).toEqual(expect.any(Number));
    const current = await store.getKnowledge(suggestion);
    expect(current?.content).toBe("Always use bun");
    expect(current?.invalidAt).toBeUndefined();
    expect(await userStore.recall("Use npm", 5)).toEqual([]);
    expect(changed.map((item) => item.scope)).toEqual(["workspace", "workspace", "user"]);
  });

  it("checks the complete opened revision for Settings review actions", async () => {
    const suggestion = await store.putKnowledge({
      scope: "workspace", status: "suggested", content: "v1", trigger: "rule",
    });
    const { app } = appFor();
    const opened = {
      workspaceId: "workspace-1",
      expectedContent: "v1",
      expectedTrigger: "rule",
      expectedStatus: "suggested",
      expectedInvalidAt: null,
    };
    await request(app)
      .put(`/api/harness/knowledge/workspace/${suggestion}`)
      .set("x-test-auth", "yes")
      .send({ ...opened, content: "v2", trigger: "rule" })
      .expect(200);
    await request(app)
      .post(`/api/harness/knowledge/workspace/${suggestion}/accept`)
      .set("x-test-auth", "yes")
      .send({ ...opened, supersedes: [] })
      .expect(409);

    const retired = await store.putKnowledge({
      scope: "workspace", status: "suggested", content: "retire me", trigger: "rule",
    });
    await request(app)
      .delete(`/api/harness/knowledge/workspace/${retired}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        expectedContent: "retire me",
        expectedTrigger: "rule",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(200);
    await request(app)
      .put(`/api/harness/knowledge/workspace/${retired}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        content: "rewritten history",
        trigger: "rule",
        expectedContent: "retire me",
        expectedTrigger: "rule",
        expectedStatus: "suggested",
        expectedInvalidAt: null,
      })
      .expect(409);
    await request(app)
      .post(`/api/harness/knowledge/workspace/${retired}/dismiss`)
      .set("x-test-auth", "yes")
      .send({ ...opened, expectedContent: "retire me" })
      .expect(409);
  });

  it("resolves bot scope through the bot id to the Bot's own store", async () => {
    const botId = await botStore.putKnowledge({
      scope: "bot", status: "accepted", content: "Prefers terse reports", trigger: "status",
      nature: "preference",
    });
    const workspaceOnly = await store.putKnowledge({
      scope: "workspace", status: "accepted", content: "Workspace-only memory", trigger: "status",
    });
    const { app } = appFor();

    // `botId` selects the Bot store; `workspaceId=bot:<id>` is also accepted.
    await request(app)
      .get("/api/harness/knowledge?scope=bot")
      .set("x-test-auth", "yes")
      .expect(400);
    const listed = await request(app)
      .get("/api/harness/knowledge?scope=bot&botId=bot-1")
      .set("x-test-auth", "yes")
      .expect(200);
    expect(listed.body.items.map((item: { id: number }) => item.id)).toEqual([botId]);
    expect(listed.body.items[0].nature).toBe("preference");
    await request(app)
      .get("/api/harness/knowledge?scope=bot&workspaceId=bot:bot-1")
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => expect(body.items).toHaveLength(1));

    // Bot edits and retires land in the Bot store only.
    await request(app)
      .put(`/api/harness/knowledge/bot/${botId}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "bot:bot-1",
        content: "Prefers verbose reports",
        trigger: "status",
        expectedContent: "Prefers terse reports",
        expectedTrigger: "status",
        expectedStatus: "accepted",
        expectedInvalidAt: null,
      })
      .expect(200);
    expect((await botStore.getKnowledge(botId))?.content).toBe("Prefers verbose reports");
    expect((await store.getKnowledge(workspaceOnly))?.content).toBe("Workspace-only memory");
    await request(app)
      .delete(`/api/harness/knowledge/bot/${botId}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "bot:bot-1",
        expectedContent: "Prefers verbose reports",
        expectedTrigger: "status",
        expectedStatus: "accepted",
        expectedInvalidAt: null,
      })
      .expect(200);
    expect(await botStore.recall("verbose reports", 5)).toEqual([]);
  });
});
