import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export interface FrpTunnelConfiguration {
  /** Operator-selected installed binary, not a path supplied by a browser. */
  executablePath: string;
  server: { address: string; port: number; tls: { caFile: string; serverName: string } };
  proxy: { name: string; remotePort: number };
  tokenEnv: string;
  publicOrigin: string;
  /** Supplied by the Host's guarded listener owner, never by the requester. */
  backend: { originUrl: string };
}

export type FrpFailureCode = 'invalid_configuration' | 'missing_dependency' | 'missing_credential'
  | 'unsupported_platform' | 'startup_failed' | 'startup_timeout' | 'publish_rejected'
  | 'authentication_failed' | 'tls_failed' | 'connection_lost' | 'process_exit' | 'aborted' | 'cleanup_failed';

export class FrpTunnelError extends Error {
  constructor(readonly code: FrpFailureCode, message: string, readonly retryable = false) {
    super(message);
    this.name = 'FrpTunnelError';
  }
}

export interface FrpTunnelController {
  readonly publicOrigin: string;
  readonly endpointVerification: 'unverified';
  getState(): 'published' | 'disconnected' | 'stopping' | 'stopped';
  /** Resolves only after child close and private-file removal, not kill delivery. */
  stop(): Promise<void>;
  /** Replays a disconnect that occurred before subscription, once per listener. */
  onDisconnect(listener: (error: FrpTunnelError) => void): () => void;
}

export interface FrpChildProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export interface FrpSpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
  cwd: string;
}
export interface FrpTunnelDependencies {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  spawnProcess?: (command: string, args: string[], options: FrpSpawnOptions) => FrpChildProcess;
  fs?: Pick<typeof fsPromises, 'stat' | 'access' | 'mkdtemp' | 'chmod' | 'writeFile' | 'rm'>;
  tempDirectory?: string;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  platform?: NodeJS.Platform;
}

const invalid = () => new FrpTunnelError('invalid_configuration', 'FRP requires a valid fixed server, TCP mapping, trusted TLS configuration, and guarded loopback backend');
const aborted = () => new FrpTunnelError('aborted', 'FRP startup was cancelled');
const validPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
const validHost = (host: unknown): host is string => typeof host === 'string'
  && (isIP(host) !== 0 || /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host));
const absoluteFile = (file: unknown): file is string => typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0');

function normalizeConfiguration(input: FrpTunnelConfiguration) {
  if (!input || !absoluteFile(input.executablePath) || !absoluteFile(input.server?.tls?.caFile)
    || !validHost(input.server?.address) || !validHost(input.server?.tls?.serverName)
    || !validPort(input.server?.port) || !validPort(input.proxy?.remotePort)
    || typeof input.proxy?.name !== 'string' || !/^[a-z\d][a-z\d_.-]*$/i.test(input.proxy.name)
    || typeof input.tokenEnv !== 'string' || !/^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/.test(input.tokenEnv)) throw invalid();
  try {
    const publicUrl = new URL(input.publicOrigin);
    const backend = new URL(input.backend.originUrl);
    const localIP = backend.hostname.replace(/^\[|\]$/g, '');
    const localPort = Number(backend.port || 80);
    if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(input.publicOrigin)
      || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/'
      || !/^http:\/\/[^/?#\\\s]+\/?$/i.test(input.backend.originUrl)
      || backend.username || backend.password || backend.pathname !== '/' || !validPort(localPort)
      || !(localIP === '::1' || (isIP(localIP) === 4 && localIP.startsWith('127.')))) throw invalid();
    return {
      executablePath: input.executablePath, publicOrigin: publicUrl.origin,
      server: { address: input.server.address, port: input.server.port, tls: { ...input.server.tls } },
      proxy: { ...input.proxy }, tokenEnv: input.tokenEnv, localIP, localPort,
    };
  } catch { throw invalid(); }
}

/**
 * One frpc attempt, not a recovery/configuration owner. JSON/tokenSource/TLS and
 * publish/disconnect evidence are checked against official frp v0.65.0 source:
 * https://github.com/fatedier/frp/blob/v0.65.0/conf/frpc_full_example.toml
 * https://github.com/fatedier/frp/blob/v0.65.0/client/control.go
 * https://github.com/fatedier/frp/blob/v0.65.0/client/service.go
 * Unknown log formats fail the bounded readiness wait; no binary version or
 * public HTTPS claim is inferred. No AdminServer or external probe is opened.
 */
