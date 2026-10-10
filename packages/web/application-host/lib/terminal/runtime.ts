import { TERMINAL_PROTOCOL_VERSION } from '@varin/application-client';
import { ManagedProcessLaunchError, managedExitConfirmed } from "../process/types.js";
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Express, Request, Response } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type fsModule from 'node:fs';
import type pathModule from 'node:path';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { createTerminalShellResolver, getTerminalShellLoginArgs, normalizeTerminalShell } from './shells.js';
import { createShellIntegrationParser } from './shell-integration.js';
import { shellIntegrationLaunch } from './shell-integration-scripts.js';
import { createWorkspaceConfig, ensureWorkspaceRoot } from '../workspace/workspace-config.js';
import { assertAbsolutePathInWorkspace, resolveWorkspacePath } from '../workspace/path-safety.js';
import { resolveLinuxPtyLaunch, stripAppImageArgv0Leak } from '../platform/inherited-env.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { TerminalShellPreference } from './shells.js';
import type {
  CreateTerminalSessionInput,
  AdoptTerminalSessionInput,
  TerminalProcess,
  TerminalCommandRecord,
  TerminalHandle,
  TerminalSessionApi,
  TerminalSessionInfo,
  TerminalSessionOwner,
  TerminalSpawnSpec,
} from './session-api.js';

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const validateSize = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;

type ProcessWriter = Awaited<ReturnType<DocumentAuthority['registerWriterForScope']>>;

interface WriterState {
  released: boolean;
  writer: ProcessWriter;
  releasePromise?: Promise<void>;
}

type PtyProcess = TerminalProcess;

interface PtyProvider {
  backend: string;
  spawn(executable: string, args: string[], options: Record<string, unknown>): PtyProcess | Promise<PtyProcess>;
}

type TerminalEvent =
  | { data: string; process: PtyProcess; type: 'output'; writerState: WriterState }
  | { error: Error; process: PtyProcess; type: 'unavailable'; writerState: WriterState }
  | { exitCode: number | null; process: PtyProcess; signal: number; type: 'exit'; writerState: WriterState };

interface TerminalSession {
  backend?: string;
  closing: boolean;
  cols: number;
  cwd: string;
  commandListeners: Set<(event: TerminalCommandRecord) => void>;
  dataListeners: Set<(data: string) => void>;
  draining: boolean;
  integrationGeneration: number;
  integrationParser: ReturnType<typeof createShellIntegrationParser>;
  eventQueue: TerminalEvent[];
  failure: Error | null;
  errorListeners: Set<(error: Error) => void>;
  exitCode: number | null;
  exitListeners: Set<(event: { exitCode: number | null; signal: number }) => void>;
  history: string;
  id: string;
  lastActivity: number;
  loginShell: boolean;
  owner: TerminalSessionOwner;
  creationSource: 'http' | 'programmatic' | 'adopted';
  processIdentity?: AdoptTerminalSessionInput['identity'];
  pendingHistoryControlSequence: string;
  pendingThemeControlSequence: string;
  process: PtyProcess | null;
  registerProcessWriter: boolean;
  retainWhenDetached: boolean;
  rows: number;
  sequence: number;
  shell: TerminalShellPreference;
  signal: number | null;
  spawn?: TerminalSpawnSpec;
  status: 'exited' | 'running' | 'error';
  terminalBackground: string;
  terminalForeground: string;
  themeMode: 'dark' | 'light';
  themeModeEnabled: boolean;
  writerGeneration: number;
  writerState: WriterState | null;
  writerReleasePromise?: Promise<void>;
}

interface TerminalAttachment {
  initializing: boolean;
  pending: Array<Record<string, unknown>>;
}

interface TerminalConnection {
  attachments: Map<string, TerminalAttachment>;
  socket: WebSocket;
}

interface TerminalRuntimeDependencies {
  app: Express;
  buildAugmentedPath: () => string;
  documents?: Pick<DocumentAuthority, 'registerWriterForScope'>;
  fs: typeof fsModule;
  isExecutable(path: string): boolean;
  isRequestOriginAllowed(req: IncomingMessage): Promise<boolean>;
  inspectNativeProcesses?: (cwd: string) => Promise<import("../kernel/protocol.generated.js").KernelProcessSnapshot[]>;
  loadPtyProvider?: () => Promise<PtyProvider>;
  path: typeof pathModule;
  rejectWebSocketUpgrade(socket: Duplex, statusCode: number, message: string): void;
  searchPathFor(name: string, searchPath: string): string | null;
  server: Server;
  TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: number;
  terminalIdleSweepMs?: number;
  terminalIdleTimeoutMs?: number;
  terminalTerminationGraceMs?: number;
  uiAuthController?: {
    enabled: boolean;
    ensureSessionToken(req: IncomingMessage, res: null): Promise<string | null>;
  } | null;
}

type SessionCreationSource = 'http' | 'programmatic' | 'adopted';

type SessionCreationIdentity = {
  owner: TerminalSessionOwner;
  creationSource: SessionCreationSource;
  loginShell: boolean;
  registerProcessWriter: boolean;
  retainWhenDetached: boolean;
  shell: TerminalShellPreference;
  spawn?: TerminalSpawnSpec;
};

