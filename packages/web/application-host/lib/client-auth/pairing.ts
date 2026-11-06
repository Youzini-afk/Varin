import { createSettingsFileStore } from '@varin/settings-store';
import type { SettingsFileStore } from '@varin/settings-store';
import type cryptoModule from 'node:crypto';
import pathModule from 'node:path';
import { createPrincipalStore, type PrincipalStore } from '../ui-auth/principals.js';

const STORE_VERSION = 2;
const PAIRING_ID_PREFIX = 'pair_';
const SECRET_BYTES = 32;
const FINGERPRINT_BYTES = 4;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_LABEL_LENGTH = 80;
const VALID_CLIENT_KINDS = new Set(['mobile', 'desktop']);
const GENERIC_REDEEM_ERROR = 'Invalid or expired pairing session';

type ClientKind = 'desktop' | 'mobile';

interface PairingSession {
  principalId: string;
  allowedClientKinds: ClientKind[];
  cancelledAt: string | null;
  clientId: string | null;
  createdAt: string;
  createdByClientId: string | null;
  expiresAt: string;
  fingerprint: string;
  id: string;
  label: string | null;
  secretHash: string;
  usedAt: string | null;
  usesRelay: boolean;
}

interface PairingStore extends Record<string, unknown> {
  sessions: PairingSession[];
  version: number;
}

interface RemoteClientCreateInput extends Record<string, unknown> {
  principalId: string;
  authMethod: string;
  clientKind: ClientKind;
  dedupeKey: string;
  label: string;
  profile?: string;
  pairingId: string;
  usesRelay: boolean;
}

interface RemoteClientAuthRuntime {
  createClient(input: RemoteClientCreateInput): Promise<{
    client: { id: string } & Record<string, unknown>;
    token: string;
  }>;
}

interface PairingRuntimeOptions {
  principals?: PrincipalStore;
  crypto?: typeof cryptoModule;
  fsPromises?: unknown;
  pairingStore?: SettingsFileStore;
  path?: unknown;
  remoteClientAuthRuntime?: RemoteClientAuthRuntime;
  storePath?: string;
  ttlMs?: number;
}

interface CreatePairingInput {
  principalId?: string;
  allowedClientKinds?: unknown;
  createdByClientId?: unknown;
  label?: unknown;
  usesRelay?: unknown;
}

interface RedeemPairingInput {
  appVersion?: unknown;
  clientKind?: unknown;
  clientLabel?: unknown;
  dedupeKey?: unknown;
  deviceModel?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  pairingId?: unknown;
  secret?: unknown;
}

interface PairingMutation<Result> {
  result: Result;
  write?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Placeholder shown in the pending-devices list when the operator did not type a
// name. It is a DISPLAY default only — the stored label stays null so redeem can
// fall back to the device's own reported name instead of this placeholder.
const PAIRING_LABEL_PLACEHOLDER = 'Pair new device';

// The operator's typed device label, capped. Returns null when unset so callers
// can distinguish "no name given" from a real name.
const normalizeStoredLabel = (value: unknown): string | null => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized.length > MAX_LABEL_LENGTH ? normalized.slice(0, MAX_LABEL_LENGTH) : normalized;
};

const normalizeTimestamp = (value: unknown): string | null => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeClientKind = (value: unknown): ClientKind | null => {
  const normalized = normalizeOptionalString(value);
  return normalized && VALID_CLIENT_KINDS.has(normalized) ? normalized as ClientKind : null;
};

const normalizeAllowedClientKinds = (value: unknown): ClientKind[] => {
  if (!Array.isArray(value)) return ['mobile', 'desktop'];
  const kinds = value.map(normalizeClientKind).filter((kind): kind is ClientKind => Boolean(kind));
  return kinds.length > 0 ? Array.from(new Set(kinds)) : ['mobile', 'desktop'];
};

const constantTimeEqual = (left: unknown, right: unknown, crypto: typeof cryptoModule): boolean => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const publicSession = (session: PairingSession) => ({
  id: session.id,
  principalId: session.principalId,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  usedAt: session.usedAt,
  cancelledAt: session.cancelledAt,
  clientId: session.clientId,
  label: session.label || PAIRING_LABEL_PLACEHOLDER,
  fingerprint: session.fingerprint,
  allowedClientKinds: session.allowedClientKinds,
  createdByClientId: session.createdByClientId,
  usesRelay: session.usesRelay === true,
});

