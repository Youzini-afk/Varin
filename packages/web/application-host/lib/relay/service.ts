// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/varin/relay/* management routes.
//
// The endpoint comes only from the operator's VARIN_RELAY_URL (endpoint.ts);
// there is no built-in relay. The server settings file keeps just
// `settings.privateRelay = { enabled }` (same storage precedent as
// tunnels/notifications). Routes are registered with the other Varin feature
// routes and are covered by the same global UI auth gate.
//
// Cross-runtime parity note: relay host mode intentionally targets the web
// server runtime only in v1 (Electron shares this server in-process). The VS
// Code runtime does not host a relay; shared UI must treat these routes as
// web-runtime capabilities.

import express from 'express';
import type cryptoModule from 'node:crypto';
import type { Express } from 'express';

import { RelayUnavailableError, relayUnavailableMessage, resolveRelayEndpoint, type RelayEndpoint } from './endpoint.js';
import { createRelayIdentityRuntime } from './identity.js';
import { startRelayHost } from './host-client.js';
import type { createRelayHostLock } from './host-lock.js';

interface RelaySettings extends Record<string, unknown> {
  privateRelay?: unknown;
  relayEncryptionKey?: unknown;
  relaySigningKey?: unknown;
}

interface RelayConfig {
  enabled: boolean;
  endpoint: RelayEndpoint;
}

type RelayHostClient = ReturnType<typeof startRelayHost>;
type RelayHostLock = ReturnType<typeof createRelayHostLock>;
// `unavailable`: something wants the relay but no usable endpoint is configured.
type RelayServiceState = 'connected' | 'connecting' | 'disabled' | 'reconnecting' | 'standby' | 'unavailable';

interface RelayServiceStatus {
  connectedClients: number;
  lastError: string | null;
  state: RelayServiceState;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDisk: () => Promise<object>,
 *   updateSettingsOnDisk: (mutator: (settings: object) => object) => Promise<object>,
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createRelayService = ({
  crypto,
  readSettingsFromDisk,
  updateSettingsOnDisk,
  getLocalPort,
  // Returns true when any paired device or pending pairing session uses the
  // relay transport. The relay lifecycle is driven purely by this demand.
  hasRelayDemand = async () => false,
  // Per-machine claim (host-lock.js): all local instances share the same
  // serverId, so only ONE process may run the relay host at a time or they
  // evict each other at the relay worker ("Control replaced") and devices land
  // on a random instance. Optional: without it, behavior is pre-lock.
  hostLock = null,
  // The relay endpoint, read on every use. Injectable for tests.
  resolveEndpoint = () => resolveRelayEndpoint(),
  logger = console,
}: {
  crypto: typeof cryptoModule;
  getLocalPort: () => number;
  hasRelayDemand?: () => Promise<boolean>;
  hostLock?: RelayHostLock | null;
  logger?: Pick<Console, 'info' | 'warn'>;
  readSettingsFromDisk: () => Promise<RelaySettings>;
  resolveEndpoint?: () => RelayEndpoint;
  updateSettingsOnDisk: (
    mutator: (settings: RelaySettings) => RelaySettings,
  ) => Promise<RelaySettings>;
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDisk, updateSettingsOnDisk });

  let hostClient: RelayHostClient | null = null;
  let status: RelayServiceStatus = { state: 'disabled', lastError: null, connectedClients: 0 };
  // Re-checks the claim while enabled: a standby instance takes over when the
  // claimant dies; a running host stands down when another process claims.
  let claimWatchTimer: ReturnType<typeof setInterval> | null = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;

  const readConfig = async (): Promise<RelayConfig> => {
    const settings = await readSettingsFromDisk();
    const stored = asRecord(settings.privateRelay);
    return { enabled: stored?.enabled === true, endpoint: resolveEndpoint() };
  };

  // Only the enabled flag is stored; the endpoint always comes from the environment.
  const writeEnabled = async (enabled: boolean): Promise<void> => {
    await updateSettingsOnDisk((settings) => ({ ...settings, privateRelay: { enabled } }));
  };

  const stopHostClient = (): void => {
    if (!hostClient) return;
    hostClient.stop();
    hostClient = null;
  };

