import crypto from 'crypto';
import path from 'path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  Base64URLString,
  CredentialDeviceType,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createSettingsFileStore } from '@varin/settings-store';
import type { SettingsFileStore } from '@varin/settings-store';
import { resolveVarinDataDir } from '../platform/data-paths.js';
import type { IncomingHttpHeaders } from 'node:http';

const DEFAULT_STORE_VERSION = 2;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RP_NAME = 'Varin';

const VARIN_DATA_DIR = resolveVarinDataDir(process);
const PASSKEY_STORE_FILE = path.join(VARIN_DATA_DIR, 'ui-passkeys.json');

interface StoredPasskey {
  principalId?: string;
  backedUp: boolean;
  counter: number;
  createdAt: number;
  deviceType: CredentialDeviceType;
  id: Base64URLString;
  label: string;
  lastUsedAt: number | null;
  publicKey: string;
  rpID: string;
  transports: AuthenticatorTransport[];
}

interface PasskeyStore extends Record<string, unknown> {
  passkeys: StoredPasskey[];
  passwordBinding: string;
  userID: string;
  version: number;
}

interface ChallengeRecord {
  challenge: string;
  createdAt: number;
  expectedOrigins: string[];
  expectedRPIDs: string[];
  expiresAt: number;
}

interface RegistrationChallengeRecord extends ChallengeRecord {
  principalId?: string;
  label: string;
  rpID: string;
}

interface UiPasskeysOptions {
  ownerPrincipalId?: () => Promise<string>;
  challengeTtlMs?: number;
  passkeyStore?: Pick<SettingsFileStore, 'transact'>;
  passwordBinding?: string;
  readSettingsFromDisk?: () => Promise<Record<string, unknown>>;
  rpName?: string;
  storeFile?: string;
}

interface PasskeyMutation<Result> {
  result: Result;
  write?: boolean;
}

interface PasskeyRequest {
  headers: IncomingHttpHeaders;
  socket?: { encrypted?: boolean | undefined };
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const httpError = (message: string, statusCode: number): Error & { statusCode: number } => (
  Object.assign(new Error(message), { statusCode })
);

const createUserId = () => crypto.randomBytes(32).toString('base64url');

const decodeUserId = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    return Uint8Array.from(Buffer.from(value, 'base64url'));
  } catch {
    return null;
  }
};

const normalizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 120) : fallback;
};

const isLocalRpId = (rpID: unknown): boolean => rpID === 'localhost' || rpID === '127.0.0.1' || rpID === '[::1]' || rpID === '::1';

