import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerWebSearchCredentialRoutes } from "./web-search-routes.js";

describe("web search credential routes", () => {
  it("stores a key under a fixed search-only ref and never returns it", async () => {
    const app = express();
    app.use(express.json());
    const saveAuth = vi.fn(async () => undefined);
    registerWebSearchCredentialRoutes(app, {
      readAuth: () => ({}),
      saveAuth,
      removeAuth: vi.fn(async () => false),
    });
    const response = await request(app)
      .put("/api/harness/web-search/credentials/brave")
      .send({ apiKey: "brave-secret", credentialRef: "openai" })
      .expect(200);
    expect(saveAuth).toHaveBeenCalledWith("varin-web-search-brave", { type: "api_key", key: "brave-secret" });
    expect(response.body).toEqual({
      provider: "brave",
      credentialRef: "varin-web-search-brave",
      configured: true,
    });
    expect(JSON.stringify(response.body)).not.toContain("brave-secret");
  });

  it("reports status, removes only the fixed ref, and authenticates before access", async () => {
    const app = express();
    app.use(express.json());
    const removeAuth = vi.fn(async () => true);
    registerWebSearchCredentialRoutes(app, {
      readAuth: () => ({ "varin-web-search-exa": { key: "secret" } }),
      removeAuth,
      saveAuth: vi.fn(async () => undefined),
    });
    await request(app)
      .get("/api/harness/web-search/credentials/exa")
      .expect(200, { provider: "exa", credentialRef: "varin-web-search-exa", configured: true });
    await request(app).delete("/api/harness/web-search/credentials/exa").expect(200);
    expect(removeAuth).toHaveBeenCalledWith("varin-web-search-exa");

    const protectedApp = express();
    const readAuth = vi.fn();
    registerWebSearchCredentialRoutes(protectedApp, {
      readAuth,
      saveAuth: vi.fn(async () => undefined),
      removeAuth: vi.fn(async () => false),
      requireAuth: (_request, response) => { response.status(401).json({ error: "auth required" }); },
    });
    await request(protectedApp).get("/api/harness/web-search/credentials/exa").expect(401);
    expect(readAuth).not.toHaveBeenCalled();
  });

  it("rejects unknown providers and empty credentials", async () => {
    const app = express();
    app.use(express.json());
    registerWebSearchCredentialRoutes(app, {
      readAuth: () => ({}), saveAuth: vi.fn(async () => undefined), removeAuth: vi.fn(async () => false),
    });
    await request(app).get("/api/harness/web-search/credentials/unknown").expect(400);
    await request(app).put("/api/harness/web-search/credentials/brave").send({ apiKey: " " }).expect(400);
  });
});

describe("saved search connection tests", () => {
  const searchSettings = {
    connections: [
      { id: "research", name: "Research", provider: "exa", credentialRef: "research-key", enabled: true },
      { id: "backup", name: "Backup", provider: "tavily", credentialRef: "backup-key", enabled: true },
    ], defaultConnectionId: "research", fallbackConnectionIds: ["backup"],
  };
  it("tests the saved endpoint and exact connection, classifies auth failure and never echoes credentials", async () => {
    const app = express(); app.use(express.json());
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => new Response("leaked-secret", { status: 401 }));
    registerWebSearchCredentialRoutes(app, {
      readAuth: () => ({ "research-key": { key: "leaked-secret" }, "backup-key": { key: "backup-secret" } }),
      saveAuth: vi.fn(), removeAuth: vi.fn(), readSearchSettings: () => searchSettings, searchFetch: fetch,
    });
    const result = await request(app).post("/api/harness/web-search/connections/research/test")
      .send({ endpoint: "https://attacker.example", credentialRef: "backup-key" }).expect(200);
    expect(result.body).toMatchObject({ connectionId: "research", action: "search", status: "failed", resultCount: 0,
      failure: { kind: "authentication", httpStatus: 401 } });
    expect(result.body.checkedAt).toBeTypeOf("number");
    expect(JSON.stringify(result.body)).not.toContain("leaked-secret");
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.exa.ai/search");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps same-provider credentials isolated by connection and refuses unsaved targets", async () => {
    const app = express(); app.use(express.json());
    const saveAuth = vi.fn(async () => undefined);
    registerWebSearchCredentialRoutes(app, { readAuth: () => ({}), saveAuth, removeAuth: vi.fn(),
      readSearchSettings: () => ({ ...searchSettings, connections: searchSettings.connections.map(connection => ({ ...connection, provider: "exa" })) }) });
    await request(app).put("/api/harness/web-search/connections/research/credential").send({ apiKey: "first", credentialRef: "arbitrary" }).expect(200);
    await request(app).put("/api/harness/web-search/connections/backup/credential").send({ apiKey: "second" }).expect(200);
    expect(saveAuth.mock.calls).toEqual([["research-key", { type: "api_key", key: "first" }], ["backup-key", { type: "api_key", key: "second" }]]);
    await request(app).put("/api/harness/web-search/connections/unknown/credential").send({ apiKey: "third" }).expect(400);
    expect(saveAuth).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a real zero-hit test from a configuration-only check", async () => {
    const app = express(); app.use(express.json());
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { headers: { "Content-Type": "application/json" } }));
    registerWebSearchCredentialRoutes(app, { readAuth: () => ({ "research-key": { key: "key" } }), saveAuth: vi.fn(), removeAuth: vi.fn(),
      readSearchSettings: () => searchSettings, searchFetch: fetch });
    const result = await request(app).post("/api/harness/web-search/connections/research/test").expect(200);
    expect(result.body).toMatchObject({ action: "search", status: "empty", resultCount: 0, query: "Varin documentation" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
