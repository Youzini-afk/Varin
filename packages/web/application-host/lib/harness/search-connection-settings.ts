import { randomUUID } from 'node:crypto';
import type { SearchCredentialRequest } from '@varin/application-client';
import { parseHarnessWebSearchSettings, type HarnessWebSearchConfiguration, type HarnessWebSearchConnection, type HarnessWebSearchProvider, type JsonValue } from '@varin/protocol';
import type { AgentSettingsService } from '../models/settings.js';
import { ModelConfigurationError, object } from '../models/configuration.js';
import type { ServiceCredentialStore } from '../service-credentials/store.js';
import type { ClientSurfaceBridge, SettingsServiceCaller } from './settings-service.js';
import { createWebSearchService, resolveConfiguredSearchProvider, resolveSearchCredential } from './web-search.js';

const invalid = (message: string): never => { throw new ModelConfigurationError('invalid_search_connection', message); };
const webOf = (harness: Record<string, unknown>) => object(harness.web) ? harness.web : {};
const configuration = (raw: unknown): HarnessWebSearchConfiguration | undefined => {
  if (raw === undefined) return undefined;
  return parseHarnessWebSearchSettings(raw) ?? invalid('Search configuration is invalid. Restore the keyless default or repair the saved configuration.');
};
const missing = (): never => { throw new ModelConfigurationError('search_connection_missing', 'Search connection is unavailable. Read the connection list again.', 404); };
const selected = (config: HarnessWebSearchConfiguration | undefined, id: string) => config?.connections.find(connection => connection.id === id) ?? missing();
const routing = (connection: HarnessWebSearchConnection) => JSON.stringify([connection.provider, connection.endpoint ?? '', connection.credentialRef ?? '']);

export interface SearchConnectionAccess {
  readSearchSettings(): Promise<unknown> | unknown;
  readAuth: ServiceCredentialStore['read'];
  saveAuth: ServiceCredentialStore['save'];
  removeAuth: ServiceCredentialStore['remove'];
  searchFetch?: typeof globalThis.fetch;
  credentialChanged?(connectionId: string): void;
}

/** Shared by the settings UI and Agent actions; secrets stay in the original Host store. */
export function createSearchConnectionAccess(options: SearchConnectionAccess) {
  const read = async (id: string) => selected(configuration(await options.readSearchSettings()), id);
  return {
    read,
    async inspect(id: string) {
      const resolved = resolveConfiguredSearchProvider({ settings: await options.readSearchSettings(), auth: options.readAuth() });
      return !('unavailable' in resolved) && resolved.connections?.find(connection => connection.id === id)
        || missing();
    },
    async credential(id: string) {
      const connection = await read(id);
      return { connectionId: id, credentialRef: connection.credentialRef, configured: resolveSearchCredential(options.readAuth(), connection.credentialRef) !== null };
    },
    async saveCredential(id: string, apiKey: string) {
      const connection = await read(id);
      if (!connection.credentialRef || !apiKey.trim()) return invalid('A saved credential reference and a non-empty API key are required.');
      await options.saveAuth(connection.credentialRef, { type: 'api_key', key: apiKey.trim() });
      options.credentialChanged?.(id);
      return { connectionId: id, configured: true };
    },
    async removeCredential(id: string) {
      const connection = await read(id);
      if (!connection.credentialRef) return { connectionId: id, configured: false, removed: false };
      const removed = await options.removeAuth(connection.credentialRef);
      options.credentialChanged?.(id);
      return { connectionId: id, configured: false, removed };
    },
    async test(id: string, signal?: AbortSignal) {
      if (!options.searchFetch) return invalid('Search test egress is unavailable.');
      // Capture the exact saved route once; a simultaneous edit cannot redirect this test.
      const settings = await options.readSearchSettings();
      selected(configuration(settings), id);
      const provider = resolveConfiguredSearchProvider({ settings, auth: options.readAuth(), fetch: options.searchFetch });
      const service = createWebSearchService(async () => provider, undefined, { cacheTtlMs: 0 });
      const startedAt = Date.now();
      try {
        const result = await service.handle({ query: 'Varin documentation', connectionId: id, limit: 1, refresh: true }, { signal: signal ?? new AbortController().signal });
        const item = result.items[0]!;
        return { connectionId: id, action: 'search', query: 'Varin documentation', checkedAt: Date.now(), durationMs: Date.now() - startedAt,
          status: item.status, resultCount: item.results?.length ?? 0, providerId: item.providerId,
          ...(item.failure ? { failure: item.failure } : {}), capabilities: result.capabilities };
      } finally { await service.dispose(); }
    },
  };
}

