import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  assertSafeBrowserPort,
  resolveConfiguredBindHost,
  buildLocalUrl,
  detectLanIPv4Address,
  formatHostForUrl,
} from './cli-network.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { getDataDir } from './cli-paths.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import { createRemoteClientAuthRuntime } from '#application-host/lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from '#application-host/lib/client-auth/pairing.js';
import { createRelayIdentityRuntime } from '#application-host/lib/relay/identity.js';
import { relayUnavailableMessage, resolveRelayEndpoint } from '#application-host/lib/relay/endpoint.js';
import { bytesToBase64Url } from '#application-host/lib/relay/e2ee.js';
import { createSettingsFileStore } from '@varin/settings-store';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';
import { errorMessage, recordOf, type CliOptions, type ServeCommand } from './cli-types.js';

const REMOTE_CLIENTS_FILE_NAME = 'remote-clients.json';
const SETTINGS_FILE_NAME = 'settings.json';
const PAIRING_SESSIONS_FILE_NAME = 'client-pairing-sessions.json';

// Minimal settings.json read/write for the relay identity runtime. It reads the
// whole object and writes it back with the relay keys added, so other settings
// are preserved. Enough for the CLI without wiring the full settings runtime.
function createSettingsAccessors() {
  const settingsPath = path.join(getDataDir(), SETTINGS_FILE_NAME);
  const store = createSettingsFileStore({ filePath: settingsPath });
  return {
    readSettingsFromDisk: store.read,
    updateSettingsOnDisk: store.update,
  };
}

// Resolves the relay endpoint the same way the running host does (VARIN_RELAY_URL,
// relay/endpoint.ts) and the instance's relay identity (serverId + encryption
// public key, generating it if the relay was never enabled) into a pairing-v2
// relay candidate. Relay is a transport, not a separate link format: the
// candidate carries no token — the client redeems the one-time pairing secret
// over the E2EE tunnel like any other candidate. `enabled` reports whether the
// host relay is on (a relay candidate only connects when the host is relaying);
// `candidate` is null when no relay endpoint is configured.
async function buildRelayPairingCandidate() {
  const accessors = createSettingsAccessors();
  const settings = await accessors.readSettingsFromDisk();
  const enabled = recordOf(settings.privateRelay).enabled === true;
  const endpoint = resolveRelayEndpoint();
  if (endpoint.state !== 'configured') {
    return { enabled, unavailable: relayUnavailableMessage(endpoint), candidate: null };
  }
  const identityRuntime = createRelayIdentityRuntime({ crypto, ...accessors });
  const identity = await identityRuntime.getRelayIdentity();
  return {
    enabled,
    unavailable: null,
    candidate: {
      type: 'relay' as const,
      relayUrl: endpoint.url,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    },
  };
}

// Pairing runtime backed by the same on-disk store the running host reads, so a
// session created here is redeemable by the live server. createPairingSession
// only writes the store (no server needed to mint); redeem is served by the host.
function createCliPairingRuntime() {
  const dataDir = getDataDir();
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, REMOTE_CLIENTS_FILE_NAME),
  });
  return createClientPairingRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, PAIRING_SESSIONS_FILE_NAME),
    remoteClientAuthRuntime,
  });
}

// Mirror of encodePairingConnectionPayload in @varin/ui (the bin cannot
// import the UI package). Keep in sync: v2 payload → base64url(JSON) in the URL
// query, so the one-time secret rides the link, never the network.
function encodePairingConnectUrl(payload: Record<string, unknown>): string {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `varin://connect?v=2&p=${encoded}`;
}

type PairingRecord = Awaited<ReturnType<ReturnType<typeof createClientPairingRuntime>['createPairingSession']>>['pairing'];
type DirectPairingCandidate = { priority: number; type: 'lan' | 'tunnel'; url: string };
type RelayPairingCandidate = {
  hostEncPubJwk: JsonWebKey;
  priority: number;
  relayUrl: string;
  serverId: string;
  type: 'relay';
};
type PairingCandidate = DirectPairingCandidate | RelayPairingCandidate;

