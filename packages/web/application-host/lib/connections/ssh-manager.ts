import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { createSettingsFileStore } from '@varin/settings-store';
import type { DesktopSshInstanceStatus, DesktopSshPhase } from '@varin/application-client/desktop';
const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

const LOCAL_HOST_ID = 'local';
const DEFAULT_CONNECTION_TIMEOUT_SEC = 60;
const DEFAULT_LOCAL_BIND_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PERSIST_SEC = 300;
const DEFAULT_READY_TIMEOUT_SEC = 30;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const MAX_LOG_LINES_PER_INSTANCE = 1200;

const MONITOR_INITIAL_POLL_MS = 2000;
const MONITOR_STEADY_POLL_MS = 10000;
const MONITOR_STABILIZE_TICKS = 5;
const SSH_STATUS_EVENT = 'varin:ssh-instance-status';
const MAX_PROCESS_ERROR_CHARS = 2000;
const MAX_PROCESS_ERROR_CAPTURE_CHARS = MAX_PROCESS_ERROR_CHARS * 2;
export interface ParsedSshCommand {
  args: string[];
  destination: string;
}

export interface SshChildProcess {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  stderr?: Pick<Readable, 'on'> | null;
  stdin?: Pick<Writable, 'write' | 'end'> | null;
  stdout?: Pick<Readable, 'on'> | null;
}

interface StoredSecret {
  enabled: boolean;
  store: 'never' | 'settings';
  value?: string | undefined;
}

export interface SshPortForward {
  enabled: boolean;
  id: string;
  localHost?: string | undefined;
  localPort?: number | undefined;
  remoteHost?: string | undefined;
  remotePort?: number | undefined;
  type: 'dynamic' | 'local' | 'remote';
}

export interface SshInstance {
  auth: { varinPassword?: StoredSecret; sshPassword?: StoredSecret };
  connectionTimeoutSec: number;
  id: string;
  localForward: { bindHost: string; preferredLocalPort?: number };
  nickname?: string;
  portForwards: SshPortForward[];
  remoteVarin: {
    installMethod: string;
    keepRunning: boolean;
    mode: 'external' | 'managed';
    preferredPort?: number;
    uploadBundleOverSsh: boolean;
  };
  sshCommand: string;
  sshParsed: ParsedSshCommand;
}

interface SshStatus extends DesktopSshInstanceStatus {
  detail: string | null;
  id: string;
  localPort: number | null;
  localUrl: string | null;
  phase: DesktopSshPhase;
  remotePort: number | null;
  requiresUserAction: boolean;
  retryAttempt: number;
  startedByUs: boolean;
  updatedAtMs: number;
}

interface SshSession {
  askpassCleanupPaths: string[];
  controlPath: string;
  extraForwards: Array<{ child: SshChildProcess; id: string }>;
  instance: SshInstance;
  localPort: number | null;
  mainForward: SshChildProcess | null;
  mainForwardDetached: boolean;
  master: SshChildProcess | null;
  parsed: ParsedSshCommand;
  remotePort: number | null;
  sessionDir: string;
  startedByUs: boolean;
  clientToken: string;
}

interface SshAuthRecord {
  askpassPath: string;
  children: Set<SshChildProcess>;
  sshPassword: string | null;
}

interface ProcessDiagnostics {
  error: Error | null;
  parsed: ParsedSshCommand;
  stderr: string;
}

interface SshConfigCandidate {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
}

type SpawnSsh = (command: string, args: string[], options: SpawnOptions) => SshChildProcess;
type SettingsStore = ReturnType<typeof createSettingsFileStore>;

const childProcessDiagnostics = new WeakMap<SshChildProcess, ProcessDiagnostics>();

const nowMillis = (): number => Date.now();

const shellQuote = (value: unknown): string => `'${String(value).replace(/'/g, `'\\''`)}'`;

const hasGlobWildcard = (value: string): boolean => /[*?]/.test(value);

const expandSshIncludeToken = (token: unknown, baseDir: string): string[] => {
  const trimmed = String(token || '').trim();
  if (!trimmed) return [];

  const expandedHome = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : (trimmed === '~' ? os.homedir() : trimmed);
  const resolved = path.isAbsolute(expandedHome)
    ? expandedHome
    : path.resolve(baseDir, expandedHome);

  if (!hasGlobWildcard(resolved)) {
    return fs.existsSync(resolved) ? [resolved] : [];
  }

  const dir = path.dirname(resolved);
  const namePattern = path.basename(resolved);
  if (hasGlobWildcard(dir) || !fs.existsSync(dir)) {
    return [];
  }

  const matcher = new RegExp(`^${namePattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`);

  try {
    return fs.readdirSync(dir)
      .filter((name) => matcher.test(name))
      .map((name) => path.join(dir, name))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

const sanitizeBindHost = (raw: unknown): string => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_LOCAL_BIND_HOST;
  return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(trimmed) ? trimmed : DEFAULT_LOCAL_BIND_HOST;
};

const splitShellWords = (input: unknown): string[] => {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  const chars = [...String(input)];

  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index]!;
    if (ch === '\\' && !inSingle) {
      index += 1;
      if (index < chars.length) current += chars[index]!;
      continue;
    }
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (inSingle || inDouble) {
    throw new Error('Unclosed quote in SSH command');
  }
  if (current) tokens.push(current);
  return tokens;
};

const isDisallowedPrimaryFlag = (token: string): boolean => {
  return ['-M', '-S', '-O', '-N', '-t', '-T', '-f', '-G', '-W', '-v', '-V', '-q', '-n', '-s', '-e', '-E', '-g'].includes(token);
};

const hasDisallowedOOption = (value: unknown): boolean => {
  const lower = String(value).trim().toLowerCase();
  return ['controlmaster', 'controlpath', 'controlpersist', 'batchmode', 'proxycommand'].some((prefix) => lower.startsWith(prefix));
};

const parseSshCommand = (raw: unknown): ParsedSshCommand => {
  const tokens = splitShellWords(raw);
  if (tokens.length === 0) {
    throw new Error('SSH command is empty');
  }

  if (tokens[0] === 'ssh') {
    tokens.shift();
  }

  if (tokens.length === 0) {
    throw new Error('SSH command must include destination');
  }

  const allowedFlags = new Set(['-4', '-6', '-A', '-a', '-C', '-K', '-k', '-X', '-x', '-Y', '-y']);
  const allowedWithValues = ['-B', '-b', '-c', '-D', '-F', '-I', '-i', '-J', '-l', '-m', '-o', '-P', '-p', '-R'];

  const args: string[] = [];
  let destination: string | null = null;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]!;
    if (destination) {
      throw new Error(`SSH command has unsupported trailing argument: ${token}`);
    }

    if (!token.startsWith('-')) {
      destination = token.trim();
      index += 1;
      continue;
    }

    if (isDisallowedPrimaryFlag(token)) {
      throw new Error(`SSH option ${token} is not allowed`);
    }

    if (allowedFlags.has(token)) {
      args.push(token);
      index += 1;
      continue;
    }

    let matched = false;
    for (const option of allowedWithValues) {
      if (token === option) {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error(`SSH option ${option} requires a value`);
        }
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token, value);
        index += 2;
        matched = true;
        break;
      }

      if (token.startsWith(option) && token.length > option.length) {
        const value = token.slice(option.length);
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token);
        index += 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error(`Unsupported SSH option: ${token}`);
    }
  }

  if (!destination) {
    throw new Error('SSH command must include destination');
  }

  return { destination, args };
};

const buildSshArgs = (parsed: ParsedSshCommand, preDestinationArgs: string[] = [], remoteCommand: string | null = null): string[] => {
  const args = [...parsed.args, ...preDestinationArgs, parsed.destination];
  if (remoteCommand) args.push(remoteCommand);
  return args;
};

const askpassScriptContent = (): string => `#!/bin/bash
PROMPT="$1"

if [[ -n "$VARIN_SSH_ASKPASS_VALUE" ]]; then
  if [[ "$PROMPT" == *"assword"* || "$PROMPT" == *"passphrase"* ]]; then
    printf '%s\\n' "$VARIN_SSH_ASKPASS_VALUE"
    exit 0
  fi
fi

DEFAULT_ANSWER=""
HIDDEN_INPUT="true"

if [[ "$PROMPT" == *"yes/no"* ]]; then
  DEFAULT_ANSWER="yes"
  HIDDEN_INPUT="false"
fi

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript <<'APPLESCRIPT' "$PROMPT" "$DEFAULT_ANSWER" "$HIDDEN_INPUT"
on run argv
  set promptText to item 1 of argv
  set defaultAnswer to item 2 of argv
  set hiddenInput to item 3 of argv

  try
    if hiddenInput is "true" then
      set response to display dialog promptText default answer defaultAnswer with hidden answer buttons {"Cancel", "OK"} default button "OK"
    else
      set response to display dialog promptText default answer defaultAnswer buttons {"Cancel", "OK"} default button "OK"
    end if
    return text returned of response
  on error
    error number -128
  end try
end run
APPLESCRIPT
  exit $?
fi

printf '%s\\n' "$DEFAULT_ANSWER"
`;

const writeAskpassScript = async (scriptPath: string): Promise<void> => {
  await fsp.writeFile(scriptPath, askpassScriptContent(), { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700);
};

const windowsAskpassScriptContent = (): string => `$value = [Environment]::GetEnvironmentVariable('VARIN_SSH_ASKPASS_VALUE')
if ($null -ne $value) {
  [Console]::Out.WriteLine($value)
}
`;

const windowsAskpassWrapperContent = (): string => `@echo off\r
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0askpass.ps1"\r
`;

const CONTROL_CHARS_TO_STRIP = new Set(
  Array.from({ length: 32 }, (_, i) => i) // 0x00-0x1f
    .filter((code) => code !== 0x09 && code !== 0x0a && code !== 0x0d) // keep tab, LF, CR
    .concat(0x7f), // DEL
);

const sanitizeProcessDiagnostic = (value: unknown, secret?: string | null): string => {
  let sanitized = Array.from(String(value || ''))
    .filter((char) => !CONTROL_CHARS_TO_STRIP.has(char.charCodeAt(0)))
    .join('')
    .trim();
  if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  if (sanitized.length > MAX_PROCESS_ERROR_CHARS) {
    sanitized = `${sanitized.slice(0, MAX_PROCESS_ERROR_CHARS - 3)}...`;
  }
  return sanitized;
};

const randomPortCandidate = (seed: string): number => {
  let hash = 0;
  const source = `${seed}:${Date.now()}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  const base = 20000;
  const span = 30000;
  return base + Math.abs(hash % span);
};

