import { createSettingsFileStore } from '@varin/settings-store';
import type { SettingsFileStore } from '@varin/settings-store';
import type cryptoModule from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type pathModule from 'node:path';
import { createPrincipalStore, type PrincipalStore } from '../ui-auth/principals.js';

const STORE_VERSION = 3;
const TOKEN_PREFIX = 'varin_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const AUDIT_STORE_VERSION = 1;
const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_LIMIT = 1000;
const MAX_AUDIT_LINE_BYTES = 16 * 1024;

export const REMOTE_CLIENT_PROFILE = Object.freeze({
  CLIENT: 'client',
  READONLY: 'readonly',
  EXTERNAL_AGENT: 'external-agent',
  FULL_CONTROL: 'full-control',
  RESCUE: 'rescue',
});

type ClientTransport = 'direct' | 'relay';

interface RemoteClientRecord {
  principalId: string;
  allowedDirectories: string[];
  appVersion: string | null;
  authMethod: string | null;
  capabilities: string[];
  clientKind: string | null;
  createdAt: string;
  dedupeKey: string | null;
  deviceModel: string | null;
  deviceName: string | null;
  devicePlatform: string | null;
  expiresAt: string | null;
  id: string;
  label: string;
  lastTransport: ClientTransport | null;
  lastUsedAt: string | null;
  pairingId: string | null;
  profile: string;
  revokedAt: string | null;
  tokenHash: string;
  usesRelay: boolean;
}

interface RemoteClientStore extends Record<string, unknown> {
  clients: RemoteClientRecord[];
  version: number;
}

interface RemoteClientRuntimeOptions {
  principals?: PrincipalStore;
  clientStore?: SettingsFileStore;
  crypto: typeof cryptoModule;
  fsPromises: typeof fsPromisesModule;
  path: typeof pathModule;
  storePath: string;
}

interface ClientMutation<Result> {
  result: Result;
  write?: boolean;
}

interface CreateClientInput {
  principalId?: string;
  allowedDirectories?: unknown;
  appVersion?: unknown;
  authMethod?: unknown;
  capabilities?: unknown;
  clientKind?: unknown;
  dedupeKey?: unknown;
  deviceModel?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  expiresAt?: unknown;
  label?: unknown;
  pairingId?: unknown;
  profile?: unknown;
  /** Trusted issuer already authenticated the old subject and is rotating its token. */
  reuseDedupeIdentity?: boolean;
  usesRelay?: unknown;
}

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

type PublicRemoteClient = Omit<RemoteClientRecord, 'dedupeKey' | 'tokenHash'>;

interface AuthenticatedClient {
  principalId: string;
  client: PublicRemoteClient;
  clientId: string;
  ok: true;
  sessionToken: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

export const FULL_CONTROL_CAPABILITIES = Object.freeze([
  'instance:read',
  'instance:write',
  'filesystem:read',
  'filesystem:write',
  'filesystem:delete',
  'workspace:read',
  'workspace:write',
  'git:read',
  'git:write',
  'config:read',
  'config:write',
  'logs:read',
  'terminal:use',
  'process:control',
  'update:install',
]);

const READONLY_CAPABILITIES = Object.freeze([
  'instance:read',
  'filesystem:read',
  'workspace:read',
  'git:read',
  'config:read',
  'logs:read',
]);

const DEFAULT_CLIENT_CAPABILITIES = Object.freeze([
  'ui:access',
]);

const normalizeLabel = (value: unknown): string => {
  if (typeof value !== 'string') return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
};

const normalizeTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeProfile = (value: unknown): string => {
  const raw = normalizeOptionalString(value);
  if (!raw) return REMOTE_CLIENT_PROFILE.CLIENT;
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized === 'agent' || normalized === 'external') return REMOTE_CLIENT_PROFILE.EXTERNAL_AGENT;
  if (normalized === 'full' || normalized === 'admin' || normalized === 'full-access') return REMOTE_CLIENT_PROFILE.FULL_CONTROL;
  if (normalized === 'read-only') return REMOTE_CLIENT_PROFILE.READONLY;
  if (new Set<string>(Object.values(REMOTE_CLIENT_PROFILE)).has(normalized)) return normalized;
  return normalized.replace(/[^a-z0-9:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || REMOTE_CLIENT_PROFILE.CLIENT;
};

export const getCapabilitiesForProfile = (profile: unknown): string[] => {
  const normalized = normalizeProfile(profile);
  if (
    normalized === REMOTE_CLIENT_PROFILE.FULL_CONTROL ||
    normalized === REMOTE_CLIENT_PROFILE.EXTERNAL_AGENT ||
    normalized === REMOTE_CLIENT_PROFILE.RESCUE
  ) {
    return [...FULL_CONTROL_CAPABILITIES];
  }
  if (normalized === REMOTE_CLIENT_PROFILE.READONLY) {
    return [...READONLY_CAPABILITIES];
  }
  return [...DEFAULT_CLIENT_CAPABILITIES];
};

const normalizeCapabilities = (value: unknown, profile: unknown): string[] => {
  const fallback = getCapabilitiesForProfile(profile);
  if (!Array.isArray(value)) return fallback;
  const normalized = Array.from(new Set(
    value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  ));
  return normalized.length > 0 ? normalized : fallback;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
  ));
};

