import type { Express, RequestHandler } from "express";
import type { HarnessWebSearchProvider } from "@varin/protocol";
import { readPiAuthFile, removePiProviderAuth, savePiProviderAuth } from "../pi-config/storage.js";
import { resolveSearchCredential } from "./web-search.js";

const PROVIDERS = new Set<HarnessWebSearchProvider>(["brave", "exa", "tavily", "jina", "searxng"]);
const noAuth: RequestHandler = (_request, _response, next) => next();

export const webSearchCredentialRef = (provider: HarnessWebSearchProvider): string => `varin-web-search-${provider}`;

const providerOf = (value: unknown): HarnessWebSearchProvider | null => (
  typeof value === "string" && PROVIDERS.has(value as HarnessWebSearchProvider)
    ? value as HarnessWebSearchProvider
    : null
);

export interface WebSearchCredentialRoutesOptions {
  readAuth?: typeof readPiAuthFile;
  removeAuth?: (...args: Parameters<typeof removePiProviderAuth>) => boolean | Promise<boolean>;
  requireAuth?: RequestHandler;
  saveAuth?: (...args: Parameters<typeof savePiProviderAuth>) => unknown | Promise<unknown>;
}

export const registerWebSearchCredentialRoutes = (
  app: Express,
  options: WebSearchCredentialRoutesOptions = {},
): void => {
  const requireAuth = options.requireAuth ?? noAuth;
  const readAuth = options.readAuth ?? readPiAuthFile;
  const saveAuth = options.saveAuth ?? savePiProviderAuth;
  const removeAuth = options.removeAuth ?? removePiProviderAuth;

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
};