const pickUnusedLocalPort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
};

const isLocalPortAvailable = async (bindHost: string, port: number): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, bindHost, () => {
      server.close(() => resolve(true));
    });
  });
};

const isLocalTunnelReachable = async (localPort: number): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
};

const waitLocalForwardReady = async (localPort: number): Promise<void> => {
  const deadline = Date.now() + (DEFAULT_READY_TIMEOUT_SEC * 1000);
  let pollMs = 250;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok || response.status === 401) {
        return;
      }
    } catch {
      /* forward not ready yet; keep polling until deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(pollMs * 2, 2000);
  }
  throw new Error('Timed out waiting for forwarded Varin health');
};

const parseVersionToken = (raw: unknown): string | null => {
  for (const token of String(raw).split(/\s+/)) {
    let candidate = token.trim().replace(/^v/, '');
    candidate = candidate.replace(/[,)]+$/g, '');
    const parts = candidate.split('.');
    if (parts.length >= 2 && parts.every((part) => /^\d+$/.test(part))) {
      return candidate;
    }
  }
  return null;
};

const parseProbeStatusLine = (line: string | undefined, prefix: string): number | null => {
  if (!line || !line.startsWith(prefix)) return null;
  const value = Number.parseInt(line.slice(prefix.length).trim(), 10);
  return Number.isFinite(value) ? value : null;
};

const isAuthHttpStatus = (status: number): boolean => status === 401 || status === 403;
const isLivenessHttpStatus = (status: number): boolean => (status >= 200 && status <= 299) || isAuthHttpStatus(status);

export class HostSshManager {
  readonly settingsFilePath: string;
  readonly settingsStore: SettingsStore;
  readonly appVersion: string;
  readonly emit: (event: 'varin:ssh-instance-status', detail: DesktopSshInstanceStatus) => void;
  readonly platform: NodeJS.Platform;
  readonly spawnProcess: SpawnSsh;
  readonly logs: Map<string, string[]>;
  readonly statuses: Map<string, SshStatus>;
  readonly sessions: Map<string, SshSession>;
  readonly monitorTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly reconnectAttempts: Map<string, number>;
  readonly connectAttempts: Map<string, number>;
  readonly connecting: Map<string, Promise<void>>;
  readonly sshAuth: WeakMap<ParsedSshCommand, SshAuthRecord>;
  readonly wanted = new Set<string>();
  private disposed = false;

  constructor(options: {
    appVersion: string;
    emit(event: 'varin:ssh-instance-status', detail: DesktopSshInstanceStatus): void;
    platform?: NodeJS.Platform;
    settingsFilePath: string;
    settingsStore?: SettingsStore;
    spawn?: SpawnSsh;
  }) {
    this.settingsFilePath = options.settingsFilePath;
    this.settingsStore = options.settingsStore ?? createSettingsFileStore({ filePath: this.settingsFilePath });
    this.appVersion = options.appVersion;
    this.emit = options.emit;
    this.platform = options.platform || process.platform;
    this.spawnProcess = options.spawn || spawn;
    this.logs = new Map<string, string[]>();
    this.statuses = new Map<string, SshStatus>();
    this.sessions = new Map<string, SshSession>();
    this.monitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
    this.reconnectAttempts = new Map<string, number>();
    this.connectAttempts = new Map<string, number>();
    this.connecting = new Map<string, Promise<void>>();
    this.sshAuth = new WeakMap<ParsedSshCommand, SshAuthRecord>();
  }

  usesControlMaster(): boolean {
    return this.platform !== 'win32';
  }

  hiddenSpawnOptions(): Pick<SpawnOptions, 'windowsHide'> {
    return this.platform === 'win32' ? { windowsHide: true } : {};
  }

  authEnvironment(parsed: ParsedSshCommand): NodeJS.ProcessEnv {
    const auth = this.sshAuth.get(parsed);
    if (!auth) return process.env;
    return {
      ...process.env,
      SSH_ASKPASS_REQUIRE: 'force',
      SSH_ASKPASS: auth.askpassPath,
      DISPLAY: '1',
      ...(auth.sshPassword ? { VARIN_SSH_ASKPASS_VALUE: auth.sshPassword.trim() } : {}),
    };
  }

  independentConnectionArgs(): string[] {
    return [
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
  }

  trackSshProcess(child: SshChildProcess, parsed: ParsedSshCommand): SshChildProcess {
    const diagnostics: ProcessDiagnostics = { stderr: '', error: null, parsed };
    childProcessDiagnostics.set(child, diagnostics);
    const auth = this.sshAuth.get(parsed);
    auth?.children.add(child);
    child.stderr?.on('data', (chunk) => {
      diagnostics.stderr = `${diagnostics.stderr}${chunk.toString()}`.slice(-MAX_PROCESS_ERROR_CAPTURE_CHARS);
    });
    child.on('error', (error) => {
      diagnostics.error = error;
    });
    child.on('close', () => {
      auth?.children.delete(child);
    });
    return child;
  }

  processErrorDetail(child: SshChildProcess, fallback: string): string {
    const diagnostics = childProcessDiagnostics.get(child);
    const auth = diagnostics ? this.sshAuth.get(diagnostics.parsed) : null;
    const detail = sanitizeProcessDiagnostic(
      diagnostics?.error instanceof Error ? diagnostics.error.message : diagnostics?.stderr,
      auth?.sshPassword,
    );
    return detail || fallback;
  }

  spawnSsh(parsed: ParsedSshCommand, preDestinationArgs: string[], options: SpawnOptions, remoteCommand: string | null = null): SshChildProcess {
    const child = this.spawnProcess('ssh', buildSshArgs(parsed, preDestinationArgs, remoteCommand), {
      ...options,
      ...this.hiddenSpawnOptions(),
      env: this.authEnvironment(parsed),
    });
    return this.trackSshProcess(child, parsed);
  }

  async runSshOutput(parsed: ParsedSshCommand, preDestinationArgs: string[], remoteCommand: string | null = null): Promise<{
    code: number;
    stderr: string;
    stdout: string;
  }> {
    return await new Promise((resolve, reject) => {
      const child = this.trackSshProcess(this.spawnProcess('ssh', buildSshArgs(parsed, preDestinationArgs, remoteCommand), {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...this.hiddenSpawnOptions(),
        env: this.authEnvironment(parsed),
      }), parsed);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_PROCESS_ERROR_CAPTURE_CHARS);
      });
      child.on('error', () => {
        reject(new Error(this.processErrorDetail(child, 'Failed to start SSH process')));
      });
      child.on('close', (code) => {
        const auth = this.sshAuth.get(parsed);
        resolve({
          code: typeof code === 'number' ? code : -1,
          stdout,
          stderr: sanitizeProcessDiagnostic(stderr, auth?.sshPassword),
        });
      });
    });
  }

  async runRemoteCommand(parsed: ParsedSshCommand, controlPath: string, script: string, timeoutSec = DEFAULT_CONNECTION_TIMEOUT_SEC): Promise<string> {
    const connectionArgs = this.usesControlMaster()
      ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`]
      : this.independentConnectionArgs();
    const { code, stdout, stderr } = await this.runSshOutput(parsed, [
      ...connectionArgs,
      '-o', `ConnectTimeout=${timeoutSec}`,
      '-T',
    ], `sh -lc ${shellQuote(script)}`);
    if (code !== 0) {
      const auth = this.sshAuth.get(parsed);
      throw new Error(sanitizeProcessDiagnostic(stderr || stdout, auth?.sshPassword) || 'Remote command failed');
    }
    return stdout;
  }

  async controlMasterOperation(parsed: ParsedSshCommand, controlPath: string, op: string) {
    return await this.runSshOutput(parsed, [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=3',
      '-O', op,
    ]);
  }

  async isControlMasterAlive(parsed: ParsedSshCommand, controlPath: string): Promise<boolean> {
    const { code } = await this.controlMasterOperation(parsed, controlPath, 'check');
    return code === 0;
  }

  async stopControlMasterBestEffort(parsed: ParsedSshCommand, controlPath: string): Promise<void> {
    if (!this.usesControlMaster()) return;
    try {
      await this.controlMasterOperation(parsed, controlPath, 'exit');
    } catch {
      /* best-effort control master shutdown; connection may already be gone */
    }
  }

  async writeAskpassFiles(sessionDir: string): Promise<{ askpassPath: string; cleanupPaths: string[] }> {
    if (this.platform === 'win32') {
      const scriptPath = path.join(sessionDir, 'askpass.ps1');
      const wrapperPath = path.join(sessionDir, 'askpass.cmd');
      try {
        await fsp.writeFile(scriptPath, windowsAskpassScriptContent());
        await fsp.writeFile(wrapperPath, windowsAskpassWrapperContent());
      } catch (error) {
        await Promise.allSettled([
          fsp.rm(scriptPath, { force: true }),
          fsp.rm(wrapperPath, { force: true }),
        ]);
        throw error;
      }
      return { askpassPath: wrapperPath, cleanupPaths: [wrapperPath, scriptPath] };
    }

    const askpassPath = path.join(sessionDir, 'askpass.sh');
    await writeAskpassScript(askpassPath);
    return { askpassPath, cleanupPaths: [askpassPath] };
  }

  appendLogWithLevel(id: string, level: string, message: string): void {
    const line = `[${nowMillis()}] [${level}] ${message}`;
    const current = this.logs.get(id) || [];
    current.push(line);
    if (current.length > MAX_LOG_LINES_PER_INSTANCE) {
      current.splice(0, current.length - MAX_LOG_LINES_PER_INSTANCE);
    }
    this.logs.set(id, current);
  }

  appendLog(id: string, message: string): void {
    this.appendLogWithLevel(id, 'INFO', message);
  }

  appendAttemptSeparator(id: string, connectAttempt: number, retryAttempt: number): void {
    const scope = retryAttempt > 0 ? `retry ${retryAttempt}` : 'manual';
    this.appendLogWithLevel(id, 'INFO', `---------------- attempt #${connectAttempt} (${scope}) ----------------`);
  }

  statusSnapshotForInstance(id: string): SshStatus {
    return this.statuses.get(id) || {
      id,
      phase: 'idle',
      detail: null,
      localUrl: null,
      localPort: null,
      remotePort: null,
      startedByUs: false,
      retryAttempt: 0,
      requiresUserAction: false,
      updatedAtMs: nowMillis(),
    };
  }

  setStatus(
    id: string,
    phase: DesktopSshPhase,
    detail: string | null = null,
    localUrl: string | null = null,
    localPort: number | null = null,
    remotePort: number | null = null,
    startedByUs = false,
    retryAttempt = 0,
    requiresUserAction = false,
  ): void {
    const level = phase === 'error' ? 'ERROR' : (phase === 'degraded' ? 'WARN' : 'INFO');
    this.appendLogWithLevel(
      id,
      level,
      `phase=${JSON.stringify(phase)} detail=${detail || ''} retry=${retryAttempt} requires_user_action=${requiresUserAction}`,
    );

    const status = {
      id,
      phase,
      detail,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      retryAttempt,
      requiresUserAction,
      updatedAtMs: nowMillis(),
    };
    this.statuses.set(id, status);
    this.emit(SSH_STATUS_EVENT, status);
  }

  clearRetryAttempt(id: string): void {
    this.reconnectAttempts.delete(id);
  }

  nextRetryAttempt(id: string): number {
    const next = (this.reconnectAttempts.get(id) || 0) + 1;
    this.reconnectAttempts.set(id, next);
    return next;
  }

  currentRetryAttempt(id: string): number {
    return this.reconnectAttempts.get(id) || 0;
  }

  nextConnectAttempt(id: string): number {
    const next = (this.connectAttempts.get(id) || 0) + 1;
    this.connectAttempts.set(id, next);
    return next;
  }

  logsForInstance(id: string, limit = 200): string[] {
    const lines = [...(this.logs.get(id) || [])];
    return limit > 0 && lines.length > limit ? lines.slice(-limit) : lines;
  }

  clearLogsForInstance(id: string): void {
    this.logs.delete(id);
  }

  parseSshConfigCandidates(filePath: string, source: string, visited = new Set<string>()): SshConfigCandidate[] {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath) || !fs.existsSync(resolvedPath)) return [];
    visited.add(resolvedPath);

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const candidates: SshConfigCandidate[] = [];
    const baseDir = path.dirname(resolvedPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = (line.split('#')[0] || '').trim();
      if (!trimmed) continue;

      if (/^include(?:\s|$)/i.test(trimmed)) {
        const includeExpr = trimmed.replace(/^include\s+/i, '').trim();
        if (!includeExpr) continue;
        let includeTokens = [];
        try {
          includeTokens = splitShellWords(includeExpr);
        } catch {
          includeTokens = includeExpr.split(/\s+/).filter(Boolean);
        }
        for (const includeToken of includeTokens) {
          const includePaths = expandSshIncludeToken(includeToken, baseDir);
          for (const includePath of includePaths) {
            candidates.push(...this.parseSshConfigCandidates(includePath, source, visited));
          }
        }
        continue;
      }

      if (!/^host(?:\s|$)/i.test(trimmed)) continue;
      const rest = trimmed.replace(/^host\s+/i, '').trim();
      if (!rest) continue;
      for (const token of rest.split(/\s+/)) {
        const host = token.trim();
        if (!host || host.startsWith('!') || host === '*') continue;
        candidates.push({
          host,
          pattern: /[*?]/.test(host),
          source,
          sshCommand: `ssh ${host}`,
        });
      }
    }
    return candidates;
  }

  async importHosts(): Promise<SshConfigCandidate[]> {
    const candidates = [
      ...this.parseSshConfigCandidates(path.join(os.homedir(), '.ssh', 'config'), 'user'),
      ...this.parseSshConfigCandidates('/etc/ssh/ssh_config', 'global'),
    ];
    const seen = new Set<string>();
    return candidates
      .filter((item) => !seen.has(item.host) && seen.add(item.host))
      .sort((left, right) => left.host.localeCompare(right.host));
  }

  readInstances(): { instances: unknown[] } {
    const root = this.settingsStore.readSync();
    return { instances: Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [] };
  }

  async setInstances(config: unknown): Promise<void> {
    const configRecord = recordOf(config);
    const instances = Array.isArray(configRecord.instances) ? configRecord.instances.map((instance) => this.sanitizeInstance(instance)) : [];
    await this.settingsStore.update((root) => {
      const previousSshIds = new Set(
        (Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [])
          .map((entry) => String(entry?.id || '').trim())
          .filter((id) => id && id !== LOCAL_HOST_ID)
      );
      root.desktopSshInstances = instances;

      const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts.filter(Boolean) : [];
      const nextIds = new Set(instances.map((instance) => instance.id));
      const filteredHosts = hosts.filter((entry) => {
        const id = String(entry?.id || '').trim();
        return id && id !== LOCAL_HOST_ID && !(previousSshIds.has(id) && !nextIds.has(id));
      });

      for (const instance of instances) {
        const label = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
        const existing = filteredHosts.find((entry) => entry?.id === instance.id);
        if (existing) {
          existing.label = label;
          if (!existing.url || !String(existing.url).trim()) {
            existing.url = 'http://127.0.0.1/';
          }
        } else {
          filteredHosts.push({ id: instance.id, label, url: 'http://127.0.0.1/' });
        }
      }
      root.desktopHosts = filteredHosts;
      if (typeof root.desktopDefaultHostId === 'string' && previousSshIds.has(root.desktopDefaultHostId) && !nextIds.has(root.desktopDefaultHostId)) {
        root.desktopDefaultHostId = LOCAL_HOST_ID;
      }
      return root;
    });
    const retained = new Set(instances.map((instance) => instance.id));
    await Promise.all([...this.wanted].filter((id) => !retained.has(id)).map((id) => this.disconnect(id)));
  }

  private async persistWanted(id: string, wanted: boolean): Promise<void> {
    await this.settingsStore.update((root) => {
      const ids = new Set(Array.isArray(root.hostSshConnections) ? root.hostSshConnections.filter((id): id is string => typeof id === 'string') : []);
      if (wanted) ids.add(id); else ids.delete(id);
      root.hostSshConnections = [...ids];
    });
  }

  async restore(): Promise<void> {
    const root = this.settingsStore.readSync();
    const configured = new Set(this.readInstances().instances.map((entry) => recordOf(entry).id));
    const ids = Array.isArray(root.hostSshConnections) ? root.hostSshConnections : [];
    await Promise.allSettled(ids.filter((id): id is string => typeof id === 'string' && configured.has(id)).map((id) => this.connect(id)));
  }

  private assertCurrent(session: SshSession): void {
    if (this.disposed || !this.wanted.has(session.instance.id) || this.sessions.get(session.instance.id) !== session) {
      throw new Error('SSH connection was cancelled');
    }
  }

  private adoptChild(session: SshSession, child: SshChildProcess): SshChildProcess {
    try { this.assertCurrent(session); return child; }
    catch (error) { child.kill('SIGTERM'); throw error; }
  }

  sanitizeStoredSecret(secret: unknown): StoredSecret | undefined {
    const value = recordOf(secret);
    if (!secret || typeof secret !== 'object') return undefined;
    return {
      enabled: Boolean(value.enabled),
      store: value.store === 'settings' ? 'settings' : 'never',
      ...(typeof value.value === 'string' && value.value.trim() ? { value: value.value } : {}),
    };
  }

  sanitizeForward(forward: unknown): SshPortForward | null {
    const value = recordOf(forward);
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id) return null;
    const type: SshPortForward['type'] = value.type === 'remote' || value.type === 'dynamic' ? value.type : 'local';
    const normalized = {
      id,
      enabled: value.enabled !== false,
      type,
      ...(value.localHost ? { localHost: sanitizeBindHost(value.localHost) } : {}),
      ...(typeof value.localPort === 'number' && Number.isFinite(value.localPort) ? { localPort: value.localPort } : {}),
      ...(value.remoteHost ? { remoteHost: String(value.remoteHost).trim() || '127.0.0.1' } : {}),
      ...(typeof value.remotePort === 'number' && Number.isFinite(value.remotePort) ? { remotePort: value.remotePort } : {}),
    };

    if (type === 'local' || type === 'remote') {
      if (!normalized.localPort || !normalized.remotePort) return null;
      normalized.remoteHost = normalized.remoteHost || '127.0.0.1';
      normalized.localHost = normalized.localHost || '127.0.0.1';
    }
    if (type === 'dynamic' && !normalized.localPort) {
      return null;
    }
    return normalized;
  }

  sanitizeInstance(instance: unknown): SshInstance {
    const value = recordOf(instance);
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const sshCommand = typeof value.sshCommand === 'string' ? value.sshCommand.trim() : '';
    if (!id || id === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    if (!sshCommand) {
      throw new Error('SSH command is required');
    }

    const parsed = parseSshCommand(sshCommand);
    const remoteVarin = recordOf(value.remoteVarin);
    const localForward = recordOf(value.localForward);
    const auth = recordOf(value.auth);
    const seen = new Set<string>();
    const portForwards = Array.isArray(value.portForwards)
      ? value.portForwards
          .map((forward) => this.sanitizeForward(forward))
          .filter((forward): forward is SshPortForward => {
            if (!forward || seen.has(forward.id)) return false;
            seen.add(forward.id);
            return true;
          })
      : [];
    const sshPassword = this.sanitizeStoredSecret(auth.sshPassword);
    const varinPassword = this.sanitizeStoredSecret(auth.varinPassword);

    return {
      id,
      ...(typeof value.nickname === 'string' && value.nickname.trim() ? { nickname: value.nickname.trim() } : {}),
      sshCommand,
      sshParsed: parsed,
      connectionTimeoutSec: typeof value.connectionTimeoutSec === 'number' && Number.isFinite(value.connectionTimeoutSec) && value.connectionTimeoutSec > 0
        ? value.connectionTimeoutSec
        : DEFAULT_CONNECTION_TIMEOUT_SEC,
      remoteVarin: {
        mode: remoteVarin.mode === 'external' ? 'external' : 'managed',
        keepRunning: remoteVarin.keepRunning !== false,
        ...(typeof remoteVarin.preferredPort === 'number' && Number.isFinite(remoteVarin.preferredPort) ? { preferredPort: remoteVarin.preferredPort } : {}),
        installMethod: typeof remoteVarin.installMethod === 'string' && ['npm', 'bun', 'download_release', 'upload_bundle'].includes(remoteVarin.installMethod)
          ? remoteVarin.installMethod
          : 'bun',
        uploadBundleOverSsh: Boolean(remoteVarin.uploadBundleOverSsh),
      },
      localForward: {
        bindHost: sanitizeBindHost(localForward.bindHost),
        ...(typeof localForward.preferredLocalPort === 'number' && Number.isFinite(localForward.preferredLocalPort) ? { preferredLocalPort: localForward.preferredLocalPort } : {}),
      },
      auth: {
        ...(sshPassword ? { sshPassword } : {}),
        ...(varinPassword ? { varinPassword } : {}),
      },
      portForwards,
    };
  }

  async updateHostUrl(instanceId: string, label: string, localUrl: string): Promise<void> {
    return this.updateHostRuntime(instanceId, label, localUrl, '');
  }

  async updateHostRuntime(instanceId: string, label: string, localUrl: string, clientToken = ''): Promise<void> {
    const token = typeof clientToken === 'string' ? clientToken.trim() : '';
    await this.settingsStore.update((root) => {
      const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
      const existing = hosts.find((entry) => entry?.id === instanceId);
      if (existing) {
        existing.label = label;
        existing.url = localUrl;
        existing.apiUrl = localUrl;
        if (token) existing.clientToken = token;
      } else {
        hosts.push({ id: instanceId, label, url: localUrl, apiUrl: localUrl, ...(token ? { clientToken: token } : {}) });
      }
      root.desktopHosts = hosts;
      return root;
    });
  }

  async issueClientToken(localUrl: string, varinPassword: string | null, instanceId = 'connection'): Promise<string> {
    const password = typeof varinPassword === 'string' ? varinPassword.trim() : '';
    const dedupeKey = `desktop-ssh-managed:${instanceId}`;
    const settings = this.settingsStore.readSync();
    const retained = (Array.isArray(settings.desktopHosts) ? settings.desktopHosts : [])
      .find((host) => host?.id === instanceId);
    const retainedToken = typeof retained?.clientToken === 'string' ? retained.clientToken.trim() : '';
    if (retainedToken) {
      const retainedResponse = await fetch(new URL('/api/harness/managed-execution/v1/identity', `${localUrl}/`).toString(), {
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${retainedToken}` },
      }).catch(() => null);
      if (retainedResponse?.ok) return retainedToken;
    }
    let cookie = '';
    if (password) {
      const loginResponse = await fetch(new URL('/auth/session', `${localUrl}/`).toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password,
          trustDevice: true,
          issueClientToken: true,
          clientLabel: 'Varin Desktop SSH',
          clientKind: 'desktop-ssh-coordinator',
          clientProfile: 'full-control',
          dedupeKey,
        }),
      });
      if (!loginResponse.ok) {
        throw new Error(`Configured Varin UI password was rejected by forwarded server (status ${loginResponse.status})`);
      }

      const payload = recordOf(await loginResponse.json().catch(() => null));
      const token = typeof payload?.clientToken === 'string' ? payload.clientToken.trim() : '';
      if (token) return token;
      cookie = this.extractCookieHeader(loginResponse);
      if (!cookie) return '';
    }

    const tokenResponse = await fetch(new URL('/api/client-auth/clients', `${localUrl}/`).toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({
        label: 'Varin Desktop SSH',
        clientKind: 'desktop-ssh-coordinator',
        profile: 'full-control',
        dedupeKey,
      }),
    });
    if (!tokenResponse.ok) return '';
    const tokenPayload = recordOf(await tokenResponse.json().catch(() => null));
    return typeof tokenPayload?.token === 'string' ? tokenPayload.token.trim() : '';
  }

  async managedExecutionLifecycle(localUrl: string, clientToken: string): Promise<{ activeJobs: number; keepAliveRequired: boolean } | null> {
    try {
      const response = await fetch(new URL('/api/harness/managed-execution/v1/lifecycle', `${localUrl}/`).toString(), {
        signal: AbortSignal.timeout(5_000),
        headers: {
          Accept: 'application/json',
          ...(clientToken ? { Authorization: `Bearer ${clientToken}` } : {}),
        },
      });
      if (!response.ok) return null;
      const body = recordOf(await response.json().catch(() => null));
      if (typeof body.activeJobs !== 'number' || !Number.isSafeInteger(body.activeJobs) || body.activeJobs < 0) return null;
      return { activeJobs: body.activeJobs, keepAliveRequired: body.keepAliveRequired === true };
    } catch {
      return null;
    }
  }

  extractCookieHeader(response: Response): string {
    const getSetCookie = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie.bind(response.headers)
      : null;
    const cookies = getSetCookie ? getSetCookie() : [];
    const rawCookies = cookies.length > 0
      ? cookies
      : String(response.headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,=]+=[^;,]+)/);
    return rawCookies
      .map((cookie) => String(cookie || '').split(';')[0]?.trim() || '')
      .filter(Boolean)
      .join('; ');
  }

  async persistLocalPort(instanceId: string, localPort: number): Promise<void> {
    await this.settingsStore.update((root) => {
      const instances = Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [];
      for (const instance of instances) {
        if (instance?.id !== instanceId) continue;
        instance.localForward = instance.localForward && typeof instance.localForward === 'object' ? instance.localForward : {};
        instance.localForward.preferredLocalPort = localPort;
      }
      root.desktopSshInstances = instances;
      return root;
    });
  }

  async resolveSshConfig(parsed: ParsedSshCommand): Promise<Map<string, string>> {
    const { code, stdout, stderr } = await this.runSshOutput(parsed, ['-G']);
    if (code !== 0) {
      throw new Error(stderr.trim() || 'Failed to resolve SSH config');
    }
    const map = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split(' ');
      if (!key || rest.length === 0) continue;
      map.set(key.toLowerCase(), rest.join(' ').trim());
    }
    return map;
  }

  ensureSessionDir(id: string): string {
    const base = path.join(path.dirname(this.settingsFilePath), 'ssh', id);
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  controlPathForInstance(id: string): string {
    let hash = 0;
    for (const char of id) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return path.join(os.tmpdir(), `ocssh-${Math.abs(hash).toString(16)}.sock`);
  }

  async spawnMasterProcess(parsed: ParsedSshCommand, controlPath: string): Promise<SshChildProcess> {
    return this.spawnSsh(parsed, [
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${DEFAULT_CONTROL_PERSIST_SEC}`,
      '-N',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async waitForMasterReady(parsed: ParsedSshCommand, controlPath: string, timeoutSec: number, master: SshChildProcess): Promise<void> {
    const deadline = Date.now() + (timeoutSec * 1000);
    let pollMs = 250;
    while (Date.now() < deadline) {
      const { code } = await this.runSshOutput(parsed, [
        '-o', 'ControlMaster=no',
        '-o', `ControlPath=${controlPath}`,
        '-O', 'check',
      ]);
      if (code === 0) return;

      const exited = master.exitCode;
      if (typeof exited === 'number') {
        throw new Error(this.processErrorDetail(master, 'SSH master process exited before ready'));
      }
      const spawnError = childProcessDiagnostics.get(master)?.error;
      if (spawnError) throw new Error(this.processErrorDetail(master, 'Failed to start SSH master process'));
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 2000);
    }
    throw new Error('SSH ControlMaster connection timed out');
  }

  configuredVarinPassword(instance: SshInstance): string | null {
    const secret = instance?.auth?.varinPassword;
    return secret?.enabled && typeof secret.value === 'string' && secret.value.trim() ? secret.value.trim() : null;
  }

  async remoteCommandExists(parsed: ParsedSshCommand, controlPath: string, commandName: string): Promise<boolean> {
    try {
      const output = await this.runRemoteCommand(parsed, controlPath, `command -v ${commandName} >/dev/null 2>&1 && echo yes || echo no`);
      return output.trim() === 'yes';
    } catch {
      return false;
    }
  }

  async currentRemoteVarinVersion(parsed: ParsedSshCommand, controlPath: string): Promise<string | null> {
    try {
      const output = await this.runRemoteCommand(parsed, controlPath, 'varin --version 2>/dev/null || true');
      return parseVersionToken(output);
    } catch {
      return null;
    }
  }

  async installVarinManaged(parsed: ParsedSshCommand, controlPath: string, version: string, preferred: string): Promise<void> {
    const hasBun = await this.remoteCommandExists(parsed, controlPath, 'bun');
    const hasNpm = await this.remoteCommandExists(parsed, controlPath, 'npm');
    const commands = [];

    if (preferred === 'bun') {
      if (hasBun) commands.push(`bun add -g @varin/web@${version}`);
      if (hasNpm) commands.push(`npm install -g @varin/web@${version}`);
    } else if (preferred === 'npm') {
      if (hasNpm) commands.push(`npm install -g @varin/web@${version}`);
      if (hasBun) commands.push(`bun add -g @varin/web@${version}`);
    } else {
      if (hasBun) commands.push(`bun add -g @varin/web@${version}`);
      if (hasNpm) commands.push(`npm install -g @varin/web@${version}`);
    }

    if (commands.length === 0) {
      throw new Error('Remote host has neither bun nor npm available');
    }

    let lastError = null;
    for (const command of commands) {
      try {
        await this.runRemoteCommand(parsed, controlPath, command);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Failed to install Varin on remote host');
  }

  async probeRemoteSystemInfo(parsed: ParsedSshCommand, controlPath: string, port: number, varinPassword: string | null): Promise<Record<string, unknown>> {
    const authPayload = varinPassword ? JSON.stringify({ password: varinPassword }) : '{}';
    const authEnabled = varinPassword ? '1' : '0';
    const script = `AUTH_STATUS=0; INFO_STATUS=0; HEALTH_STATUS=0; BODY_FILE="$(mktemp)"; COOKIE_FILE="$(mktemp)"; cleanup(){ rm -f "$BODY_FILE" "$COOKIE_FILE"; }; trap cleanup EXIT; if command -v curl >/dev/null 2>&1; then if [ "${authEnabled}" = "1" ]; then AUTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -c "$COOKIE_FILE" -H 'content-type: application/json' --data ${shellQuote(authPayload)} http://127.0.0.1:${port}/auth/session || true)"; if [ "$AUTH_STATUS" = "200" ]; then INFO_STATUS="$(curl -sS --max-time 3 -b "$COOKIE_FILE" -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; HEALTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || true)"; elif command -v wget >/dev/null 2>&1; then wget -qO "$BODY_FILE" http://127.0.0.1:${port}/api/system/info >/dev/null 2>&1; if [ $? -eq 0 ]; then INFO_STATUS=200; fi; wget -qO- http://127.0.0.1:${port}/health >/dev/null 2>&1; if [ $? -eq 0 ]; then HEALTH_STATUS=200; fi; else exit 127; fi; printf 'INFO_STATUS=%s\\nAUTH_STATUS=%s\\nHEALTH_STATUS=%s\\n' "$INFO_STATUS" "$AUTH_STATUS" "$HEALTH_STATUS"; cat "$BODY_FILE" 2>/dev/null || true`;
    const output = await this.runRemoteCommand(parsed, controlPath, script);
    const lines = output.split(/\r?\n/);
    const infoStatus = parseProbeStatusLine(lines[0], 'INFO_STATUS=') || 0;
    const authStatus = parseProbeStatusLine(lines[1], 'AUTH_STATUS=') || 0;
    const healthStatus = parseProbeStatusLine(lines[2], 'HEALTH_STATUS=') || 0;
    const body = lines.slice(3).join('\n');

    if (isLivenessHttpStatus(infoStatus)) {
      if (isAuthHttpStatus(infoStatus)) {
        if (varinPassword && authStatus !== 200) {
          throw new Error(`Remote Varin requires UI authentication and configured password was rejected (auth status ${authStatus})`);
        }
        if (isLivenessHttpStatus(healthStatus)) return {};
        throw new Error('Remote Varin requires UI authentication on /api/system/info; configure Varin UI password');
      }
    } else if (isLivenessHttpStatus(healthStatus)) {
      return {};
    } else {
      throw new Error(`Remote Varin probe failed (info status ${infoStatus}, health status ${healthStatus})`);
    }

    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async remoteServerRunning(parsed: ParsedSshCommand, controlPath: string, port: number, varinPassword: string | null): Promise<boolean> {
    try {
      await this.probeRemoteSystemInfo(parsed, controlPath, port, varinPassword);
      return true;
    } catch {
      return false;
    }
  }

  async startRemoteServerManaged(parsed: ParsedSshCommand, controlPath: string, instance: SshInstance, desiredPort: number): Promise<number> {
    let envPrefix = 'VARIN_RUNTIME=ssh-remote';
    const secret = this.configuredVarinPassword(instance);
    if (secret) {
      envPrefix += ` VARIN_UI_PASSWORD=${shellQuote(secret)}`;
    }
    const output = await this.runRemoteCommand(parsed, controlPath, `${envPrefix} varin serve --host 127.0.0.1 --port ${desiredPort}`);
    const port = output.split(/\s+/).map((token) => Number.parseInt(token, 10)).find((value) => Number.isFinite(value));
    return port || desiredPort;
  }

  async stopRemoteServerBestEffort(parsed: ParsedSshCommand, controlPath: string, remotePort: number): Promise<void> {
    try {
      await this.runRemoteCommand(
        parsed,
        controlPath,
        `if command -v curl >/dev/null 2>&1; then curl -fsS -X POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --method=POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; fi`,
      );
    } catch {
      /* best-effort remote shutdown; server may already be stopped or unreachable */
    }
  }

  async spawnMainForward(parsed: ParsedSshCommand, controlPath: string, bindHost: string, localPort: number, remotePort: number): Promise<SshChildProcess> {
    const connectionArgs = this.usesControlMaster()
      ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`]
      : this.independentConnectionArgs();
    return this.spawnSsh(parsed, [
      ...connectionArgs,
      '-o', 'ExitOnForwardFailure=yes',
      '-N',
      '-L', `${bindHost}:${localPort}:127.0.0.1:${remotePort}`,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }

  async spawnExtraForward(parsed: ParsedSshCommand, controlPath: string, forward: SshPortForward): Promise<SshChildProcess | null> {
    const args = this.usesControlMaster()
      ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-O', 'forward']
      : [...this.independentConnectionArgs(), '-o', 'ExitOnForwardFailure=yes', '-N'];
    if (forward.type === 'local') {
      args.push('-L', `${forward.localHost || '127.0.0.1'}:${forward.localPort}:${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}`);
    } else if (forward.type === 'remote') {
      args.push('-R', `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}:${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    } else {
      args.push('-D', `${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    }
    if (!this.usesControlMaster()) {
      const child = this.spawnSsh(parsed, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (typeof child.exitCode === 'number' || childProcessDiagnostics.get(child)?.error) {
        throw new Error(this.processErrorDetail(child, `Failed to configure extra SSH forward ${forward.id}`));
      }
      return child;
    }

    const { code, stdout, stderr } = await this.runSshOutput(parsed, args);
    if (code !== 0) {
      throw new Error((stderr || stdout || `Failed to configure extra SSH forward ${forward.id}`).trim());
    }
    return null;
  }

  async ensureRemoteServer(instance: SshInstance, parsed: ParsedSshCommand, controlPath: string): Promise<{ remotePort: number; startedByUs: boolean }> {
    if (instance.remoteVarin.mode === 'external') {
      if (!instance.remoteVarin.preferredPort) {
        throw new Error('External mode requires a preferred remote Varin port');
      }
      const port = instance.remoteVarin.preferredPort;
      this.setStatus(instance.id, 'server_detecting', 'Probing external Varin server', null, null, port, false, 0, false);
      await this.probeRemoteSystemInfo(parsed, controlPath, port, this.configuredVarinPassword(instance));
      return { remotePort: port, startedByUs: false };
    }

    this.setStatus(instance.id, 'remote_probe', 'Checking remote Varin installation');
    const installedVersion = await this.currentRemoteVarinVersion(parsed, controlPath);
    if (!installedVersion) {
      this.setStatus(instance.id, 'installing', 'Installing Varin on remote host');
      await this.installVarinManaged(parsed, controlPath, this.appVersion, instance.remoteVarin.installMethod);
    } else if (installedVersion !== this.appVersion) {
      this.setStatus(instance.id, 'updating', `Updating remote Varin from ${installedVersion} to ${this.appVersion}`);
      await this.installVarinManaged(parsed, controlPath, this.appVersion, instance.remoteVarin.installMethod);
    }

    this.setStatus(instance.id, 'server_detecting', 'Detecting managed Varin server');
    let remotePort = instance.remoteVarin.preferredPort || null;
    let startedByUs = false;
    if (remotePort && !(await this.remoteServerRunning(parsed, controlPath, remotePort, this.configuredVarinPassword(instance)))) {
      remotePort = null;
    }
    if (!remotePort) {
      this.setStatus(instance.id, 'server_starting', 'Starting managed Varin server');
      const desiredPort = instance.remoteVarin.preferredPort || randomPortCandidate(instance.id);
      remotePort = await this.startRemoteServerManaged(parsed, controlPath, instance, desiredPort);
      startedByUs = true;
    }
    if (!(await this.remoteServerRunning(parsed, controlPath, remotePort, this.configuredVarinPassword(instance)))) {
      throw new Error('Managed Varin server failed to become reachable');
    }
    return { remotePort, startedByUs };
  }

  async disconnectInternal(id: string, reportIdle: boolean): Promise<void> {
    const timer = this.monitorTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.monitorTimers.delete(id);
    }

    const session = this.sessions.get(id);
    this.sessions.delete(id);

    if (session) {
      if (session.startedByUs && session.remotePort && session.instance.remoteVarin.mode === 'managed' && !session.instance.remoteVarin.keepRunning) {
        const localUrl = session.localPort ? `http://127.0.0.1:${session.localPort}` : null;
        const lifecycle = localUrl ? await this.managedExecutionLifecycle(localUrl, session.clientToken) : null;
        if (lifecycle && !lifecycle.keepAliveRequired && lifecycle.activeJobs === 0) {
          await this.stopRemoteServerBestEffort(session.parsed, session.controlPath, session.remotePort);
        } else {
          this.appendLogWithLevel(
            id,
            'INFO',
            lifecycle
              ? `Leaving remote Varin running to supervise ${lifecycle.activeJobs} accepted managed job(s)`
              : 'Leaving remote Varin running because managed-job lifecycle could not be confirmed',
          );
        }
      }
      await this.stopControlMasterBestEffort(session.parsed, session.controlPath);
      const auth = this.sshAuth.get(session.parsed);
      const children = new Set<SshChildProcess>([
        session.mainForward,
        session.master,
        ...session.extraForwards.map((entry) => entry.child),
        ...(auth?.children || []),
      ].filter((child): child is SshChildProcess => Boolean(child)));
      for (const child of children) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* best-effort kill; process may already be dead */
        }
      }
      try {
        await fsp.rm(session.controlPath, { force: true });
      } catch {
        /* best-effort cleanup; control socket may already be removed */
      }
      for (const askpassFilePath of session.askpassCleanupPaths) {
        try {
          await fsp.rm(askpassFilePath, { force: true });
        } catch {
          /* best-effort cleanup; askpass file may already be removed */
        }
      }
      this.sshAuth.delete(session.parsed);
    }

    if (reportIdle) this.clearRetryAttempt(id);
    if (reportIdle) {
      this.setStatus(id, 'idle', null, null, null, null, false, 0, false);
    }
  }

  async connectBlocking(instance: SshInstance): Promise<void> {
    const id = instance.id;
    this.setStatus(id, 'config_resolved', 'Resolving SSH command');
    const parsed = instance.sshParsed || parseSshCommand(instance.sshCommand);
    await this.resolveSshConfig(parsed);
    if (this.disposed || !this.wanted.has(id)) throw new Error('SSH connection was cancelled');

    this.setStatus(id, 'auth_check', 'Checking SSH connectivity');
    const sessionDir = this.ensureSessionDir(id);
    const controlPath = this.controlPathForInstance(id);
    try { await fsp.rm(controlPath, { force: true }); } catch { /* best-effort cleanup; stale socket may not exist */ }
    const { askpassPath, cleanupPaths: askpassCleanupPaths } = await this.writeAskpassFiles(sessionDir);
    if (this.disposed || !this.wanted.has(id)) {
      await Promise.all(askpassCleanupPaths.map((file) => fsp.rm(file, { force: true })));
      throw new Error('SSH connection was cancelled');
    }
    const sshPassword = instance.auth?.sshPassword?.enabled ? instance.auth.sshPassword.value?.trim() ?? null : null;
    this.sshAuth.set(parsed, { askpassPath, sshPassword, children: new Set() });
    const session: SshSession = {
      instance,
      parsed,
      sessionDir,
      controlPath,
      askpassCleanupPaths,
      localPort: null,
      remotePort: null,
      startedByUs: false,
      clientToken: '',
      master: null,
      mainForward: null,
      mainForwardDetached: false,
      extraForwards: [],
    };
    this.sessions.set(id, session);

    this.setStatus(id, 'master_connecting', this.usesControlMaster() ? 'Establishing SSH ControlMaster' : 'Checking SSH connectivity');
    if (this.usesControlMaster()) {
      const master = this.adoptChild(session, await this.spawnMasterProcess(parsed, controlPath));
      session.master = master;
      await this.waitForMasterReady(parsed, controlPath, instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC, master);
      this.assertCurrent(session);
    }

    this.setStatus(id, 'remote_probe', 'Probing remote platform');
    const remoteOs = (await this.runRemoteCommand(parsed, controlPath, 'uname -s', instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC)).trim().toLowerCase();
    this.assertCurrent(session);
    if (!['linux', 'darwin'].includes(remoteOs)) {
      throw new Error(`Unsupported remote OS: ${remoteOs}`);
    }

    const { remotePort, startedByUs } = await this.ensureRemoteServer(instance, parsed, controlPath);
    this.assertCurrent(session);
    session.remotePort = remotePort;
    session.startedByUs = startedByUs;
    this.setStatus(id, 'forwarding', 'Setting up port forwards', null, null, remotePort, startedByUs, 0, false);

    const bindHost = sanitizeBindHost(instance.localForward?.bindHost);
    let localPort = Number(instance.localForward?.preferredLocalPort) || 0;
    if (!localPort) {
      localPort = await pickUnusedLocalPort();
    }
    if (!(await isLocalPortAvailable(bindHost, localPort))) {
      localPort = await pickUnusedLocalPort();
    }

    const mainForward = this.adoptChild(session, await this.spawnMainForward(parsed, controlPath, bindHost, localPort, remotePort));
    session.mainForward = mainForward;
    let mainForwardDetached = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.assertCurrent(session);
    if (typeof mainForward.exitCode === 'number' || childProcessDiagnostics.get(mainForward)?.error) {
      if (this.usesControlMaster() && mainForward.exitCode === 0) {
        mainForwardDetached = true;
        this.appendLogWithLevel(id, 'INFO', 'Main tunnel helper exited after ControlMaster handoff');
      } else {
        throw new Error(this.processErrorDetail(mainForward, `Failed to start main port forward (status: ${mainForward.exitCode ?? 'spawn error'})`));
      }
    }
    session.mainForwardDetached = mainForwardDetached;

    const extraErrors = [];
    for (const forward of instance.portForwards.filter((item) => item.enabled)) {
      this.assertCurrent(session);
      try {
        const extraForward = await this.spawnExtraForward(parsed, controlPath, forward);
        if (extraForward) session.extraForwards.push({ id: forward.id, child: this.adoptChild(session, extraForward) });
        if (forward.type === 'local' && forward.localPort) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!(await isLocalTunnelReachable(forward.localPort))) {
            extraErrors.push(`${forward.id}: local listener 127.0.0.1:${forward.localPort} is not reachable`);
          }
        }
      } catch (error) {
        extraErrors.push(`${forward.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await waitLocalForwardReady(localPort);
    this.assertCurrent(session);

    const localUrl = `http://127.0.0.1:${localPort}`;
    const label = instance.nickname?.trim() || parsed.destination || id;
    const clientToken = await this.issueClientToken(localUrl, this.configuredVarinPassword(instance), instance.id);
    this.assertCurrent(session);
    session.clientToken = clientToken;
    await this.updateHostRuntime(id, label, localUrl, clientToken);
    if (instance.localForward?.preferredLocalPort !== localPort) {
      await this.persistLocalPort(id, localPort);
    }

    session.localPort = localPort;
    this.assertCurrent(session);

    this.clearRetryAttempt(id);
    this.setStatus(
      id,
      'ready',
      extraErrors.length === 0 ? 'SSH instance is ready' : `SSH instance is ready with forward warnings: ${extraErrors.join('; ')}`,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      0,
      false,
    );
    this.spawnMonitor(id);
  }

  spawnMonitor(id: string): void {
    const existing = this.monitorTimers.get(id);
    if (existing) clearTimeout(existing);
    let healthyTicks = 0;
    const tick = async () => {
      if (this.disposed || !this.wanted.has(id)) return;
      const session = this.sessions.get(id);
      if (!session) {
        this.monitorTimers.delete(id);
        return;
      }

      let droppedReason = null;
      let detachedNotice = null;
      const mainForward = session.mainForward;

      if (!session.mainForwardDetached) {
        if (!mainForward) {
          droppedReason = 'Main SSH forward is unavailable';
        } else if (typeof mainForward.exitCode === 'number') {
          if (this.usesControlMaster() && mainForward.exitCode === 0) {
            session.mainForwardDetached = true;
            detachedNotice = 'Main tunnel helper exited after ControlMaster handoff';
          } else {
            droppedReason = this.processErrorDetail(mainForward, `Main SSH forward exited (${mainForward.exitCode})`);
          }
        } else if (childProcessDiagnostics.get(mainForward)?.error) {
          droppedReason = this.processErrorDetail(mainForward, 'Main SSH forward failed');
        }
      }

      if (!droppedReason) {
        const stoppedExtraForward = session.extraForwards.find(({ child }) => (
          typeof child.exitCode === 'number' || childProcessDiagnostics.get(child)?.error
        ));
        if (stoppedExtraForward) {
          droppedReason = this.processErrorDetail(
            stoppedExtraForward.child,
            `Extra SSH forward ${stoppedExtraForward.id} exited`,
          );
        }
      }

      if (!droppedReason) {
        if (session.mainForwardDetached) {
          // Fast path: cheap TCP probe before expensive SSH subprocess
          if (typeof session.localPort === 'number' && await isLocalTunnelReachable(session.localPort)) {
            // Tunnel alive — skip SSH check
          } else if (!await this.isControlMasterAlive(session.parsed, session.controlPath)) {
            droppedReason = 'SSH ControlMaster is not reachable';
          } else {
            detachedNotice = 'Local tunnel unreachable but ControlMaster is alive';
          }
        }
      }

      if (detachedNotice) {
        this.appendLogWithLevel(id, 'INFO', detachedNotice);
      }
      if (!droppedReason) {
        healthyTicks++;
        const pollMs = healthyTicks >= MONITOR_STABILIZE_TICKS ? MONITOR_STEADY_POLL_MS : MONITOR_INITIAL_POLL_MS;
        this.monitorTimers.set(id, setTimeout(tick, pollMs));
        return;
      }

      this.appendLogWithLevel(id, 'WARN', droppedReason);
      await this.disconnectInternal(id, false);
      const attempt = this.nextRetryAttempt(id);
      if (attempt > DEFAULT_RECONNECT_MAX_ATTEMPTS) {
        this.setStatus(id, 'error', `${droppedReason}. Retry limit reached`, null, null, null, false, attempt, true);
        return;
      }

      this.setStatus(id, 'degraded', `${droppedReason}. Reconnecting`, null, null, null, false, attempt, false);
      const delayMs = Math.min((2 ** Math.max(attempt - 1, 0)) * 1000 + (nowMillis() % 700) + 100, 30000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (this.disposed || !this.wanted.has(id)) return;
      try {
        await this.connect(id);
      } catch (error) {
        this.setStatus(id, 'error', error instanceof Error ? error.message : String(error), null, null, null, false, attempt, true);
      }
    };
    this.monitorTimers.set(id, setTimeout(tick, MONITOR_INITIAL_POLL_MS));
  }

  async connect(id: unknown): Promise<void> {
    if (this.disposed) throw new Error('Connection owner has stopped');
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }

    if (this.connecting.has(trimmed)) {
      this.appendLogWithLevel(trimmed, 'INFO', 'Connection already in progress');
      return this.connecting.get(trimmed)!;
    }

    const instance = this.readInstances().instances.find((entry) => recordOf(entry).id === trimmed);
    if (!instance) {
      throw new Error('SSH instance not found');
    }

    const retryAttempt = this.currentRetryAttempt(trimmed);
    const connectAttempt = this.nextConnectAttempt(trimmed);
    this.appendAttemptSeparator(trimmed, connectAttempt, retryAttempt);
    this.appendLog(trimmed, 'Starting SSH connection');
    this.wanted.add(trimmed);
    const task = (async () => {
      await this.persistWanted(trimmed, true);
      if (this.disposed || !this.wanted.has(trimmed)) return;
      await this.disconnectInternal(trimmed, false);
      if (this.disposed || !this.wanted.has(trimmed)) return;
      await this.connectBlocking(this.sanitizeInstance(instance));
    })()
      .catch(async (error) => {
        this.setStatus(trimmed, 'error', error instanceof Error ? error.message : String(error), null, null, null, false, 0, true);
        await this.disconnectInternal(trimmed, false);
        throw error;
      })
      .finally(() => {
        this.connecting.delete(trimmed);
      });
    this.connecting.set(trimmed, task);
    return task;
  }

  async disconnect(id: unknown): Promise<void> {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    this.wanted.delete(trimmed);
    await this.persistWanted(trimmed, false);
    await this.disconnectInternal(trimmed, true);
    await this.connecting.get(trimmed)?.catch(() => {});
    await this.disconnectInternal(trimmed, true);
  }

  async statusesWithDefaults(id?: string): Promise<SshStatus[]> {
    if (id) {
      return [this.statusSnapshotForInstance(id)];
    }
    return this.readInstances().instances
      .map((instance) => this.statusSnapshotForInstance(String(recordOf(instance).id || '')))
      .filter((status) => Boolean(status.id))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async shutdownAll(): Promise<void> {
    this.disposed = true;
    this.wanted.clear();
    const ids = [...new Set([...this.sessions.keys(), ...this.connecting.keys(), ...this.monitorTimers.keys()])];
    for (const id of ids) {
      await this.disconnectInternal(id, false);
    }
    await Promise.allSettled([...this.connecting.values()]);
  }
}