interface StartSessionInput {
  cols: number;
  cwd: string;
  injectIntegration?: boolean;
  integrationId?: string;
  loginShell: boolean;
  rows: number;
  shell: TerminalShellPreference;
  spawn?: TerminalSpawnSpec;
  terminalBackground?: unknown;
  terminalForeground?: unknown;
  themeMode?: unknown;
}

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const errorMessage = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback;

const isTerminalSpawnSpec = (value: unknown): value is TerminalSpawnSpec => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.executable !== 'string' || !record.executable.trim()) return false;
  if (!Array.isArray(record.args) || record.args.some((entry) => typeof entry !== 'string')) return false;
  if (record.env !== undefined) {
    if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) return false;
    if (Object.values(record.env).some((entry) => typeof entry !== 'string')) return false;
  }
  return true;
};

const sameSpawnSpec = (left: TerminalSpawnSpec | undefined, right: TerminalSpawnSpec | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right || left.executable !== right.executable || left.args.length !== right.args.length) return false;
  if (left.args.some((arg, index) => arg !== right.args[index])) return false;
  const leftEnv = left.env ?? {};
  const rightEnv = right.env ?? {};
  const leftKeys = Object.keys(leftEnv);
  const rightKeys = Object.keys(rightEnv);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => leftEnv[key] === rightEnv[key]);
};

const sameCreationIdentity = (
  left: SessionCreationIdentity,
  right: SessionCreationIdentity,
): boolean => left.owner === right.owner
  && left.creationSource === right.creationSource
  && left.loginShell === right.loginShell
  && left.registerProcessWriter === right.registerProcessWriter
  && left.retainWhenDetached === right.retainWhenDetached
  && left.shell === right.shell
  && sameSpawnSpec(left.spawn, right.spawn);

const sessionIdentityConflict = (id: string): Error & { statusCode: number } => {
  const error = new Error(`Terminal session ${id} already exists with a different owner or creation identity`) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
};

const exitedSessionConflict = (id: string): Error & { statusCode: number } => {
  const error = new Error(`Terminal session ${id} has exited; close it before reusing the id`) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
};

const releaseProcessWriter = async (writer: ProcessWriter, mutated = true): Promise<void> => {
  if (!writer) return;
  if (mutated) {
    try { await writer.markMutated(); } catch { /* authority may already be gone */ }
  }
  try { await writer.close(); } catch { /* authority may already be gone */ }
};