// A pending session is one that can still be redeemed: not used, not cancelled,
// not expired.
const isPendingSession = (session: PairingSession): boolean => !session.usedAt
  && !session.cancelledAt
  && Number.isFinite(Date.parse(session.expiresAt))
  && Date.parse(session.expiresAt) > Date.now();

const redeemError = () => {
  const error = new Error(GENERIC_REDEEM_ERROR) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
};

export const createClientPairingRuntime = ({
  crypto,
  storePath,
  remoteClientAuthRuntime,
  pairingStore: providedPairingStore,
  ttlMs = DEFAULT_TTL_MS,
  principals: providedPrincipals,
}: PairingRuntimeOptions = {}) => {
  if (!crypto || !storePath || !remoteClientAuthRuntime) {
    throw new Error('createClientPairingRuntime requires crypto, storePath, and remoteClientAuthRuntime');
  }

  const principals = providedPrincipals ?? createPrincipalStore(pathModule.join(pathModule.dirname(storePath), 'ui-principals.json'));
  const nowIso = () => new Date().toISOString();
  const hashSecret = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');
  const generateId = () => `${PAIRING_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  const generateSecret = () => crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const generateFingerprint = () => crypto.randomBytes(FINGERPRINT_BYTES).toString('hex').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
  const emptyStore = (): PairingStore => ({ version: STORE_VERSION, sessions: [] });
  const pairingStore = providedPairingStore ?? createSettingsFileStore({
    filePath: storePath,
    defaultValue: emptyStore(),
  });

  const normalizeStore = (value: unknown, legacyOwnerId: string): PairingStore => {
    const payload = asRecord(value);
    if (!payload || payload.version !== 1 && payload.version !== STORE_VERSION) {
      throw new Error(`Unsupported pairing store version: ${String(payload?.version)}`);
    }
    if (!Array.isArray(payload.sessions)) {
      throw new Error('Pairing store has invalid sessions');
    }
    const sessions = payload.sessions.map((value): PairingSession => {
          const session = asRecord(value);
          if (!session) {
            throw new Error('Pairing store contains an invalid session');
          }
          const id = normalizeOptionalString(session.id);
          const secretHash = normalizeOptionalString(session.secretHash);
          if (!id || !secretHash) {
            throw new Error('Pairing store contains an incomplete session');
          }
          if (payload.version === STORE_VERSION && !normalizeOptionalString(session.principalId)) throw new Error('Pairing store has an unbound principal');
          return {
          id,
          principalId: normalizeOptionalString(session.principalId) ?? legacyOwnerId,
          secretHash,
          createdAt: typeof session.createdAt === 'string' ? session.createdAt : nowIso(),
          expiresAt: normalizeTimestamp(session.expiresAt) || new Date(Date.now() + ttlMs).toISOString(),
          usedAt: normalizeTimestamp(session.usedAt),
          cancelledAt: normalizeTimestamp(session.cancelledAt),
          clientId: normalizeOptionalString(session.clientId),
          label: normalizeStoredLabel(session.label),
          fingerprint: normalizeOptionalString(session.fingerprint) || generateFingerprint(),
          allowedClientKinds: normalizeAllowedClientKinds(session.allowedClientKinds),
          createdByClientId: normalizeOptionalString(session.createdByClientId),
          usesRelay: session.usesRelay === true,
        };
      });
    return { version: STORE_VERSION, sessions };
  };

  const readStore = async () => mutateStore(async store => ({ result: store }));

  const mutateStore = <Result>(mutator: (store: PairingStore) => Promise<PairingMutation<Result>>): Promise<Result> => pairingStore.transact(async (persisted) => {
    const store = normalizeStore(persisted, await principals.ownerId());
    const transaction = await mutator(store);
    return {
      document: store,
      result: transaction.result,
      write: transaction.write !== false || asRecord(persisted)?.version !== STORE_VERSION,
    };
  });

  const sweepExpiredSessionsFromStore = (store: PairingStore): void => {
    const now = Date.now();
    const cutoff = now - ttlMs;
    store.sessions = store.sessions.filter((session) => {
      const usedAt = Date.parse(session.usedAt || '');
      const cancelledAt = Date.parse(session.cancelledAt || '');
      const inactiveAt = Number.isFinite(usedAt) ? usedAt : cancelledAt;
      if (Number.isFinite(inactiveAt)) return inactiveAt >= cutoff;
      // Never used or cancelled: drop once the session itself has expired —
      // it can no longer be redeemed and would otherwise sit in the store forever.
      const expiresAt = Date.parse(session.expiresAt || '');
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
  };

  const createPairingSession = async ({ label, allowedClientKinds, createdByClientId, usesRelay, principalId }: CreatePairingInput = {}) => {
    return mutateStore(async (store) => {
      sweepExpiredSessionsFromStore(store);
      const subject = principalId ?? await principals.ownerId();
      if (!await principals.resolve(subject)) throw new Error('Unknown authentication principal');
      const secret = generateSecret();
      const session = {
        id: generateId(),
        principalId: subject,
        secretHash: hashSecret(secret),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        usedAt: null,
        cancelledAt: null,
        clientId: null,
        label: normalizeStoredLabel(label),
        fingerprint: generateFingerprint(),
        allowedClientKinds: normalizeAllowedClientKinds(allowedClientKinds),
        createdByClientId: normalizeOptionalString(createdByClientId),
        usesRelay: usesRelay === true,
      };
      store.sessions.push(session);
      return { result: { pairing: { ...publicSession(session), secret } } };
    });
  };

  // Sessions that can still be redeemed (link created, device not yet connected).
  const listPendingSessions = async () => {
    const store = await readStore();
    return store.sessions.filter(isPendingSession).map(publicSession);
  };

  // Relay-transport demand from pairing: any still-redeemable relay session.
  const hasActiveRelaySession = async () => {
    const store = await readStore();
    return store.sessions.some((session) => session.usesRelay === true && isPendingSession(session));
  };

  const getPairingSession = async (id: unknown) => {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) return null;
    const store = await readStore();
    const session = store.sessions.find((entry) => entry.id === normalizedId);
    return session ? publicSession(session) : null;
  };

  const cancelPairingSession = async (id: unknown) => {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) return { cancelled: false };
    return mutateStore<{ cancelled: boolean; pairing?: ReturnType<typeof publicSession> }>(async (store) => {
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      if (!session) return { result: { cancelled: false }, write: false };
      if (session.cancelledAt) {
        return { result: { cancelled: true, pairing: publicSession(session) }, write: false };
      }
      session.cancelledAt = nowIso();
      return { result: { cancelled: true, pairing: publicSession(session) } };
    });
  };

  const redeemPairingSession = async ({
    pairingId,
    secret,
    clientLabel,
    clientKind,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    dedupeKey,
  }: RedeemPairingInput = {}) => {
    const normalizedId = normalizeOptionalString(pairingId);
    const normalizedSecret = normalizeOptionalString(secret);
    const normalizedKind = normalizeClientKind(clientKind) || 'mobile';
    if (!normalizedId || !normalizedSecret) throw redeemError();

    return mutateStore(async (store) => {
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      if (!session) throw redeemError();
      if (session.cancelledAt || session.usedAt) throw redeemError();
      if (Date.parse(session.expiresAt) <= Date.now()) throw redeemError();
      if (!session.allowedClientKinds.includes(normalizedKind)) throw redeemError();
      if (!constantTimeEqual(session.secretHash, hashSecret(normalizedSecret), crypto)) throw redeemError();

      // The operator's typed pairing label is THIS server's name for the device
      // (shown in the device list). It wins over the device's self-reported
      // label; fall back to that only when no pairing label was set.
      const label = normalizeOptionalString(session.label)
        || normalizeOptionalString(clientLabel)
        || normalizeOptionalString(deviceName)
        || 'Remote client';
      const result = await remoteClientAuthRuntime.createClient({
        label,
        principalId: session.principalId,
        clientKind: normalizedKind,
        dedupeKey: normalizeOptionalString(dedupeKey) || `pairing:${session.id}`,
        authMethod: 'pairing',
        pairingId: session.id,
        deviceName,
        devicePlatform,
        deviceModel,
        appVersion,
        usesRelay: session.usesRelay === true,
        ...(normalizedKind === 'desktop' ? { profile: 'full-control' } : {}),
      });
      session.usedAt = nowIso();
      session.clientId = result.client?.id || null;
      return { result: { pairing: publicSession(session), client: result.client, token: result.token } };
    });
  };

  const sweepExpiredSessions = async () => mutateStore(async (store) => {
    const before = store.sessions.length;
    sweepExpiredSessionsFromStore(store);
    const purged = before - store.sessions.length;
    return { result: { purged }, write: purged > 0 };
  });

  return {
    createPairingSession,
    getPairingSession,
    listPendingSessions,
    hasActiveRelaySession,
    cancelPairingSession,
    redeemPairingSession,
    sweepExpiredSessions,
  };
};
