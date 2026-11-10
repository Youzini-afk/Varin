import type { Express, RequestHandler } from "express";
import { type HarnessWebSearchProvider } from "@varin/protocol";
import type { ServiceCredentialStore } from "../service-credentials/store.js";
import { resolveSearchCredential } from "./web-search.js";
import { createSearchConnectionAccess, type SearchConnectionSettings } from './search-connection-settings.js';
import { ModelConfigurationError } from '../models/configuration.js';

const PROVIDERS = new Set<HarnessWebSearchProvider>(["brave", "exa", "tavily", "jina", "searxng", "anysearch"]);
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
  connections?: SearchConnectionSettings;
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

  const access = options.connections ?? createSearchConnectionAccess({ ...options, readSearchSettings: options.readSearchSettings ?? (() => undefined) });
  app.get("/api/harness/web-search/connections/:connectionId", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const connection = await access.inspect(String(request.params.connectionId));
      response.json({ ...connection, checkedAt: Date.now() });
    } catch (error) { response.status(error instanceof ModelConfigurationError ? error.status : 500).json({ error: "Unable to inspect search connection" }); }
  });
  app.get("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await access.credential(String(request.params.connectionId)));
    } catch (error) { response.status(error instanceof ModelConfigurationError ? error.status : 500).json({ error: "Unable to read search connection credential status" }); }
  });
  app.put("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
      response.json(await access.saveCredential(String(request.params.connectionId), apiKey));
    } catch (error) { response.status(error instanceof ModelConfigurationError ? error.status === 404 ? 400 : error.status : 500).json({ error: "Unable to save search connection credential" }); }
  });
  app.delete("/api/harness/web-search/connections/:connectionId/credential", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await access.removeCredential(String(request.params.connectionId)));
    } catch (error) { response.status(error instanceof ModelConfigurationError ? error.status : 500).json({ error: "Unable to remove search connection credential" }); }
  });
  app.post("/api/harness/web-search/connections/:connectionId/test", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!options.searchFetch && !options.connections) { response.status(503).json({ error: "Search test egress is unavailable" }); return; }
    const abort = new AbortController();
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    response.once("close", disconnected);
    try {
      response.json(await access.test(String(request.params.connectionId), AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])));
    } catch (error) { if (!response.destroyed) response.status(error instanceof ModelConfigurationError ? error.status : 500).json({ error: "Unable to test search connection" }); }
    finally { response.off("close", disconnected); }
  });

  // Secrets arrive only from this authenticated user interface, never through settings_action.
  const requests = '/api/harness/web-search/credential-requests/:requestId';
  app.get(requests, requireAuth, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (!options.connections) { response.status(503).json({ error: 'Credential entry is unavailable.' }); return; }
      response.json(options.connections.credentialRequest(String(request.params.requestId)));
    } catch { response.status(404).json({ error: 'Credential entry is no longer available.' }); }
  });
  app.post(requests, requireAuth, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (!options.connections) { response.status(503).json({ error: 'Credential entry is unavailable.' }); return; }
      const key = typeof request.body?.apiKey === 'string' ? request.body.apiKey : '';
      response.json(await options.connections.submitCredential(String(request.params.requestId), key));
    } catch { response.status(400).json({ error: 'Credential entry failed. Check the connection and start a new entry request.' }); }
  });
  app.delete(requests, requireAuth, (request, response) => {
    try {
      if (!options.connections) { response.status(503).json({ error: 'Credential entry is unavailable.' }); return; }
      response.json(options.connections.cancelCredential(String(request.params.requestId)));
    } catch { response.status(404).json({ error: 'Credential entry is no longer available.' }); }
  });

};