const getPasskeyRequestURL = (req: PasskeyRequest): URL | null => {
  const forwarded = (name: string) => {
    const value = req.headers[name];
    return typeof value === 'string' ? value.split(',')[0]?.trim() : '';
  };
  const scheme = forwarded('x-forwarded-proto')?.toLowerCase() || (req.socket?.encrypted ? 'https' : 'http');
  const host = forwarded('x-forwarded-host') || req.headers.host?.trim();
  // Host is an authority, not an arbitrary URL. Do not normalize a path or userinfo into a trusted origin.
  if ((scheme !== 'http' && scheme !== 'https') || !host || /[\\/?#@\s]/u.test(host)) return null;
  // Use the same ASCII host and serialized origin as the browser, including IDNs and default ports.
  return URL.parse(`${scheme}://${host}`);
};

const parseStoredPasskey = (value: unknown): StoredPasskey | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (typeof record.id !== 'string' || typeof record.publicKey !== 'string' || typeof record.rpID !== 'string') {
    return null;
  }

  return {
    id: record.id as Base64URLString,
    ...(typeof record.principalId === 'string' ? { principalId: record.principalId } : {}),
    publicKey: record.publicKey,
    counter: typeof record.counter === 'number' && Number.isFinite(record.counter) ? record.counter : 0,
    transports: Array.isArray(record.transports)
      ? record.transports.filter((value): value is AuthenticatorTransport => (
        value === 'ble' || value === 'cable' || value === 'hybrid' || value === 'internal'
        || value === 'nfc' || value === 'smart-card' || value === 'usb'
      ))
      : [],
    deviceType: record.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: record.backedUp === true,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null,
    label: normalizeLabel(record.label, 'Unnamed device'),
    rpID: record.rpID,
  };
};

export const createUiPasskeys = ({
  passwordBinding,
  ownerPrincipalId,
  readSettingsFromDisk,
  storeFile = PASSKEY_STORE_FILE,
  rpName = DEFAULT_RP_NAME,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
  passkeyStore: providedPasskeyStore,
}: UiPasskeysOptions = {}) => {
  passwordBinding = typeof passwordBinding === 'string' ? passwordBinding : '';
  const registrationChallenges = new Map<string, RegistrationChallengeRecord>();
  const authenticationChallenges = new Map<string, ChallengeRecord>();

  const createEmptyStore = (): PasskeyStore => ({
    version: DEFAULT_STORE_VERSION,
    userID: createUserId(),
    passwordBinding,
    passkeys: [],
  });
  const passkeyStore = providedPasskeyStore ?? createSettingsFileStore({
    filePath: storeFile,
    defaultValue: createEmptyStore(),
  });

  const normalizeStore = (value: unknown): PasskeyStore => {
    const candidate = asRecord(value);
    if (!candidate || candidate.version !== 1 && candidate.version !== DEFAULT_STORE_VERSION) {
      throw new Error(`Unsupported passkey store version: ${String(candidate?.version)}`);
    }
    if (typeof candidate.userID !== 'string' || !decodeUserId(candidate.userID)
      || typeof candidate.passwordBinding !== 'string' || !Array.isArray(candidate.passkeys)) {
      throw new Error('Passkey store is malformed');
    }
    const passkeys = candidate.passkeys.map(parseStoredPasskey);
    if (passkeys.some((passkey) => passkey === null)) {
      throw new Error('Passkey store contains an invalid credential');
    }
    return {
      version: DEFAULT_STORE_VERSION,
      userID: candidate.userID,
      passwordBinding: candidate.passwordBinding,
      passkeys: passkeys as StoredPasskey[],
    };
  };

  const applyPasswordBinding = (store: PasskeyStore): { changed: boolean; store: PasskeyStore } => {
    if (!passwordBinding) {
      if (store.passkeys.length === 0 && !store.passwordBinding) return { store, changed: false };
      return { store: { ...store, passkeys: [], passwordBinding: '' }, changed: true };
    }
    if (store.passwordBinding === passwordBinding) return { store, changed: false };
    return {
      store: {
        version: DEFAULT_STORE_VERSION,
        userID: store.userID,
        passwordBinding,
        passkeys: [],
      },
      changed: true,
    };
  };

  const loadStore = () => passkeyStore.transact(async (persisted) => {
    const binding = applyPasswordBinding(normalizeStore(persisted));
    if (ownerPrincipalId) {
      const owner = await ownerPrincipalId();
      for (const passkey of binding.store.passkeys) if (!passkey.principalId) { passkey.principalId = owner; binding.changed = true; }
    }
    binding.changed ||= asRecord(persisted)?.version !== DEFAULT_STORE_VERSION;
    return {
      document: binding.store,
      result: binding.store,
      write: binding.changed,
    };
  });

  const mutateStore = <Result>(mutator: (store: PasskeyStore) => Promise<PasskeyMutation<Result>>): Promise<Result> => passkeyStore.transact(async (persisted) => {
    const binding = applyPasswordBinding(normalizeStore(persisted));
    if (ownerPrincipalId) {
      const owner = await ownerPrincipalId();
      for (const passkey of binding.store.passkeys) if (!passkey.principalId) { passkey.principalId = owner; binding.changed = true; }
    }
    binding.changed ||= asRecord(persisted)?.version !== DEFAULT_STORE_VERSION;
    const transaction = await mutator(binding.store);
    return {
      document: binding.store,
      result: transaction.result,
      write: binding.changed || transaction.write !== false,
    };
  });

  const cleanupChallengeMap = <RecordType extends ChallengeRecord>(map: Map<string, RecordType>): void => {
    const now = Date.now();
    for (const [requestId, record] of map.entries()) {
      if (!record || now >= record.expiresAt) {
        map.delete(requestId);
      }
    }
  };

  const buildOriginCandidates = async (currentOrigin: string): Promise<string[]> => {
    const origins = new Set([currentOrigin]);

    try {
      const settings = await readSettingsFromDisk?.();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
      // The current request origin remains a valid candidate when settings are unavailable.
    }

    return Array.from(origins);
  };

  const assertEnabled = (): void => {
    if (!passwordBinding) {
      throw httpError('Passkeys require UI password protection to be enabled', 400);
    }
  };

  const getPasskeysForRpId = (store: PasskeyStore, rpID: string): StoredPasskey[] => store.passkeys.filter((passkey) => passkey.rpID === rpID);

  const getStatus = async (req: PasskeyRequest) => {
    const store = await loadStore();
    const rpID = getPasskeyRequestURL(req)?.hostname ?? '';
    return {
      enabled: Boolean(passwordBinding),
      hasPasskeys: rpID.length > 0 && getPasskeysForRpId(store, rpID).length > 0,
      passkeyCount: rpID ? getPasskeysForRpId(store, rpID).length : 0,
      rpID,
    };
  };

  const listPasskeys = async (req: PasskeyRequest, principalId?: string) => {
    assertEnabled();

    const store = await loadStore();
    const rpID = getPasskeyRequestURL(req)?.hostname ?? '';
    if (!rpID) {
      return [];
    }

    return getPasskeysForRpId(store, rpID).filter(p => !principalId || p.principalId === principalId).map((passkey) => ({
      id: passkey.id,
      label: passkey.label,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    }));
  };

  const revokePasskey = async (req: PasskeyRequest, passkeyId: unknown, principalId?: string) => {
    assertEnabled();

    const normalizedPasskeyId = typeof passkeyId === 'string' ? passkeyId.trim() : '';
    if (!normalizedPasskeyId) {
      throw httpError('Passkey ID is required', 400);
    }

    const rpID = getPasskeyRequestURL(req)?.hostname ?? '';
    return mutateStore(async (store) => {
      const existingPasskey = store.passkeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID && (!principalId || passkey.principalId === principalId));
      if (!existingPasskey) {
        throw httpError('Passkey not found for this host', 404);
      }

      store.passkeys = store.passkeys.filter((passkey) => !(passkey.id === normalizedPasskeyId && passkey.rpID === rpID));
      return {
        result: {
          revoked: true,
          passkeyCount: store.passkeys.filter((passkey) => passkey.rpID === rpID).length,
        },
      };
    });
  };

  const clearAllPasskeys = async () => {
    assertEnabled();
    return mutateStore(async (store) => {
      const clearedCount = store.passkeys.length;
      store.passkeys = [];
      return { result: { cleared: true, clearedCount } };
    });
  };

  const beginRegistration = async (req: PasskeyRequest, { label, principalId }: { label?: unknown; principalId?: string } = {}) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const url = getPasskeyRequestURL(req);
    if (!url) {
      throw httpError('Unable to resolve a valid passkey host for this request', 400);
    }
    const rpID = url.hostname;

    const store = await loadStore();
    const userID = principalId ? new TextEncoder().encode(principalId) : decodeUserId(store.userID);
    if (!userID) {
      throw httpError('Passkey storage is invalid. Please try again.', 500);
    }

    const registrationUserID = new Uint8Array(userID.length);
    registrationUserID.set(userID);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: registrationUserID,
      userName: 'varin-ui',
      userDisplayName: 'Varin UI',
      attestationType: 'none',
      excludeCredentials: getPasskeysForRpId(store, rpID).map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    registrationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(url.origin),
      expectedRPIDs: [rpID],
      rpID,
      ...(principalId ? { principalId } : {}),
      label: normalizeLabel(label, 'This device'),
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishRegistration = async (payload: unknown) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const input = asRecord(payload) ?? {};
    const requestId = typeof input.requestId === 'string' ? input.requestId : '';
    const response = input.response as RegistrationResponseJSON;

    const matchingRecord = requestId ? registrationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      throw httpError('Passkey setup has expired. Please try again.', 400);
    }

    registrationChallenges.delete(requestId);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: matchingRecord.challenge,
      expectedOrigin: matchingRecord.expectedOrigins,
      expectedRPID: matchingRecord.expectedRPIDs,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw httpError('Passkey registration could not be verified', 400);
    }

    const {
      credential,
      credentialDeviceType,
      credentialBackedUp,
    } = verification.registrationInfo;

    return mutateStore(async (store) => {
      store.passkeys = store.passkeys.filter((passkey) => passkey.id !== credential.id);
      store.passkeys.push({
        id: credential.id,
        ...(matchingRecord.principalId ? { principalId: matchingRecord.principalId } : {}),
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: Array.isArray(credential.transports)
          ? credential.transports.filter((value): value is AuthenticatorTransport => typeof value === 'string')
          : [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: Date.now(),
        lastUsedAt: null,
        label: matchingRecord.label,
        rpID: matchingRecord.rpID,
      });

      return {
        result: {
          verified: true,
          passkeyCount: store.passkeys.filter((passkey) => passkey.rpID === matchingRecord.rpID).length,
        },
      };
    });
  };

  const beginAuthentication = async (req: PasskeyRequest) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const store = await loadStore();
    const url = getPasskeyRequestURL(req);
    if (!url) {
      throw httpError('Unable to resolve a valid passkey host for this request', 400);
    }
    const rpID = url.hostname;
    const passkeys = getPasskeysForRpId(store, rpID);

    if (passkeys.length === 0) {
      throw httpError('No passkeys are registered for this host yet', 404);
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    authenticationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(url.origin),
      expectedRPIDs: [rpID],
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishAuthentication = async (payload: unknown) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const input = asRecord(payload) ?? {};
    const requestId = typeof input.requestId === 'string' ? input.requestId : '';
    const response = input.response as AuthenticationResponseJSON;
    const matchingRecord = requestId ? authenticationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      throw httpError('Passkey sign-in has expired. Please try again.', 400);
    }

    authenticationChallenges.delete(requestId);
    return mutateStore(async (store) => {
      const passkey = store.passkeys.find((item) => item.id === response?.id);
      if (!passkey) {
        throw httpError('That passkey is not registered for this Varin instance', 404);
      }

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: matchingRecord.challenge,
        expectedOrigin: matchingRecord.expectedOrigins,
        expectedRPID: matchingRecord.expectedRPIDs,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.publicKey, 'base64url'),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.authenticationInfo) {
        throw httpError('Passkey sign-in could not be verified', 400);
      }

      passkey.counter = verification.authenticationInfo.newCounter;
      passkey.lastUsedAt = Date.now();
      return { result: { verified: true, principalId: passkey.principalId } };
    });
  };

  const dispose = (): void => {
    registrationChallenges.clear();
    authenticationChallenges.clear();
  };

  return {
    enabled: Boolean(passwordBinding),
    getStatus,
    listPasskeys,
    revokePasskey,
    clearAllPasskeys,
    beginRegistration,
    finishRegistration,
    beginAuthentication,
    finishAuthentication,
    dispose,
    isLocalRpId,
  };
};