  const standbyStatus = (holderPid: number | null): RelayServiceStatus => ({
    state: 'standby',
    lastError: `relay host is owned by another local Varin process (pid ${holderPid})`,
    connectedClients: 0,
  });

  // Paired devices or a pending link want the relay, but there is nowhere to
  // connect. Said once per change, not on every reconcile tick.
  const markUnavailable = (endpoint: Exclude<RelayEndpoint, { state: 'configured' }>): void => {
    const message = relayUnavailableMessage(endpoint);
    if (status.state !== 'unavailable' || status.lastError !== message) {
      logger.warn(`[Relay] ${message}`);
    }
    status = { state: 'unavailable', lastError: message, connectedClients: 0 };
  };

  // Claim watcher, active while the relay is enabled:
  //   - standby → claimant died → take over (start our host);
  //   - running → another live process claimed → stand down (stop, standby).
  // This back-off is what actually ends the mutual-eviction fight: the loser
  // must STOP reconnecting, otherwise both keep replacing each other forever.
  const ensureClaimWatch = (relayUrl: string): void => {
    if (!hostLock || claimWatchTimer) return;
    claimWatchTimer = setInterval(() => {
      void (async () => {
        try {
          if (hostClient) {
            if (!hostLock.holdsClaim() && hostLock.liveClaimantPid() !== null) {
              logger.warn('[Relay] host claim taken by another local instance — standing down');
              const holder = hostLock.liveClaimantPid();
              stopHostClient();
              status = standbyStatus(holder);
            }
            return;
          }
          if (status.state === 'standby' && hostLock.tryClaim()) {
            logger.warn('[Relay] host claim is free — taking over the relay host');
            await start(relayUrl);
          }
        } catch (error) {
          logger.warn(`[Relay] claim watch failed: ${errorMessage(error, 'unknown error')}`);
        }
      })();
    }, CLAIM_WATCH_INTERVAL_MS);
    if (typeof claimWatchTimer.unref === 'function') claimWatchTimer.unref();
  };

  const stopClaimWatch = (): void => {
    if (!claimWatchTimer) return;
    clearInterval(claimWatchTimer);
    claimWatchTimer = null;
  };