function buildPairingPayload({ pairing, label, candidates }: {
  candidates: PairingCandidate[];
  label: string;
  pairing: PairingRecord;
}): Record<string, unknown> {
  return {
    v: 2,
    pairingId: pairing.id,
    secret: pairing.secret,
    ...(label ? { label } : {}),
    ...(pairing.fingerprint ? { fingerprint: pairing.fingerprint } : {}),
    ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
    candidates,
  };
}

async function resolveConnectUrlServerUrl(options: CliOptions & { port: number }): Promise<{
  serverUrl: string;
  source: 'configured-host' | 'lan-detected' | 'loopback-fallback';
}> {
  let hostOverride = options.host;
  if (typeof hostOverride !== 'string' && !process.env.VARIN_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (typeof storedOptions?.host === 'string' && storedOptions.host.trim()) {
      hostOverride = storedOptions.host.trim();
    }
  }

  const bindHost = resolveConfiguredBindHost(hostOverride);

  // A host that's already a full http(s) URL is a public/server URL, not a bind
  // address (e.g. `--host https://devchamber.example.com` for a remote deploy
  // behind a reverse proxy). Use it directly instead of feeding it to
  // buildLocalUrl, which would produce `http://https://...:port`.
  const hostAsServerUrl = normalizeServerUrlForConnection(bindHost);
  if (hostAsServerUrl) {
    return { serverUrl: hostAsServerUrl, source: 'configured-host' };
  }

  if (!isWildcardBindHost(bindHost)) {
    return {
      serverUrl: buildLocalUrl(options.port, '/', hostOverride).replace(/\/+$/, ''),
      source: 'configured-host',
    };
  }

  const lanAddress = await detectLanIPv4Address();
  if (!lanAddress) {
    return {
      serverUrl: buildLocalUrl(options.port, '/').replace(/\/+$/, ''),
      source: 'loopback-fallback',
    };
  }

  return {
    serverUrl: `http://${formatHostForUrl(lanAddress)}:${options.port}`,
    source: 'lan-detected',
  };
}