const normalizeMetadata = (client: Record<string, unknown>) => ({
  authMethod: normalizeOptionalString(client.authMethod),
  pairingId: normalizeOptionalString(client.pairingId),
  deviceName: normalizeOptionalString(client.deviceName),
  devicePlatform: normalizeOptionalString(client.devicePlatform),
  deviceModel: normalizeOptionalString(client.deviceModel),
  appVersion: normalizeOptionalString(client.appVersion),
});

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const createRuntime = ({
  fsPromises,
  path,
  crypto,
  storePath,
  clientStore: providedClientStore,
  principals = createPrincipalStore(path.join(path.dirname(storePath), 'ui-principals.json')),
}: RemoteClientRuntimeOptions) => {
  const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
  const nowIso = () => new Date().toISOString();
  const generateId = () => crypto.randomBytes(12).toString('hex');
  const generateToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const auditPath = path.join(path.dirname(storePath), 'external-access-audit.jsonl');
  const emptyStore = (): RemoteClientStore => ({ version: STORE_VERSION, clients: [] });
  const clientStore = providedClientStore ?? createSettingsFileStore({
    filePath: storePath,
    defaultValue: emptyStore(),
  });

  const normalizeStore = (value: unknown, legacyOwnerId: string): RemoteClientStore => {
    const payload = asRecord(value);
    if (!payload || payload.version !== 2 && payload.version !== STORE_VERSION) {
      throw new Error(`Unsupported remote clients version: ${String(payload?.version)}`);
    }
    if (!Array.isArray(payload.clients)) {
      throw new Error('Remote clients file has invalid clients');
    }
    const clients = payload.clients.map((value): RemoteClientRecord => {
          const client = asRecord(value);
          if (!client) {
            throw new Error('Remote clients file contains an invalid client');
          }
          const id = normalizeOptionalString(client.id);
          const tokenHash = normalizeOptionalString(client.tokenHash);
          if (!id || !tokenHash) {
            throw new Error('Remote clients file contains an incomplete client');
          }
          if (payload.version === STORE_VERSION && !normalizeOptionalString(client.principalId)) throw new Error('Remote clients file has an unbound principal');
          const profile = normalizeProfile(client.profile);
          return {
            id,
            principalId: normalizeOptionalString(client.principalId) ?? legacyOwnerId,
            label: normalizeLabel(client.label),
            tokenHash,
            createdAt: typeof client.createdAt === 'string' ? client.createdAt : nowIso(),
            lastUsedAt: typeof client.lastUsedAt === 'string' ? client.lastUsedAt : null,
            revokedAt: typeof client.revokedAt === 'string' ? client.revokedAt : null,
            expiresAt: normalizeTimestamp(client.expiresAt),
            clientKind: normalizeOptionalString(client.clientKind),
            dedupeKey: normalizeOptionalString(client.dedupeKey),
            profile,
            capabilities: normalizeCapabilities(client.capabilities, profile),
            allowedDirectories: normalizeStringArray(client.allowedDirectories),
            usesRelay: client.usesRelay === true,
            lastTransport: client.lastTransport === 'relay' || client.lastTransport === 'direct' ? client.lastTransport : null,
            ...normalizeMetadata(client),
          };
        });
    return { version: STORE_VERSION, clients };
  };

  let closed = false;
  let snapshot: RemoteClientStore;
  let byToken = new Map<string, RemoteClientRecord>();
  const publish = (store: RemoteClientStore): void => {
    snapshot = store;
    byToken = new Map(store.clients.filter(client => !client.revokedAt).map(client => [client.tokenHash, client]));
  };
  // Constructing the Host must not open stores or create its identity before
  // the offline-restore fence has been checked. The first actual consumer owns
  // initialization; concurrent consumers share its result for this lifetime.
  let initialization: Promise<void> | undefined;
  const ready = (): Promise<void> => initialization ??= (async () => {
    const raw = await clientStore.read();
    const owner = await principals.ownerId();
    if (raw.version === STORE_VERSION) publish(normalizeStore(raw, owner));
    else publish(await clientStore.transact(persisted => {
      const store = normalizeStore(persisted, owner);
      return { document: store, result: store, write: persisted.version !== STORE_VERSION };
    }));
  })();
  const readStore = async () => { await ready(); return snapshot; };
  type Usage = { lastUsedAt: string; lastTransport: ClientTransport; usesRelay: boolean };
  const pendingUsage = new Map<string, Usage>();
  let mutation: Promise<unknown> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const mutateStore = <Result>(mutator: (store: RemoteClientStore) => Promise<ClientMutation<Result>>): Promise<Result> => {
    const next = mutation.catch(() => undefined).then(async () => {
      await ready();
      const usage = new Map(pendingUsage);
      const committed = await clientStore.transact(async persisted => {
        const store = normalizeStore(persisted, await principals.ownerId());
        for (const client of store.clients) {
          const update = usage.get(client.tokenHash);
          if (update && !client.revokedAt) Object.assign(client, update, { usesRelay: client.usesRelay || update.usesRelay });
        }
        const transaction = await mutator(store);
        return { document: store, result: { store, result: transaction.result },
          write: transaction.write !== false || usage.size > 0 || persisted.version !== STORE_VERSION };
      });
      // No credential becomes visible before its durable commit succeeds.
      publish(committed.store);
      for (const [hash, update] of usage) if (pendingUsage.get(hash) === update) pendingUsage.delete(hash);
      // Requests can record usage while the commit is in flight. Preserve it in
      // memory and the next flush, without resurrecting revoked/rotated tokens.
      for (const [hash, update] of pendingUsage) {
        const client = byToken.get(hash);
        if (client) Object.assign(client, update, { usesRelay: client.usesRelay || update.usesRelay });
        else pendingUsage.delete(hash);
      }
      return committed.result;
    });
    mutation = next;
    return next;
  };
  const flushUsage = async (): Promise<void> => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    if (pendingUsage.size) await mutateStore(async () => ({ result: undefined, write: false }));
    else await mutation.catch(() => undefined);
  };
  const scheduleUsage = (delay = 0): void => {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushUsage().catch(() => {
        console.warn('[ClientAuth] Usage metadata could not be saved; it will be retried');
        scheduleUsage(LAST_USED_WRITE_INTERVAL_MS);
      });
    }, delay);
    flushTimer.unref?.();
  };

  function publicClient(client: RemoteClientRecord): PublicRemoteClient {
    return {
    id: client.id,
    principalId: client.principalId,
    label: client.label,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
    expiresAt: client.expiresAt,
    clientKind: client.clientKind,
    profile: client.profile,
    capabilities: [...client.capabilities],
    allowedDirectories: [...client.allowedDirectories],
    authMethod: client.authMethod,
    pairingId: client.pairingId,
    deviceName: client.deviceName,
    devicePlatform: client.devicePlatform,
    deviceModel: client.deviceModel,
    appVersion: client.appVersion,
    usesRelay: client.usesRelay === true,
    lastTransport: client.lastTransport ?? null,
    };
  }

  const listClients = async () => {
    const store = await readStore();
    return store.clients.map(publicClient);
  };

  // Relay demand includes both pairing-time intent and the authoritative fact
  // that a device has actually reached this host through the relay.
  const hasActiveRelayClients = async () => {
    const store = await readStore();
    const now = Date.now();
    return store.clients.some((client) => {
      if (client.usesRelay !== true && client.lastTransport !== 'relay') return false;
      if (client.revokedAt) return false;
      const expires = Date.parse(client.expiresAt || '');
      return !Number.isFinite(expires) || expires > now;
    });
  };

  const createClient = async ({
    principalId,
    label,
    expiresAt,
    clientKind,
    dedupeKey,
    authMethod,
    pairingId,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    usesRelay,
    profile,
    capabilities,
    allowedDirectories,
    reuseDedupeIdentity = false,
  }: CreateClientInput = {}) => {
    return mutateStore(async (store) => {
      const subject = principalId ?? await principals.ownerId();
      if (!await principals.resolve(subject)) throw new Error('Unknown authentication principal');
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      const normalizedProfile = normalizeProfile(profile);
      const token = generateToken();
      const priorDedupeClient = reuseDedupeIdentity && normalizedDedupeKey
        ? store.clients.find((entry) => entry.dedupeKey === normalizedDedupeKey && entry.principalId === subject)
        : null;
      const client = {
        id: priorDedupeClient?.id || generateId(),
        principalId: subject,
        label: normalizeLabel(label),
        tokenHash: hashToken(token),
        createdAt: priorDedupeClient?.createdAt || nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(expiresAt),
        clientKind: normalizeOptionalString(clientKind),
        dedupeKey: normalizedDedupeKey,
        profile: normalizedProfile,
        capabilities: normalizeCapabilities(capabilities, normalizedProfile),
        allowedDirectories: normalizeStringArray(allowedDirectories),
        authMethod: normalizeOptionalString(authMethod),
        pairingId: normalizeOptionalString(pairingId),
        deviceName: normalizeOptionalString(deviceName),
        devicePlatform: normalizeOptionalString(devicePlatform),
        deviceModel: normalizeOptionalString(deviceModel),
        appVersion: normalizeOptionalString(appVersion),
        usesRelay: usesRelay === true,
        lastTransport: null,
      };
      if (normalizedDedupeKey) {
        store.clients = store.clients.filter((entry) => entry.dedupeKey !== normalizedDedupeKey || entry.principalId !== subject);
        // Migrate pre-clientKind desktop tokens: a deduped, kind-tagged mint
        // supersedes legacy records with the same label that carry neither a
        // kind nor a dedupe key — those tokens can no longer pass the
        // desktop-local client-create gate and would otherwise linger forever.
        if (client.clientKind) {
          store.clients = store.clients.filter((entry) =>
            !(entry.principalId === subject && entry.label === client.label && !entry.clientKind && !entry.dedupeKey));
        }
      }
      store.clients.push(client);
      return { result: { client: publicClient(client), token } };
    });
  };

  const revokeClient = async (id: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { revoked: false };
    }
    return mutateStore<{ client?: PublicRemoteClient; revoked: boolean }>(async (store) => {
      const client = store.clients.find((entry) => entry.id === id);
      if (!client) return { result: { revoked: false }, write: false };
      if (client.revokedAt) return { result: { revoked: true, client: publicClient(client) }, write: false };
      client.revokedAt = nowIso();
      return { result: { revoked: true, client: publicClient(client) } };
    });
  };

  const purgeRevokedClients = async (principalId?: string) => {
    return mutateStore(async (store) => {
      const before = store.clients.length;
      store.clients = store.clients.filter((entry) => !entry.revokedAt || principalId !== undefined && entry.principalId !== principalId);
      const purged = before - store.clients.length;
      return { result: { purged }, write: purged > 0 };
    });
  };

  const authenticateBearerToken = async (token: unknown, req?: RequestLike): Promise<AuthenticatedClient | null> => {
    if (closed || typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    // Which transport carried this request: the relay tunnel proxy stamps every
    // forwarded request with x-varin-relay-connection; anything else is a
    // direct (local/LAN/tunnel-URL) request. This also drives relay demand.
    const transport = req?.headers?.['x-varin-relay-connection'] ? 'relay' : 'direct';
    await ready();
    const tokenHash = hashToken(token);
    let client = byToken.get(tokenHash);
    if (!client || !await principals.resolve(client.principalId)) return null;
    // A revocation may commit while principal initialization yields.
    client = byToken.get(tokenHash);
    if (!client || closed) return null;
    if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
    const now = Date.now();
    const lastUsedAt = Date.parse(client.lastUsedAt || '');
    if (transport === 'relay' && !client.usesRelay || !Number.isFinite(lastUsedAt)
      || now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS || client.lastTransport !== transport) {
      const usage: Usage = { lastUsedAt: new Date(now).toISOString(), lastTransport: transport,
        usesRelay: client.usesRelay || transport === 'relay' };
      Object.assign(client, usage);
      pendingUsage.set(tokenHash, usage);
      scheduleUsage();
    }
    return { ok: true, principalId: client.principalId, clientId: client.id, sessionToken: client.id, client: publicClient(client) };
  };

  const recordAuditEvent = async (event: Record<string, unknown> = {}) => {
    const clientId = normalizeOptionalString(event.clientId);
    if (!clientId) return { recorded: false };
    const entry = {
      version: AUDIT_STORE_VERSION,
      time: nowIso(),
      clientId,
      label: normalizeOptionalString(event.label),
      profile: normalizeOptionalString(event.profile),
      method: normalizeOptionalString(event.method),
      path: normalizeOptionalString(event.path),
      status: typeof event.status === 'number' && Number.isInteger(event.status) ? event.status : null,
      ip: normalizeOptionalString(event.ip),
      userAgent: normalizeOptionalString(event.userAgent),
      durationMs: typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
        ? Math.max(0, Math.round(event.durationMs))
        : null,
      target: event.target && typeof event.target === 'object' ? event.target : null,
    };
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_LINE_BYTES) {
      entry.target = { truncated: true };
      line = `${JSON.stringify(entry)}\n`;
    }
    await fsPromises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await fsPromises.appendFile(auditPath, line, { encoding: 'utf8', mode: 0o600 });
    if (typeof fsPromises.chmod === 'function') {
      await fsPromises.chmod(auditPath, 0o600).catch(() => {});
    }
    return { recorded: true };
  };

  const listAuditEvents = async ({ limit = DEFAULT_AUDIT_LIMIT }: { limit?: unknown } = {}) => {
    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);
    let raw = '';
    try {
      raw = await fsPromises.readFile(auditPath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => safeJsonParse(line))
      .filter((entry) => entry && typeof entry === 'object')
      .reverse();
  };

  return {
    authenticateBearerToken,
    flushUsage,
    dispose: async () => { closed = true; await flushUsage(); },
    createClient,
    getCapabilitiesForProfile,
    listAuditEvents,
    listClients,
    hasActiveRelayClients,
    purgeRevokedClients,
    recordAuditEvent,
    revokeClient,
  };
};

// All consumers in the embedded Electron/Host process share one credential index.
// A stopped Host can reopen the path, loading migrations and principals afresh.
const runtimes = new Map<string, ReturnType<typeof createRuntime>>();
export const createRemoteClientAuthRuntime = (options: RemoteClientRuntimeOptions): ReturnType<typeof createRuntime> => {
  const key = options.path.resolve(options.storePath);
  const existing = runtimes.get(key);
  if (existing) return existing;
  const runtime = createRuntime(options);
  const dispose = runtime.dispose;
  runtime.dispose = async () => {
    try { await dispose(); }
    finally { if (runtimes.get(key) === runtime) runtimes.delete(key); }
  };
  runtimes.set(key, runtime);
  return runtime;
};