const trimHistory = (history: string): string => {
  const bytes = Buffer.from(history);
  if (bytes.byteLength <= MAX_HISTORY_BYTES) return history;
  let start = bytes.byteLength - MAX_HISTORY_BYTES;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
};

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, inspectNativeProcesses, terminalTerminationGraceMs = TERMINATION_GRACE_MS,
  terminalIdleTimeoutMs = IDLE_TIMEOUT_MS,
  terminalIdleSweepMs = 5 * 60 * 1000,
  documents,
}: TerminalRuntimeDependencies) {
  const sessions = new Map<string, TerminalSession>();
  let shuttingDown = false;
  const pendingSessionCreates = new Map<string, SessionCreationIdentity & {
    cwd: string;
    promise: Promise<TerminalSession>;
  }>();
  const pendingSessionRestarts = new Map<string, Promise<void>>();
  const connections = new Set<TerminalConnection>();
  const commandObservers = new Set<(event: TerminalCommandRecord) => void>();
  const pendingTerminations = new Set<Promise<void>>();
  const runtime = 'Bun' in globalThis ? 'bun' : 'node';
  let ptyProviderPromise: Promise<PtyProvider> | null = null;
  let nextHarnessSessionId = 0;
  let wsServer: WebSocketServer | null = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });

  const acquireWriter = async (
    scopeId: unknown,
    owner: Parameters<DocumentAuthority['registerWriterForScope']>[1],
  ): Promise<ProcessWriter> => {
    const options = { mode: 'process', purpose: 'terminal-process' };
    if (typeof documents?.registerWriterForScope === 'function') {
      return documents.registerWriterForScope(scopeId, owner, options);
    }
    return null;
  };

  const releaseWriterState = (state: WriterState | null, mutated = true): Promise<void> => {
    if (!state || state.released) return state?.releasePromise ?? Promise.resolve();
    if (state.releasePromise) return state.releasePromise;
    state.released = true;
    const writer = state.writer;
    state.writer = null;
    state.releasePromise = releaseProcessWriter(writer, mutated);
    return state.releasePromise;
  };

  const getPtyProvider = async (): Promise<PtyProvider> => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = loadPtyProvider ? loadPtyProvider() : (async () => {
        throw new Error("Native kernel PTY provider is unavailable; no Host PTY fallback is installed");
      })();
    }
    return ptyProviderPromise;
  };

  const spawnExplicit = async ({ cwd, cols, rows, themeMode, spawn }: StartSessionInput & { spawn: TerminalSpawnSpec }) => {
    const provider = await getPtyProvider();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...spawn.env,
      PATH: spawn.env?.PATH ?? buildAugmentedPath(),
      TERM: spawn.env?.TERM ?? 'xterm-256color',
      COLORTERM: spawn.env?.COLORTERM ?? 'truecolor',
      COLORFGBG: themeMode === 'light' ? '0;15' : '15;0',
    };
    env.NODE_CHANNEL_FD = '';
    delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
    stripAppImageArgv0Leak(env);
    const launch = resolveLinuxPtyLaunch(spawn.executable, spawn.args);
    const options = { name: 'xterm-256color', cwd, cols, rows, env, ...(process.platform === 'win32' ? { useConpty: true } : {}) };
    return { process: await provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: 'auto' as TerminalShellPreference, loginShell: false };
  };

  const spawnPty = async (input: StartSessionInput) => {
    if (input.spawn) return spawnExplicit(input as StartSessionInput & { spawn: TerminalSpawnSpec });
    const { cwd, cols, rows, themeMode, shell, loginShell } = input;
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell);
    let lastError: unknown = null;
    for (const executable of resolvedShell.executables) {
      const args = loginShell ? getTerminalShellLoginArgs(executable) : [];
      if (!args) throw new Error(`Terminal shell "${resolvedShell.id}" does not support login mode`);
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: buildAugmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        // The daemon's IPC fd is closed inside the PTY. An explicit override is
        // never forwarded into a native child as an inherited Node IPC channel.
        env.NODE_CHANNEL_FD = '';
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        stripAppImageArgv0Leak(env);
        const integration = input.injectIntegration && input.integrationId
          ? shellIntegrationLaunch(executable, args, loginShell, input.integrationId)
          : null;
        if (integration) Object.assign(env, integration.env);
        const launch = resolveLinuxPtyLaunch(executable, integration?.args ?? args);
        const options = { name: 'xterm-256color', cwd, cols, rows, env, ...(process.platform === 'win32' ? { useConpty: true } : {}) };
        return { process: await provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, loginShell };
      } catch (error) {
        if (error instanceof ManagedProcessLaunchError && (error.child.pid !== undefined || !managedExitConfirmed(error.child))) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess: PtyProcess | null, force = false): void => {
    if (!ptyProcess) return;
    const pid = ptyProcess.pid;
    if (!ptyProcess.native && process.platform !== 'win32' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { /* already gone */ }
  };

  const terminateProcess = (ptyProcess: PtyProcess | null, force = false, waitForExit = false): Promise<void> => {
    if (!ptyProcess) return Promise.resolve();
    if (ptyProcess.terminate && ptyProcess.completion) {
      const nativeTermination = (async () => {
        await ptyProcess.terminate!(force);
        // The Rust guardian owns escalation, process-tree drain, and the
        // durable exit receipt. Its completion is already bounded and rejects
        // on authority loss, so a shorter Host timer would only invent an
        // unconfirmed exit while the guardian is still proving the real one.
        await ptyProcess.completion;
      })();
      const tracked = nativeTermination.finally(() => pendingTerminations.delete(tracked));
      pendingTerminations.add(tracked);
      return tracked;
    }
    if (force && !waitForExit) { killProcess(ptyProcess, true); return Promise.resolve(); }
    const completion = new Promise<void>((resolve, reject) => {
      let settled = false;
      let disposable: { dispose?(): void } | null = null;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        killProcess(ptyProcess, true);
        if (waitForExit) finish(new Error('Terminal process did not exit after termination'));
        else finish();
      }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); }
      catch (error) {
        if (waitForExit) finish(error);
      }
      killProcess(ptyProcess, force);
    });
    if (waitForExit) {
      const waited = completion.then(() => undefined);
      const termination = waited.finally(() => pendingTerminations.delete(termination));
      pendingTerminations.add(termination);
      return termination;
    }
    const termination = completion.finally(() => pendingTerminations.delete(termination));
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket: WebSocket, message: unknown): boolean => {
    if (socket?.readyState !== 1) return false;
    try { socket.send(createTerminalWsControlFrame(message), { binary: true }); return true; } catch { return false; }
  };

  const closeAttachments = (sessionId: string, code: string, message: string): void => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session: TerminalSession): Record<string, unknown> => ({
    t: 'snapshot', v: TERMINAL_PROTOCOL_VERSION, s: session.id, q: session.sequence, history: session.history,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    runtime, ptyBackend: session.backend,
  });

  const publish = (session: TerminalSession, event: Record<string, unknown>): void => {
    session.sequence += 1;
    const message = { ...event, v: TERMINAL_PROTOCOL_VERSION, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const interactionFailure = (session: TerminalSession, process: PtyProcess, error: unknown): void => {
    if (session.process !== process || !session.writerState) return;
    session.eventQueue.push({ type: 'unavailable', process, writerState: session.writerState,
      error: error instanceof Error ? error : new Error(String(error)) });
    drainEvents(session);
  };
  const writeSession = async (session: TerminalSession, data: string, operationId?: string): Promise<void> => {
    const process = session.process;
    if (session.status !== 'running' || !process) throw new Error('Terminal is not running');
    try { await process.write(data, operationId); session.lastActivity = Date.now(); }
    catch (error) { interactionFailure(session, process, error); throw error; }
  };

  const drainEvents = (session: TerminalSession): void => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (!event) break;
        if (event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) void writeSession(session, response).catch(() => undefined);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          session.history = trimHistory(session.history + sanitized.visible);
          session.lastActivity = Date.now();
          publish(session, { t: 'output', d: event.data, ...(sanitized.visible !== event.data ? { r: sanitized.visible } : {}) });
          for (const listener of session.dataListeners) listener(event.data);
          if (session.owner === 'user') {
            for (const observation of session.integrationParser.consume(event.data)) {
              const record: TerminalCommandRecord = { ...observation, owner: session.owner };
              for (const listener of session.commandListeners) listener(record);
              for (const listener of commandObservers) listener(record);
            }
          }
        } else if (event.type === 'unavailable') {
          session.status = 'error'; session.failure = event.error;
          // No exit receipt: keep the process and writer, reject waiters and
          // show an explicit error without manufacturing command completion.
          publish(session, { ...snapshot(session), t: 'snapshot' });
          publish(session, { t: 'error', code: 'PROCESS_UNAVAILABLE', message: event.error.message, fatal: false });
          for (const listener of [...session.errorListeners]) listener(event.error);
        } else {
          session.status = 'exited';
          session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = Number.isInteger(event.signal) ? event.signal : null;
          session.process = null;
          if (session.writerState === event.writerState) session.writerState = null;
          session.writerReleasePromise = releaseWriterState(event.writerState);
          void session.writerReleasePromise;
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
          const exitEvent = { exitCode: session.exitCode, signal: session.signal ?? 0 };
          const listeners = [...session.exitListeners];
          session.exitListeners.clear();
          for (const listener of listeners) listener(exitEvent);
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session: TerminalSession, ptyProcess: PtyProcess, writerState: WriterState): void => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, writerState, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, writerState, exitCode, signal }); drainEvents(session); });
    void ptyProcess.completion?.catch((cause: unknown) => {
      const error = new Error('Native terminal state is unavailable; command outcome and process exit are unconfirmed', { cause });
      session.eventQueue.push({ type: 'unavailable', process: ptyProcess, writerState, error }); drainEvents(session);
    });
  };

  const resolveTerminalWorkingDirectory = async ({ cwd, workspacePath }: {
    cwd?: unknown;
    workspacePath?: unknown;
  }): Promise<string> => {
    const config = createWorkspaceConfig({ env: process.env, pathModule: path });

    if (workspacePath !== undefined && workspacePath !== null) {
      await ensureWorkspaceRoot(config, fs.promises);
      const resolved = await resolveWorkspacePath(String(workspacePath), {
        root: config.root,
        fsPromises: fs.promises,
        pathModule: path,
      });
      const stats = await fs.promises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) throw new Error('Invalid working directory: not a directory');
      return resolved.absolutePath;
    }

    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    if (config.lockdown) {
      const resolved = await assertAbsolutePathInWorkspace(String(cwd), {
        root: config.root,
        fsPromises: fs.promises,
        pathModule: path,
      });
      const stats = await fs.promises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) throw new Error('Invalid working directory: not a directory');
      return resolved.absolutePath;
    }

    const resolvedCwd = path.resolve(String(cwd));
    const stats = await fs.promises.stat(resolvedCwd).catch(() => null);
    if (!stats?.isDirectory()) throw new Error('Invalid working directory');
    return resolvedCwd;
  };

  const validateCwd = async (cwd: string): Promise<void> => {
    const stats = await fs.promises.stat(cwd).catch(() => null);
    if (!stats?.isDirectory()) throw new Error('Invalid working directory');
  };

  const spawnSessionProcess = async (session: TerminalSession, {
    cwd, cols, rows, themeMode, shell, loginShell,
  }: StartSessionInput) => {
    const generation = (session.writerGeneration ?? 0) + 1;
    const writerState: WriterState = { writer: null, released: false };
    const injectIntegration = session.owner === 'user' && !session.spawn;
    const nextIntegrationGeneration = injectIntegration ? session.integrationGeneration + 1 : undefined;
    let spawned: Awaited<ReturnType<typeof spawnPty>> | null = null;
    try {
      if (session.registerProcessWriter) {
        writerState.writer = await acquireWriter(cwd, {
          kind: 'terminal',
          id: session.id,
          generation,
        });
      }
      spawned = await spawnPty({
        cwd, cols, rows, themeMode, shell, loginShell,
        injectIntegration,
        ...(injectIntegration && nextIntegrationGeneration !== undefined
          ? { integrationId: `${session.id}:${nextIntegrationGeneration}` }
          : {}),
        ...(session.spawn ? { spawn: session.spawn } : {}),
      });
      return { ...spawned, writerState, generation, nextIntegrationGeneration };
    } catch (error) {
      await releaseWriterState(writerState, Boolean(spawned));
      throw error;
    }
  };

  const commitIntegrationGeneration = (
    session: TerminalSession,
    nextIntegrationGeneration: number | undefined,
  ): void => {
    if (nextIntegrationGeneration === undefined) return;
    session.integrationGeneration = nextIntegrationGeneration;
    session.integrationParser.reset(session.integrationGeneration);
  };

  const applyAppearance = (session: TerminalSession, { themeMode, terminalBackground, terminalForeground }: {
    terminalBackground?: unknown;
    terminalForeground?: unknown;
    themeMode?: unknown;
  }): void => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (typeof terminalBackground === 'string') session.terminalBackground = terminalBackground;
    if (typeof terminalForeground === 'string') session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      void writeSession(session, terminalThemeModeReport(session.themeMode)).catch(() => undefined);
    }
  };

  const startSession = async (session: TerminalSession, {
    cwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell,
  }: StartSessionInput, clear = true): Promise<void> => {
    await validateCwd(cwd);
    const spawned = await spawnSessionProcess(session, { cwd, cols, rows, themeMode, shell, loginShell });
    if (clear) { session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; }
    session.cwd = cwd; session.cols = cols; session.rows = rows; session.process = spawned.process;
    session.writerState = spawned.writerState; session.writerGeneration = spawned.generation;
    delete session.writerReleasePromise;
    session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.status = 'running'; session.failure = null; session.exitCode = null; session.signal = null;
    session.themeMode = themeMode === 'light' ? 'light' : 'dark';
    session.terminalBackground = typeof terminalBackground === 'string' ? terminalBackground : session.terminalBackground;
    session.terminalForeground = typeof terminalForeground === 'string' ? terminalForeground : session.terminalForeground;
    session.lastActivity = Date.now(); session.eventQueue.length = 0;
    commitIntegrationGeneration(session, spawned.nextIntegrationGeneration);
    wire(session, spawned.process, spawned.writerState);
  };

  const userSessionCount = (): number => {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.owner === 'user') count += 1;
    }
    for (const pending of pendingSessionCreates.values()) {
      if (pending.owner === 'user') count += 1;
    }
    return count;
  };

  const allocateHarnessSessionId = (): string => {
    let id = '';
    do {
      id = `sh_${++nextHarnessSessionId}`;
    } while (sessions.has(id) || pendingSessionCreates.has(id));
    return id;
  };

  const sessionState = (id: string, resolvedCwd: string, cols: number, rows: number,
    creationIdentity: SessionCreationIdentity, themeMode: unknown): TerminalSession => {
    const { owner, creationSource, loginShell, registerProcessWriter, retainWhenDetached, shell: normalizedShell, spawn } = creationIdentity;
  return {
      id,
      cols,
      cwd: resolvedCwd,
      commandListeners: new Set(),
      dataListeners: new Set(),
      integrationGeneration: 0,
      integrationParser: createShellIntegrationParser({ terminalId: id }),
      sequence: 0,
      history: '',
      pendingHistoryControlSequence: '',
      pendingThemeControlSequence: '',
      eventQueue: [],
      draining: false,
      exitCode: null,
      failure: null,
      errorListeners: new Set(),
      exitListeners: new Set(),
      closing: false,
      lastActivity: Date.now(),
      loginShell,
      owner,
      creationSource,
      process: null,
      registerProcessWriter,
      retainWhenDetached,
      rows,
      shell: normalizedShell,
      signal: null,
      ...(spawn ? { spawn } : {}),
      status: 'exited',
      terminalBackground: '',
      terminalForeground: '',
      themeMode: themeMode === 'light' ? 'light' : 'dark',
      themeModeEnabled: false,
      writerState: null,
      writerGeneration: 0,
    };
  };

  const createSession = async (
    value: unknown,
    options: { allowSpawn?: boolean; creationSource?: SessionCreationSource } = {},
  ): Promise<TerminalSession> => {
    if (shuttingDown) throw new Error("Terminal runtime is shutting down");
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { sessionId, cwd, workspacePath, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false } = input;
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
    const owner: TerminalSessionOwner = options.allowSpawn && input.owner === 'harness' ? 'harness' : 'user';
    const registerProcessWriter = owner === 'user'
      ? input.registerProcessWriter !== false
      : input.registerProcessWriter === true;
    const spawn = options.allowSpawn && isTerminalSpawnSpec(input.spawn) ? input.spawn : undefined;
    const normalizedShell = spawn ? 'auto' : normalizeTerminalShell(shell);
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    const creationSource = options.creationSource ?? 'programmatic';
    const retainWhenDetached = options.allowSpawn === true && (input.retainWhenDetached === true || owner === 'harness');
    const creationIdentity: SessionCreationIdentity = {
      owner,
      creationSource,
      loginShell,
      registerProcessWriter,
      retainWhenDetached,
      shell: normalizedShell,
      ...(spawn ? { spawn } : {}),
    };
    const id = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : owner === 'harness' ? allocateHarnessSessionId() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    const existing = sessions.get(id);
    const resolvedCwd = await resolveTerminalWorkingDirectory({ cwd, workspacePath });
    if (existing?.closing) throw sessionIdentityConflict(id);
    if (existing && !sameCreationIdentity(existing, creationIdentity)) throw sessionIdentityConflict(id);
    if (existing?.status === 'exited') throw exitedSessionConflict(id);
    if (existing?.status === 'running') {
      if (path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const pending = pendingSessionCreates.get(id);
    if (pending) {
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      if (!sameCreationIdentity(pending, creationIdentity)) throw sessionIdentityConflict(id);
      const session = await pending.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    if (owner === 'user' && !existing && userSessionCount() >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    if (shuttingDown) throw new Error("Terminal runtime is shutting down");
    const creation = (async () => {
      const session = sessionState(id, resolvedCwd, cols, rows, creationIdentity, themeMode);
      await startSession(session, { cwd: resolvedCwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell, ...(spawn ? { spawn } : {}) });
      sessions.set(id, session);
      return session;
    })();
    const pendingEntry = { ...creationIdentity, cwd: resolvedCwd, promise: creation };
    pendingSessionCreates.set(id, pendingEntry);
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  const activeWsServer = wsServer;
  activeWsServer.on('connection', (socket) => {
    const connection: TerminalConnection = { socket, attachments: new Map() };
    connections.add(connection);
    send(socket, { t: 'hello', v: TERMINAL_PROTOCOL_VERSION });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!message || message.v !== TERMINAL_PROTOCOL_VERSION || typeof message.t !== 'string') { send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: TERMINAL_PROTOCOL_VERSION }); return; }
      if (message.t === 'hello') return;
      const id = typeof message.s === 'string' ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      const session = sessions.get(id);
      if (!session) { send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, s: id, i: message.i, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      if (message.t === 'attach') {
        const attachment: TerminalAttachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        const initial = snapshot(session);
        send(socket, initial);
        for (const event of attachment.pending) {
          if (typeof event.q === 'number' && typeof initial.q === 'number' && event.q > initial.q) send(socket, event);
        }
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (typeof message.i !== 'string' || !message.i || typeof message.d !== 'string' || !message.d || message.d.length > MAX_INPUT_CHARS) {
          send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, s: id, i: message.i, code: 'BAD_INPUT', message: 'Identified terminal input is required', fatal: false }); return;
        }
        if (session.status !== 'running' || !session.process) {
          send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, s: id, i: message.i, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return;
        }
        const inputId = message.i;
        const operationId = `terminal-input:${createHash('sha256').update(JSON.stringify([session.id, inputId])).digest('hex')}`;
        void writeSession(session, message.d, operationId).then(() => {
          send(socket, { t: 'written', v: TERMINAL_PROTOCOL_VERSION, s: id, i: inputId });
        }, () => {
          send(socket, { t: 'error', v: TERMINAL_PROTOCOL_VERSION, s: id, i: inputId, code: 'INPUT_UNCONFIRMED', message: 'Terminal input was not completely confirmed; it was not retried', fatal: false });
        });
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          if (!await uiAuthController.ensureSessionToken(req, null)) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
        activeWsServer.handleUpgrade(req, socket, head, (ws) => activeWsServer.emit('connection', ws, req));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    })();
  };
  server.on('upgrade', upgradeHandler);

  const makeHandle = (session: TerminalSession): TerminalHandle => ({
    get id() { return session.id; },
    get cwd() { return session.cwd; },
    get status() { return session.status; },
    write(data: string) { return writeSession(session, data); },
    async resize(nextCols: number, nextRows: number) {
      if (!validateSize(nextCols, 1000) || !validateSize(nextRows, 500)) throw new Error('Invalid terminal dimensions');
      if (session.status === 'running') await session.process?.resize(nextCols, nextRows);
      session.cols = nextCols;
      session.rows = nextRows;
    },
    onData(handler) {
      session.dataListeners.add(handler);
      return { dispose: () => { session.dataListeners.delete(handler); } };
    },
    onCommand(handler) {
      session.commandListeners.add(handler);
      return { dispose: () => { session.commandListeners.delete(handler); } };
    },
    onExit(handler) {
      if (session.status === 'exited') {
        let active = true;
        const event = { exitCode: session.exitCode, signal: session.signal ?? 0 };
        queueMicrotask(() => { if (active) handler(event); });
        return { dispose: () => { active = false; } };
      }
      session.exitListeners.add(handler);
      return { dispose: () => { session.exitListeners.delete(handler); } };
    },
    onError(handler) {
      session.errorListeners.add(handler);
      let active = true;
      if (session.failure) { const failure = session.failure; queueMicrotask(() => { if (active) handler(failure); }); }
      return { dispose: () => { active = false; session.errorListeners.delete(handler); } };
    },
    waitForExit() {
      if (session.failure) return Promise.reject(session.failure);
      if (session.status === 'exited') {
        return Promise.resolve({ exitCode: session.exitCode, signal: session.signal });
      }
      return new Promise((resolve, reject) => {
        const disposable = makeHandle(session).onExit((event) => {
          disposable.dispose(); errors?.dispose();
          resolve({ exitCode: event.exitCode, signal: event.signal });
        });
        const errors = makeHandle(session).onError?.((error) => {
          disposable.dispose(); errors?.dispose(); reject(error);
        });
      });
    },
    async terminate(force = false) {
      const processToTerminate = session.process;
      await terminateProcess(processToTerminate, force, force);
    },
    async destroy() {
      await removeSession(session, { force: false, retain: session.owner === 'agent' });
    },
  });

  const removeSession = async (session: TerminalSession, { force, retain }: { force: boolean; retain: boolean }): Promise<void> => {
    if (retain) {
      closeAttachments(session.id, 'DETACHED', 'Terminal view closed');
      return;
    }
    if (session.closing) throw sessionIdentityConflict(session.id);
    session.closing = true;
    const processToTerminate = session.process;
    const writerState = session.writerState;
    try {
      await terminateProcess(processToTerminate, force, true);
      await releaseWriterState(writerState);
      if (session.writerReleasePromise) await session.writerReleasePromise;
      closeAttachments(session.id, force ? 'KILLED' : 'CLOSED', force ? 'Terminal was killed' : 'Terminal closed');
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    } catch (error) {
      session.closing = false;
      throw error;
    }
  };

  const forceTerminateSession = async (session: TerminalSession): Promise<void> => {
    if (session.closing) throw sessionIdentityConflict(session.id);
    session.closing = true;
    const processToTerminate = session.process;
    const writerState = session.writerState;
    try {
      // Keep the session wired and mapped until the PTY has emitted its exit.
      // This lets the normal FIFO event path observe the exit and prevents a
      // later session from inheriting an id while the old process is alive.
      await terminateProcess(processToTerminate, true, true);
      await releaseWriterState(writerState);
      if (session.writerReleasePromise) await session.writerReleasePromise;
      closeAttachments(session.id, 'KILLED', 'Terminal was killed');
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    } catch (error) {
      session.closing = false;
      throw error;
    }
  };

  const createTerminalSession = async (input: CreateTerminalSessionInput): Promise<TerminalHandle> => {
    const session = await createSession({
      sessionId: input.sessionId,
      cwd: input.cwd,
      cols: input.cols ?? 120,
      rows: input.rows ?? 40,
      shell: input.shell ?? 'auto',
      loginShell: input.loginShell ?? false,
      themeMode: input.themeMode,
      terminalBackground: input.terminalBackground,
      terminalForeground: input.terminalForeground,
      owner: input.owner ?? 'user',
      retainWhenDetached: input.retainWhenDetached,
      registerProcessWriter: input.registerProcessWriter,
      ...(input.spawn ? { spawn: input.spawn } : {}),
    }, { allowSpawn: true });
    return makeHandle(session);
  };

  /** Trusted Host adoption of an already admitted process, never an HTTP shell creation option. */
  const adoptTerminalSession = async (input: AdoptTerminalSessionInput): Promise<TerminalHandle> => {
    if (shuttingDown) throw new Error('Terminal runtime is shutting down');
    if (!input.sessionId || !input.process.native || !input.process.detach) throw new Error('A retained native process projection is required');
    const existing = sessions.get(input.sessionId);
    if (existing) {
      if (existing.owner !== 'agent' || !existing.processIdentity
        || Object.entries(input.identity).some(([key, value]) => existing.processIdentity![key as keyof typeof input.identity] !== value)
        || existing.cwd !== input.cwd) throw sessionIdentityConflict(input.sessionId);
      if (existing.status !== 'error') {
        if (existing.process !== input.process) await input.process.detach();
        return makeHandle(existing);
      }
      // Rebind only the broken view. Its original job and stored output remain owned by Rust.
      await existing.process?.detach?.();
      existing.process = input.process;
      existing.writerState = { writer: null, released: false };
      existing.history = ''; existing.pendingHistoryControlSequence = ''; existing.pendingThemeControlSequence = '';
      existing.themeModeEnabled = false; existing.eventQueue.length = 0;
      existing.failure = null; existing.status = 'running'; existing.exitCode = null; existing.signal = null;
      publish(existing, snapshot(existing));
      wire(existing, input.process, existing.writerState);
      return makeHandle(existing);
    }
    const session = sessionState(input.sessionId, input.cwd, 80, 24, { owner: 'agent', creationSource: 'adopted',
      loginShell: false, registerProcessWriter: false, retainWhenDetached: true, shell: 'auto' }, 'dark');
    session.processIdentity = { ...input.identity };
    session.process = input.process;
    session.backend = 'rust-kernel';
    session.status = 'running';
    session.writerState = { writer: null, released: false };
    sessions.set(session.id, session);
    wire(session, input.process, session.writerState);
    return makeHandle(session);
  };

  const attachTerminalSession = (id: string): TerminalHandle | null => {
    const session = sessions.get(id);
    return session ? makeHandle(session) : null;
  };

  const inspectSession = (id: string): TerminalSessionInfo | null => {
    const session = sessions.get(id);
    if (!session) return null;
    return {
      id: session.id,
      cwd: session.cwd,
      integration: session.owner === 'user' ? session.integrationParser.status() : 'not-observed',
      owner: session.owner,
      retainWhenDetached: session.retainWhenDetached,
      status: session.status,
      ...(session.processIdentity ? { processIdentity: { ...session.processIdentity } } : {}),
    };
  };

  app.get('/api/terminal/processes', async (req, res) => {
    try {
      if (!inspectNativeProcesses) { res.status(503).json({ error: 'Native process authority is unavailable' }); return; }
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
      if (!cwd || !path.isAbsolute(cwd)) { res.status(400).json({ error: 'An admitted absolute cwd is required' }); return; }
      res.json({ processes: await inspectNativeProcesses(cwd) });
    } catch (error) { res.status(400).json({ error: errorMessage(error, 'Native process inspection failed') }); }
  });
  app.get('/api/terminal/shells', async (_req: Request, res: Response) => {
    try {
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to list terminal shells') });
    }
  });
  app.post('/api/terminal/create', async (req, res) => {
    try { const session = await createSession(req.body ?? {}, { creationSource: 'http' }); res.json({ sessionId: session.id, cols: session.cols, rows: session.rows, status: session.status }); }
    catch (error) {
      const record = errorRecord(error);
      const statusCode = typeof record.statusCode === 'number'
        ? record.statusCode
        : error instanceof Error && error.message === 'Maximum terminal sessions reached' ? 429 : 400;
      res.status(statusCode).json({ error: errorMessage(error, 'Failed to create terminal session') });
    }
  });
  app.post('/api/terminal/:sessionId/resize', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = req.body ?? {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { await makeHandle(session).resize(cols, rows); res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: errorMessage(error, 'Failed to resize terminal') }); }
  });
  app.post('/api/terminal/:sessionId/appearance', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, req.body ?? {});
    res.json({ success: true });
  });
  app.get('/api/terminal/:sessionId', (req, res) => {
    const info = inspectSession(req.params.sessionId);
    if (!info) return res.status(404).json({ error: 'Terminal session not found' });
    res.json(info);
  });
  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    if (session.owner !== 'user') return res.status(409).json({ error: 'Owned process sessions cannot be restarted as another shell' });
    const cwd = req.body?.cwd ?? session.cwd;
    const workspacePath = req.body?.workspacePath;
    const cols = req.body?.cols ?? session.cols;
    const rows = req.body?.rows ?? session.rows;
    const themeMode = req.body?.themeMode ?? session.themeMode;
    const terminalBackground = req.body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = req.body?.terminalForeground ?? session.terminalForeground;
    const shell = req.body?.shell ?? 'auto';
    const loginShell = req.body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      const resolvedCwd = await resolveTerminalWorkingDirectory({ cwd, workspacePath });
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
      const oldProcess = session.process;
      const oldWriterState = session.writerState;
      const spawned = await spawnSessionProcess(session, { cwd: resolvedCwd, cols, rows, themeMode, shell, loginShell });
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = resolvedCwd; session.cols = cols; session.rows = rows;
      session.writerState = spawned.writerState; session.writerGeneration = spawned.generation;
      session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
      commitIntegrationGeneration(session, spawned.nextIntegrationGeneration);
      wire(session, spawned.process, spawned.writerState);
      void terminateProcess(oldProcess).then(() => releaseWriterState(oldWriterState));
      publish(session, { t: 'restarted', history: '' });
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) {
      const record = errorRecord(error);
      res.status(typeof record.statusCode === 'number' ? record.statusCode : 400)
        .json({ error: errorMessage(error, 'Failed to restart terminal') });
    }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  app.delete('/api/terminal/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    if (session.retainWhenDetached) {
      await removeSession(session, { force: false, retain: true });
      res.json({ success: true, retained: true });
      return;
    }
    try {
      await removeSession(session, { force: false, retain: false });
      res.json({ success: true, retained: false });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Terminal process did not exit during close') });
    }
  });
  app.post('/api/terminal/force-kill', async (req, res) => {
    const { sessionId, cwd } = req.body ?? {}; let killedCount = 0;
    const resolvedCwd = cwd ? path.resolve(String(cwd)) : null;
    const killedSessionIds: string[] = [];
    const selected: TerminalSession[] = [];
    for (const [id, session] of sessions) {
      if ((sessionId && id !== sessionId) || (!sessionId && resolvedCwd && path.resolve(session.cwd) !== resolvedCwd)) continue;
      selected.push(session);
    }
    const results = await Promise.allSettled(selected.map(async (session) => {
      await forceTerminateSession(session);
      return session.id;
    }));
    const errors: Array<{ sessionId: string; error: string }> = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        killedSessionIds.push(result.value);
        killedCount += 1;
      } else {
        const error = result.reason;
        const failedSession = selected[index];
        errors.push({
          sessionId: failedSession?.id ?? '',
          error: errorMessage(error, 'Terminal process did not exit after termination'),
        });
      }
    }
    if (errors.length > 0) {
      res.status(500).json({
        success: false,
        killedCount,
        killedSessionIds,
        errors,
        error: errors.map((entry) => `${entry.sessionId}: ${entry.error}`).join('; '),
      });
      return;
    }
    res.json({ success: true, killedCount, killedSessionIds });
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (session.retainWhenDetached || session.owner === 'harness') continue;
      if (!attached && now - session.lastActivity > terminalIdleTimeoutMs) {
        sessions.delete(id); closeAttachments(id, 'IDLE_TIMEOUT', 'Terminal expired after being idle');
        const processToTerminate = session.process;
        const writerState = session.writerState;
        session.process = null;
        session.writerState = null;
        void terminateProcess(processToTerminate, true).then(() => releaseWriterState(writerState));
      }
    }
  }, terminalIdleSweepMs);

  const shutdown = async (): Promise<void> => {
    shuttingDown = true;
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    await Promise.allSettled([...pendingSessionCreates.values()].map((pending) => pending.promise));
    await Promise.allSettled([...pendingSessionRestarts.values()]);
    const terminations = [...sessions.values()].map(async (session) => {
      // Keep the live event wiring until an actual native tree receipt arrives.
      // Failed termination retains the session for diagnosis and a later retry.
      if (session.owner === 'agent') { const projection = session.process; session.process = null; await projection?.detach?.(); }
      else await terminateProcess(session.process, true);
      await releaseWriterState(session.writerState);
      if (session.writerReleasePromise) await session.writerReleasePromise;
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    });
    const results = await Promise.allSettled(terminations);
    if (wsServer) {
      for (const client of wsServer.clients) client.terminate();
      await Promise.race([
        new Promise<void>((resolve) => wsServer?.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      wsServer = null;
    }
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Terminal process exit or writer release remains unconfirmed');
  };

  const subscribeCommands = (handler: (event: TerminalCommandRecord) => void): { dispose(): void } => {
    commandObservers.add(handler);
    return { dispose: () => { commandObservers.delete(handler); } };
  };

  const api: TerminalSessionApi = {
    createTerminalSession,
    adoptTerminalSession,
    attachTerminalSession,
    inspectSession,
    subscribeCommands,
  };
  return { shutdown, ...api };
}