function isWildcardBindHost(host: unknown): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackServerUrl(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeServerUrlForConnection(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function displayTunnelQrCode(url: string): Promise<void> {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${errorMessage(error)}`);
  }
}

function createConnectUrlCommand({ serveCommand }: { serveCommand: ServeCommand }) {
  return async function connectUrlCommand(options: CliOptions = {}): Promise<void> {
    const port = typeof options.port === 'number' ? options.port : 3000;
    assertSafeBrowserPort(port, { context: 'Varin connect-url' });
    const explicitServerUrl = options.server ? normalizeServerUrlForConnection(options.server) : null;
    if (options.server && !explicitServerUrl) {
      throw new TunnelCliError('Invalid --server URL. Use an http:// or https:// URL.', EXIT_CODE.USAGE_ERROR);
    }
    // Refuse before starting a server: a --relay link without a relay endpoint would not work away from home.
    const relayEndpoint = resolveRelayEndpoint();
    if (options.relay && relayEndpoint.state !== 'configured') {
      throw new TunnelCliError(relayUnavailableMessage(relayEndpoint), EXIT_CODE.AUTH_CONFIG_ERROR);
    }

    const normalizedOptions = { ...options, port };
    const running = await discoverRunningInstances();
    const serverState = running.some((entry) => entry.port === port)
      ? { port, autoStarted: false }
      : await (async () => {
          await serveCommand({
            port,
            explicitPort: true,
            host: options.host,
            uiPassword: options.uiPassword,
            apiOnly: options.apiOnly,
            suppressUnsafePortWarning: true,
            suppressUiPasswordWarning: true,
            suppressStartupSummary: true,
            suppressQuietOutput: true,
          });
          return { port, autoStarted: true };
        })();

    const resolvedServerUrl = explicitServerUrl
      ? { serverUrl: explicitServerUrl, source: 'explicit' }
      : await resolveConnectUrlServerUrl(normalizedOptions);
    const serverUrl = resolvedServerUrl.serverUrl;
    const label = options.name || os.hostname();

    // Direct candidate for the reachable server URL, plus the relay transport as
    // a fallback candidate — one link that works both on the LAN and off-network.
    // Candidate priorities make the client prefer the direct route and try the
    // relay last, mirroring the UI's "Anywhere" pairing. `--relay` opts in even
    // when the host relay is not up yet (the demand-driven lifecycle starts it);
    // otherwise the relay rides along only when it is already enabled.
    const candidates: PairingCandidate[] = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];
    const relay = await buildRelayPairingCandidate();
    const includeRelay = Boolean(relay.candidate) && (options.relay === true || relay.enabled);
    if (includeRelay && relay.candidate) candidates.push(relay.candidate);

    const pairingRuntime = createCliPairingRuntime();
    // Mark relay-carrying sessions like the server route does, so the host's
    // demand-driven relay lifecycle keeps the relay up while the link is pending.
    const usesRelay = candidates.some((candidate) => candidate.type === 'relay');
    const { pairing } = await pairingRuntime.createPairingSession({ label, usesRelay });
    const connectUrl = encodePairingConnectUrl(buildPairingPayload({ pairing, label, candidates }));

    if (isJsonMode(options)) {
      printJson({
        serverUrl,
        connectUrl,
        pairingId: pairing.id,
        fingerprint: pairing.fingerprint,
        expiresAt: pairing.expiresAt,
        candidates,
        autoStarted: serverState.autoStarted,
      });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`${connectUrl}\n`);
      return;
    }

    clackIntro('Varin pairing link');
    if (serverState.autoStarted) {
      logStatus('success', `started Varin on port ${port}`);
    }
    logStatus('success', connectUrl);
    clackLog.info(`Server URL: ${serverUrl}`);
    if (includeRelay && relay.candidate) {
      clackLog.info(`Relay fallback: ${relay.candidate.relayUrl}`);
    } else if (relay.enabled && relay.unavailable) {
      // Paired devices use the relay, but this link cannot carry it.
      logStatus('warning', '[RELAY_UNAVAILABLE]', `${relay.unavailable} This link works only on the direct connection.`);
    }
    if (includeRelay && !relay.enabled) {
      logStatus('info', '[RELAY_STARTING]', 'Relay is not up yet. A running instance starts it within a minute; a stopped instance starts it on next launch.');
    }
    if (pairing.fingerprint) {
      clackLog.info(`Fingerprint: ${pairing.fingerprint}`);
    }
    if (resolvedServerUrl.source === 'lan-detected') {
      clackLog.info('Detected a LAN address because Varin is bound to all interfaces. Use --server to override it.');
    } else if (resolvedServerUrl.source === 'loopback-fallback') {
      clackLog.warn('Varin is bound to all interfaces, but no LAN address was detected. Use --server to provide a reachable URL.');
    } else if (isLoopbackServerUrl(serverUrl)) {
      // The direct candidate points at this machine only — other devices cannot
      // use it. Say so instead of letting a "LAN" link silently not work (or a
      // --relay link silently go relay-only).
      if (options.relay) {
      logStatus('warning', '[LAN_UNREACHABLE]', 'Varin only listens on this machine, so devices will always connect through the relay. Restart with --lan to allow direct home-network connections.');
      } else {
        logStatus('warning', '[LAN_UNREACHABLE]', 'Varin only listens on this machine, so other devices cannot use this link. Restart with --lan, or use --server to provide a reachable URL.');
      }
    }
    clackLog.info('Scan or paste this link into another Varin client. It is single-use and expires.');
    if (options.qr === true) {
      await displayTunnelQrCode(connectUrl);
    }
    clackOutro('pairing link generated');
  };
}

export { createConnectUrlCommand };