type PendingCredential = { value: SearchCredentialRequest; connection: HarnessWebSearchConnection; saving: boolean };

export function createSearchConnectionSettings(options: {
  settings: Pick<AgentSettingsService, 'read' | 'updateHarness'>;
  credentials: ServiceCredentialStore;
  searchFetch: typeof globalThis.fetch;
  surfaces: ClientSurfaceBridge;
  changed?(request: SearchCredentialRequest): void;
  credentialChanged?(connectionId: string): void;
}) {
  const snapshot = async () => {
    const value = await options.settings.read();
    const harness = object(value.document.harness) ? value.document.harness : {};
    return { revision: value.revision, config: configuration(webOf(harness).search) };
  };
  const access = createSearchConnectionAccess({ readSearchSettings: async () => (await snapshot()).config,
    readAuth: options.credentials.read, saveAuth: options.credentials.save, removeAuth: options.credentials.remove, searchFetch: options.searchFetch,
    ...(options.credentialChanged ? { credentialChanged: options.credentialChanged } : {}) });
  const present = (config: HarnessWebSearchConfiguration | undefined, revision: string) => {
    const resolved = resolveConfiguredSearchProvider({ settings: config, auth: options.credentials.read() });
    return { revision, keylessDefault: config === undefined, configuration: config ?? null,
      connections: 'unavailable' in resolved ? [] : resolved.connections?.map(connection => ({ ...connection,
        credentialConfigured: resolveSearchCredential(options.credentials.read(), config?.connections.find(item => item.id === connection.id)?.credentialRef) !== null })) ?? [] };
  };
  const mutate = async (revision: string, change: (config: HarnessWebSearchConfiguration | undefined) => HarnessWebSearchConfiguration | undefined) => {
    const result = await options.settings.updateHarness(revision, harness => {
      const web = { ...webOf(harness) };
      const next = change(configuration(web.search));
      if (next === undefined) delete web.search;
      else {
        const parsed = configuration(next)!;
        for (const connection of parsed.connections) if (connection.endpoint) {
          let url: URL; try { url = new URL(connection.endpoint); } catch { return invalid('Search endpoint must be an HTTP(S) URL.'); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return invalid('Search endpoint must be an HTTP(S) URL without embedded credentials.');
        }
        web.search = parsed;
      }
      return { ...harness, web: web as JsonValue };
    });
    const harness = object(result.document.harness) ? result.document.harness : {};
    return present(configuration(webOf(harness).search), result.revision);
  };
  const requests = new Map<string, PendingCredential>();
  const notify = (request: PendingCredential) => { options.changed?.(structuredClone(request.value)); };
  const request = (id: string) => requests.get(id) ?? invalid('Credential entry is no longer available on this Host. Start a new entry request.');
  return {
    ...access,
    async list() { const value = await snapshot(); return present(value.config, value.revision); },
    async add(revision: string, input: { provider: HarnessWebSearchProvider; name?: string; description?: string; endpoint?: string; enabled?: boolean }) {
      const id = `${input.provider}-${randomUUID()}`;
      const result = await mutate(revision, current => {
        const value = current ?? { connections: [], fallbackConnectionIds: [] };
        return { ...value, connections: [...value.connections, { ...input, id, name: input.name?.trim() || input.provider, enabled: input.enabled ?? true, credentialRef: `varin-web-search-connection-${id}` }],
          ...(value.defaultConnectionId ? {} : { defaultConnectionId: id }) };
      });
      return { ...result, connectionId: id };
    },
    patch(revision: string, id: string, patch: { name?: string; description?: string; enabled?: boolean; endpoint?: string | null }) {
      return mutate(revision, current => {
        selected(current, id);
        return { ...current!, connections: current!.connections.map(connection => {
          if (connection.id !== id) return connection;
          const value = { ...connection, ...patch };
          if (value.endpoint === null) delete value.endpoint;
          return value as HarnessWebSearchConnection;
        }) };
      });
    },
    remove(revision: string, id: string) {
      return mutate(revision, current => {
        selected(current, id);
        const { defaultConnectionId, ...value } = current!;
        return { ...value, connections: value.connections.filter(connection => connection.id !== id), fallbackConnectionIds: value.fallbackConnectionIds.filter(value => value !== id),
          ...(defaultConnectionId && defaultConnectionId !== id ? { defaultConnectionId } : {}) };
      });
    },
    route(revision: string, patch: { defaultConnectionId?: string | null; fallbackConnectionIds?: string[]; enabled?: boolean; smartSelection?: boolean }) {
      return mutate(revision, current => {
        if (!current) return invalid('Add a connection before configuring a custom route.');
        const value = { ...current, ...patch };
        if (value.defaultConnectionId === null) delete value.defaultConnectionId;
        return value as HarnessWebSearchConfiguration;
      });
    },
    restoreDefault(revision: string) { return mutate(revision, () => undefined); },
    async requestCredential(id: string, caller: Pick<SettingsServiceCaller, 'threadId' | 'branchId' | 'signal'>) {
      caller.signal?.throwIfAborted();
      const connection = await access.read(id);
      if (!connection.credentialRef) return invalid('This connection has no credential reference. Re-create it through the connection settings.');
      const pending: PendingCredential = { value: { id: randomUUID(), connectionId: id, name: connection.name, provider: connection.provider,
        ...(connection.endpoint ? { endpoint: connection.endpoint } : {}), status: 'pending' }, connection, saving: false };
      requests.set(pending.value.id, pending);
      try {
        const delivered = await options.surfaces.request({ type: 'present-credential', entries: [{ id: 'harness.web.search.connections', values: { requestId: pending.value.id } }] }, caller);
        if (delivered.results[0]?.status !== 'applied') throw new Error(delivered.results[0]?.error ?? 'The connected interface could not open credential entry.');
        caller.signal?.throwIfAborted();
      } catch (error) {
        pending.value.status = 'failed'; pending.value.message = 'Credential entry could not be opened on the connected interface.'; notify(pending);
        requests.delete(pending.value.id);
        throw error;
      }
      return structuredClone(pending.value);
    },
    credentialRequest(id: string) { return structuredClone(request(id).value); },
    async submitCredential(id: string, apiKey: string) {
      const pending = request(id);
      if (pending.value.status !== 'pending' || pending.saving) return invalid('Credential entry is no longer waiting for input.');
      pending.saving = true;
      try {
        const current = await access.read(pending.value.connectionId);
        if (routing(current) !== routing(pending.connection)) return invalid('This connection changed while credential entry was open. Start a new entry request.');
        if (!apiKey.trim()) return invalid('Enter a non-empty API key.');
        await options.credentials.save(current.credentialRef!, { type: 'api_key', key: apiKey.trim() });
        pending.value.status = 'completed';
      } catch (error) {
        pending.value.status = 'failed'; pending.value.message = 'The credential could not be saved. Check the connection and start a new entry request.';
        throw error;
      } finally { pending.saving = false; notify(pending); }
      return structuredClone(pending.value);
    },
    cancelCredential(id: string) {
      const pending = request(id);
      if (pending.value.status === 'pending' && !pending.saving) { pending.value.status = 'cancelled'; notify(pending); }
      return structuredClone(pending.value);
    },
    close() { for (const pending of requests.values()) if (pending.value.status === 'pending' && !pending.saving) { pending.value.status = 'cancelled'; notify(pending); } },
  };
}
export type SearchConnectionSettings = ReturnType<typeof createSearchConnectionSettings>;