export async function startFrpTunnel(
  input: FrpTunnelConfiguration,
  dependencies: FrpTunnelDependencies = {},
): Promise<FrpTunnelController> {
  const config = normalizeConfiguration(input);
  const platform = dependencies.platform ?? process.platform;
  // POSIX modes are not an ACL guarantee on Windows. Do not write a credential
  // there until the Host has an ACL-aware private-file owner.
  if (platform === 'win32') throw new FrpTunnelError('unsupported_platform', 'FRP private credential files require a POSIX Host in this implementation');
  const fs = dependencies.fs ?? fsPromises;
  const env = dependencies.env ?? process.env;
  const signal = dependencies.signal;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 30_000;
  const shutdownGraceMs = dependencies.shutdownGraceMs ?? 3_000;
  if (![startupTimeoutMs, shutdownGraceMs].every(value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647)) throw invalid();
  if (signal?.aborted) throw aborted();
  const token = env[config.tokenEnv];
  if (!token?.trim()) throw new FrpTunnelError('missing_credential', 'The configured Host FRP token environment variable is empty');
  try {
    if (!(await fs.stat(config.executablePath)).isFile()) throw new Error();
    await fs.access(config.executablePath, constants.X_OK);
  } catch { throw new FrpTunnelError('missing_dependency', 'The operator-selected FRP executable is not an executable file'); }
  try {
    if (!(await fs.stat(config.server.tls.caFile)).isFile()) throw new Error();
    await fs.access(config.server.tls.caFile, constants.R_OK);
  } catch { throw new FrpTunnelError('invalid_configuration', 'The provisioned FRP CA file is not readable'); }

  let directory: string | undefined;
  const removeFiles = async () => {
    if (!directory) return;
    try { await fs.rm(directory, { recursive: true, force: true }); }
    catch { throw new FrpTunnelError('cleanup_failed', 'FRP private runtime files could not be removed'); }
  };
  let child: FrpChildProcess;
  try {
    directory = await fs.mkdtemp(path.join(dependencies.tempDirectory ?? os.tmpdir(), 'varin-frpc-'));
    await fs.chmod(directory, 0o700);
    const tokenPath = path.join(directory, 'token');
    const configPath = path.join(directory, 'frpc.json');
    await fs.writeFile(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const document = {
      serverAddr: config.server.address, serverPort: config.server.port, loginFailExit: true,
      auth: { method: 'token', tokenSource: { type: 'file', file: { path: tokenPath } } },
      log: { to: 'console', level: 'debug', disablePrintColor: true },
      transport: { protocol: 'tcp', tls: { enable: true, trustedCaFile: config.server.tls.caFile, serverName: config.server.tls.serverName } },
      proxies: [{ name: config.proxy.name, type: 'tcp', localIP: config.localIP, localPort: config.localPort, remotePort: config.proxy.remotePort }],
    };
    // frpc renders Go templates before JSON decoding. Escape template openers
    // even in innocent filesystem names; the token is never a template input.
    await fs.writeFile(configPath, JSON.stringify(document, null, 2).replaceAll('{{', '\\u007b\\u007b'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (signal?.aborted) throw aborted();
    // Do not pass Host credentials, proxy overrides, or the selected token into
    // the child environment. The explicitly selected binary needs no PATH probe.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of ['LANG', 'LC_ALL', 'TZ', 'TMPDIR']) if (env[key]) childEnv[key] = env[key];
    child = (dependencies.spawnProcess ?? spawn)(config.executablePath, ['-c', configPath], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, cwd: directory,
    });
  } catch (error) {
    await removeFiles();
    if (error instanceof FrpTunnelError) throw error;
    throw new FrpTunnelError('startup_failed', 'FRP could not prepare or launch its private runtime');
  }

  let state: 'starting' | ReturnType<FrpTunnelController['getState']> = 'starting';
  let failure: FrpTunnelError | undefined;
  let ready = false;
  let closed = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(error: FrpTunnelError) => void>();
  const publicationEvent = new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+ )?\\[I\\] \\[(?:client/)?control\\.go:\\d+\\] (?:\\[[a-zA-Z0-9_-]+\\] )?\\[${config.proxy.name.replaceAll('.', '\\.')}\\] start proxy success$`);
  let resolveClosed!: () => void;
  const childClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let resolveReady!: () => void;
  let rejectReady!: (error: FrpTunnelError) => void;
  const published = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Teardown can finish before callers await startup; keep rejection observed.
  void published.catch(() => undefined);

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    state = failure ? 'disconnected' : 'stopping';
    listeners.clear();
    clearTimeout(startupTimer);
    signal?.removeEventListener('abort', onAbort);
    stopPromise = (async () => {
      if (!closed) {
        killTimer = setTimeout(() => { if (!closed) { try { child.kill('SIGKILL'); } catch { /* retain ownership until close */ } } }, shutdownGraceMs);
        try { child.kill('SIGTERM'); } catch { /* escalation and close still own teardown */ }
      }
      await childClosed;
      clearTimeout(killTimer);
      await removeFiles();
      state = 'stopped';
    })();
    // A disconnect starts teardown without an immediate caller. Preserve the
    // same rejecting promise for stop(), without an unhandled rejection.
    void stopPromise.catch(() => undefined);
    return stopPromise;
  };
  const fail = (error: FrpTunnelError) => {
    if (failure || stopping) return;
    failure = error;
    state = 'disconnected';
    rejectReady(error);
    const subscribers = [...listeners];
    listeners.clear();
    for (const listener of subscribers) { try { listener(error); } catch { /* observer does not own this process */ } }
    void stop();
  };
  const onAbort = () => fail(aborted());
  const startupTimer = setTimeout(() => fail(new FrpTunnelError('startup_timeout', 'FRP proxy publication was not confirmed before the startup timeout', true)), startupTimeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  // Only fixed classifications leave this pipe. Never store/return a raw line:
  // remote frps errors and process errors may contain credentials or paths.
  const onLine = (line: string) => {
    if (stopping || closed) return;
    if (/token in login doesn't match|token.*(?:mismatch|invalid|incorrect)|authentication failed|authorization failed/i.test(line)) {
      fail(new FrpTunnelError('authentication_failed', 'FRP authentication was rejected')); return;
    }
    if (/x509:|tls:|certificate verify|certificate signed by unknown/i.test(line)) {
      fail(new FrpTunnelError('tls_failed', 'FRP server TLS authentication failed')); return;
    }
    if (line.includes(`[${config.proxy.name}] start error:`)) {
      fail(new FrpTunnelError('publish_rejected', 'The FRP server rejected the configured TCP mapping')); return;
    }
    if (line.includes('control message dispatcher exited') || line.includes('heartbeat timeout')
      || (ready && line.includes('try to connect to server...'))) {
      fail(new FrpTunnelError('connection_lost', 'The FRP control connection was lost', true)); return;
    }
    if (line.includes('connect to server error:')) {
      // An unknown server rejection is not proof of a transient failure. Let
      // the owner retry only recognizable network errors, not credentials.
      const transient = /dial tcp|timeout|connection refused|connection reset|network is unreachable|no route to host|\bEOF\b/i.test(line);
      fail(new FrpTunnelError(transient ? 'connection_lost' : 'startup_failed', 'FRP could not establish its control connection', transient)); return;
    }
    // This exact info event follows a successful NewProxyResp, not just login.
    // Anchor to the native source/level and the exact configured proxy name.
    if (publicationEvent.test(line)) {
      ready = true; state = 'published'; clearTimeout(startupTimer); resolveReady();
    }
  };
  const cleanStreams: Array<() => void> = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    let dropping = false;
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const part of text.split(/(?<=\n)/)) {
        if (!dropping) buffered += part;
        // Bound private log memory; never reinterpret a truncated suffix as an event.
        if (buffered.length > 16_384) { buffered = ''; dropping = true; }
        if (part.endsWith('\n')) {
          if (!dropping) onLine(buffered.replace(/\r?\n$/, ''));
          buffered = ''; dropping = false;
        }
      }
    };
    stream.on('data', onData);
    cleanStreams.push(() => { stream.off('data', onData); buffered = ''; });
  }
  const onError = () => fail(new FrpTunnelError('startup_failed', 'FRP process execution failed'));
  child.on('error', onError);
  child.once('close', () => {
    closed = true;
    clearTimeout(killTimer);
    for (const clean of cleanStreams) clean();
    child.off('error', onError);
    resolveClosed();
    if (!stopping) fail(new FrpTunnelError('process_exit', ready ? 'FRP stopped after proxy publication' : 'FRP exited before proxy publication', ready));
  });
  if (signal?.aborted) onAbort();
  try {
    await published;
    if (failure) throw failure;
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    publicOrigin: config.publicOrigin,
    endpointVerification: 'unverified',
    getState: () => state === 'starting' ? 'disconnected' : state,
    stop,
    onDisconnect: (listener) => {
      if (failure) { try { listener(failure); } catch { /* observer isolation */ } }
      else if (!stopping && !closed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