  async function start(relayUrl: string, { claim = 'try' }: { claim?: 'force' | 'try' } = {}): Promise<void> {
    if (hostClient) return;
    if (hostLock) {
      const claimed = claim === 'force' ? hostLock.forceClaim() : hostLock.tryClaim();
      if (!claimed) {
        status = standbyStatus(hostLock.liveClaimantPid());
        ensureClaimWatch(relayUrl);
        return;
      }
    }
    const identity = await identityRuntime.getRelayIdentity();
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onStatus: (next) => {
        status = next;
      },
    });
    status = hostClient.getStatus();
    ensureClaimWatch(relayUrl);
  }

  const stop = (): void => {
    stopClaimWatch();
    stopHostClient();
    if (hostLock) hostLock.release();
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  // Start the host when the relay is wanted and has an endpoint; otherwise
  // report why it cannot run instead of dialing anywhere.
  const startForConfig = async (config: RelayConfig, options?: { claim?: 'force' | 'try' }): Promise<void> => {
    if (config.endpoint.state !== 'configured') {
      if (hostClient || claimWatchTimer) stop();
      markUnavailable(config.endpoint);
      return;
    }
    await start(config.endpoint.url, options);
  };

  const startIfEnabled = async (): Promise<void> => {
    try {
      const config = await readConfig();
      if (config.enabled) await startForConfig(config);
    } catch (error) {
      logger.warn(`[Relay] startup failed: ${errorMessage(error, 'unknown error')}`);
    }
  };

  // Drive the relay lifecycle from demand: run it when a device or pending
  // session uses the relay, stop it when none remain. Called on startup and after
  // pairing/device changes, so the operator never toggles it manually.
  const reconcile = async (): Promise<void> => {
    try {
      const demand = await hasRelayDemand();
      const config = await readConfig();
      if (demand) {
        if (!config.enabled) await writeEnabled(true);
        if (!hostClient) await startForConfig(config);
      } else {
        if (config.enabled) await writeEnabled(false);
        stop();
      }
    } catch (error) {
      logger.warn(`[Relay] reconcile failed: ${errorMessage(error, 'unknown error')}`);
    }
  };

  // Stable server identity (base64url SHA-256 of the canonical public signing
  // JWK). Derived from a public key, so it is not a secret; clients use it to
  // verify that a learned/probed address belongs to this server before trusting
  // it. Independent of whether the relay host is currently enabled.
  const getServerId = async (): Promise<string> => {
    const identity = await identityRuntime.getRelayIdentity();
    return identity.serverId;
  };

  const getStatus = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    const endpoint = config.endpoint;
    // Without a host client the service is off, standing by while another local
    // process owns the machine's relay host claim, or unable to run at all.
    const state: RelayServiceState = hostClient
      ? live.state
      : endpoint.state !== 'configured' && config.enabled
        ? 'unavailable'
        : status.state === 'standby' ? 'standby' : 'disabled';
    const lastError = endpoint.state !== 'configured' ? relayUnavailableMessage(endpoint) : live.lastError;
    return {
      enabled: config.enabled,
      state,
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      endpoint: endpoint.state,
      relayUrl: endpoint.state === 'configured' ? endpoint.url : null,
      ...(lastError ? { lastError } : {}),
    };
  };

  // Pairing candidate for the unified connection payload (pairing v2). Relay is
  // just another transport: it carries the relay route + E2EE trust anchor, no
  // embedded token — the client redeems the one-time pairing secret over the
  // tunnel like any other candidate. Priority is high (tried after LAN/tunnel)
  // since the relay path is the last-resort transport.
  const buildPairingCandidate = async (relayUrl: string) => {
    const identity = await identityRuntime.getRelayIdentity();
    return {
      type: 'relay',
      relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    };
  };

  // Null when the host relay is off or has no endpoint, so callers only
  // advertise relay when it can actually be reached.
  const getPairingCandidate = async () => {
    const config = await readConfig();
    if (!config.enabled || config.endpoint.state !== 'configured') return null;
    return buildPairingCandidate(config.endpoint.url);
  };

  // Enable the relay host on demand and return its pairing candidate. Creating a
  // relay pairing link IS the demand signal, so the relay turns itself on here
  // rather than requiring a separate manual toggle. Idempotent: a no-op when the
  // relay is already enabled and running. Without an endpoint it refuses
  // (RelayUnavailableError) and changes nothing.
  const ensureEnabledForPairing = async () => {
    const config = await readConfig();
    if (config.endpoint.state !== 'configured') throw new RelayUnavailableError(config.endpoint);
    if (!config.enabled) await writeEnabled(true);
    // Force-claim: creating a pairing link is explicit user intent — the
    // instance the user is pairing against MUST be the one devices reach,
    // even if another local process currently holds the machine's claim
    // (its claim watcher sees the takeover and stands down).
    if (!hostClient) await start(config.endpoint.url, { claim: 'force' });
    return buildPairingCandidate(config.endpoint.url);
  };

  const registerRoutes = (app: Express): void => {
    app.get('/api/varin/relay/status', async (_req, res) => {
      try {
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to read relay status') });
      }
    });

    app.post('/api/varin/relay/enable', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'relayUrl')) {
          res.status(400).json({ error: 'The relay endpoint is set on the server with VARIN_RELAY_URL, not through this route.' });
          return;
        }
        const current = await readConfig();
        if (current.endpoint.state !== 'configured') {
          const failure = new RelayUnavailableError(current.endpoint);
          res.status(409).json({ error: failure.message, code: failure.code });
          return;
        }
        await writeEnabled(true);
        if (hostClient) stop();
        // Explicit user action: take the machine's host claim like pairing does.
        await start(current.endpoint.url, { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to enable relay') });
      }
    });

    app.post('/api/varin/relay/disable', async (_req, res) => {
      try {
        await writeEnabled(false);
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to disable relay') });
      }
    });

  };

  return {
    registerRoutes,
    startIfEnabled,
    reconcile,
    stop,
    getStatus,
    getServerId,
    getPairingCandidate,
    ensureEnabledForPairing,
  };
};
