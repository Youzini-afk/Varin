import type { Express, RequestHandler } from "express";
import { parseHarnessWebSearchSettings, type HarnessWebSearchProvider } from "@varin/protocol";
import type { ServiceCredentialStore } from "../service-credentials/store.js";
import { createWebSearchService, resolveConfiguredSearchProvider, resolveSearchCredential } from "./web-search.js";

const PROVIDERS = new Set<HarnessWebSearchProvider>(["brave", "exa", "tavily", "jina", "searxng"]);
const noAuth: RequestHandler = (_request, _response, next) => next();

export const webSearchCredentialRef = (provider: HarnessWebSearchProvider): string => `varin-web-search-${provider}`;

const providerOf = (value: unknown): HarnessWebSearchProvider | null => (
  typeof value === "string" && PROVIDERS.has(value as HarnessWebSearchProvider)
    ? value as HarnessWebSearchProvider
    : null
);

export interface WebSearchCredentialRoutesOptions {
  readAuth: ServiceCredentialStore['read'];
  removeAuth: ServiceCredentialStore['remove'];
  requireAuth?: RequestHandler;
  saveAuth: ServiceCredentialStore['save'];
  /** Persisted user-owned settings only: the caller cannot redirect credentials. */
  readSearchSettings?: () => unknown | Promise<unknown>;
  /** The Host's policy-aware egress fetch, never an unguarded route fallback. */
  searchFetch?: typeof globalThis.fetch;
}

export const registerWebSearchCredentialRoutes = (
  app: Express,
  options: WebSearchCredentialRoutesOptions,
): void => {
  const requireAuth = options.requireAuth ?? noAuth;
  const readAuth = options.readAuth;
  const saveAuth = options.saveAuth;
  const removeAuth = options.removeAuth;

  app.get("/api/harness/web-search/credentials/:provider", requireAuth, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const provider = providerOf(request.params.provider);
    if (!provider) {
      response.status(400).json({ error: "Unknown web search provider" });
      return;
    }
    const credentialRef = webSearchCredentialRef(provider);
    try {
      response.json({
        provider,
        credentialRef,
        configured: resolveSearchCredential(readAuth(), credentialRef) !== null,
      });
    } catch {
      response.status(500).json({ error: "Unable to read web search credential status" });
    }
  });

  app.put("/api/harness/web-search/credentials/:provider", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const provider = providerOf(request.params.provider);
    const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
    if (!provider || !apiKey) {
      response.status(400).json({ error: "A known provider and non-empty API key are required" });
      return;
    }
    const credentialRef = webSearchCredentialRef(provider);
    try {
      await saveAuth(credentialRef, { type: "api_key", key: apiKey });
      response.json({ provider, credentialRef, configured: true });
    } catch {
      response.status(500).json({ error: "Unable to save web search credential" });
    }
  });

  app.delete("/api/harness/web-search/credentials/:provider", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const provider = providerOf(request.params.provider);
    if (!provider) {
      response.status(400).json({ error: "Unknown web search provider" });
      return;
    }
    const credentialRef = webSearchCredentialRef(provider);
    try {
      const removed = await removeAuth(credentialRef);
      response.json({ provider, credentialRef, configured: false, removed });
    } catch {
      response.status(500).json({ error: "Unable to remove web search credential" });
    }
  });

  const connectionOf = async (id: unknown) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) return null;
    const settings = parseHarnessWebSearchSettings(await options.readSearchSettings?.());
    return settings?.connections.find(connection => connection.id === id) ?? null;
  };
  app.get("/api/harness/web-search/connections/:connectionId", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const resolved = resolveConfiguredSearchProvider({ settings: await options.readSearchSettings?.(), auth: readAuth() });
      const connection = "unavailable" in resolved ? undefined : resolved.connections?.find(item => item.id === request.params.connectionId);
      if (!connection) { response.status(404).json({ error: "Search connection not found" }); return; }
      response.json({ ...connection, checkedAt: Date.now() });
    } catch { response.status(500).json({ error: "Unable to inspect search connection" }); }
  });
  app.get("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const connection = await connectionOf(request.params.connectionId);
      if (!connection) { response.status(404).json({ error: "Search connection not found" }); return; }
      response.json({ connectionId: connection.id, credentialRef: connection.credentialRef,
        configured: resolveSearchCredential(readAuth(), connection.credentialRef) !== null });
    } catch { response.status(500).json({ error: "Unable to read search connection credential status" }); }
  });
  app.put("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const connection = await connectionOf(request.params.connectionId);
      const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
      if (!connection?.credentialRef || !apiKey) { response.status(400).json({ error: "A saved connection credential reference and non-empty API key are required" }); return; }
      await saveAuth(connection.credentialRef, { type: "api_key", key: apiKey });
      response.json({ connectionId: connection.id, credentialRef: connection.credentialRef, configured: true });
    } catch { response.status(500).json({ error: "Unable to save search connection credential" }); }
  });
  app.delete("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const connection = await connectionOf(request.params.connectionId);
      if (!connection?.credentialRef) { response.status(404).json({ error: "Search connection credential not found" }); return; }
      const removed = await removeAuth(connection.credentialRef);
      response.json({ connectionId: connection.id, configured: false, removed });
    } catch { response.status(500).json({ error: "Unable to remove search connection credential" }); }
  });
  app.post("/api/harness/web-search/connections/:connectionId/test", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!options.searchFetch) { response.status(503).json({ error: "Search test egress is unavailable" }); return; }
    const abort = new AbortController();
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    response.once("close", disconnected);
    const service = createWebSearchService(async () => resolveConfiguredSearchProvider({
      settings: await options.readSearchSettings?.(), auth: readAuth(), fetch: options.searchFetch!,
    }), undefined, { cacheTtlMs: 0 });
    try {
      const connection = await connectionOf(request.params.connectionId);
      if (!connection) { response.status(404).json({ error: "Search connection not found" }); return; }
      const startedAt = Date.now();
      const result = await service.handle({ query: "Varin documentation", connectionId: connection.id, limit: 1, refresh: true },
        { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
      const item = result.items[0]!;
      response.json({ connectionId: connection.id, action: "search", query: "Varin documentation", checkedAt: Date.now(), durationMs: Date.now() - startedAt,
        status: item.status, resultCount: item.results?.length ?? 0, providerId: item.providerId,
        ...(item.failure ? { failure: item.failure } : {}), capabilities: result.capabilities });
    } catch { if (!response.destroyed) response.status(500).json({ error: "Unable to test search connection" }); }
    finally { response.off("close", disconnected); await service.dispose(); }
  });

};
