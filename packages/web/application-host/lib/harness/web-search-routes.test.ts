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
