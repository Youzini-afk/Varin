import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getDataDir } from './cli-paths.js';
import { assertNodeServerRuntime } from './cli-process.js';
import { hasUiPasswordConfigured } from './cli-network.js';
import type { CliOptions } from './cli-types.js';

const STARTUP_SERVICE_ID = 'dev.varin.web';
const cliDirectory = path.dirname(fileURLToPath(import.meta.url));
const currentUserId = (): number => {
  if (typeof process.getuid !== 'function') throw new Error('User startup integration requires a POSIX user id');
  return process.getuid();
};

interface StartupServicePaths {
  platform: string;
  servicePath: string | null;
}

export interface StartupStatus extends StartupServicePaths {
  active?: boolean | null | undefined;
  activeState?: string | undefined;
  enabled: boolean;
  supported: boolean;
}

function getStartupServicePaths(): StartupServicePaths {
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      servicePath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${STARTUP_SERVICE_ID}.plist`),
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      servicePath: path.join(os.homedir(), '.config', 'systemd', 'user', 'varin.service'),
    };
  }
  if (process.platform === 'win32') {
    return { platform: 'windows', servicePath: STARTUP_SERVICE_ID };
  }
  return { platform: process.platform, servicePath: null };
}

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdEscapeArg(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function startupShellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdUnitPath(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/ /g, '\\x20');
}

function powershellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startupEnvFileQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdEnvFileQuote(value: unknown): string {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')}"`;
}

function getStartupEnvFilePath(): string {
  return path.join(getDataDir(), 'startup.env');
}

function getMacosStartupWrapperPath(): string {
  return path.join(getDataDir(), 'bin', 'Varin');
}

function collectStartupEnv(options: CliOptions = {}): Record<string, string> {
  const env = options.envSnapshot === false ? {} : Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => shouldPersistStartupEnv(key, value))
      .map(([key, value]) => [key, String(value)])
  );

  const uiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
  if (uiPassword) {
    env.VARIN_UI_PASSWORD = uiPassword;
  }
  if (options.apiOnly === true) {
    env.VARIN_API_ONLY = 'true';
  }
  if (typeof process.env.VARIN_DATA_DIR === 'string' && process.env.VARIN_DATA_DIR.trim().length > 0) {
    env.VARIN_DATA_DIR = path.resolve(process.env.VARIN_DATA_DIR.trim());
  }
  return env;
}

function shouldPersistStartupEnv(key: string, value: unknown): value is string {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (typeof value !== 'string') return false;
  if (/[\r\n]/.test(value)) return false;

  // These are shell/session implementation details, not app configuration.
  const volatileKeys = new Set([
    '_',
    'BASH_ENV',
    'COLUMNS',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
    'CONDA_PROMPT_MODIFIER',
    'CONDA_SHLVL',
    'ENV',
    'HISTFILE',
    'HISTFILESIZE',
    'HISTSIZE',
    'LINES',
    'OLDPWD',
    'PROMPT',
    'PROMPT_COMMAND',
    'PS1',
    'PS2',
    'PS3',
    'PS4',
    'PWD',
    'PYENV_VERSION',
    'SHLVL',
    'TERM',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TTY',
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
  ]);
  return !volatileKeys.has(key);
}

function writeStartupEnvFile(options: CliOptions = {}, fileOptions: {
  quoteValue?: (value: string) => string;
} = {}): string {
  const envFilePath = getStartupEnvFilePath();
  const lines = [];
  const env = collectStartupEnv(options);
  const quoteValue = typeof fileOptions.quoteValue === 'function' ? fileOptions.quoteValue : startupEnvFileQuote;
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${quoteValue(value)}`);
  }
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFilePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return envFilePath;
}

function removeStartupEnvFile(): void {
  try { fs.unlinkSync(getStartupEnvFilePath()); } catch {
    // Best-effort operation; continue when it is unavailable.
  }
}

function resolveCliEntrypoint(): string {
  const entry = typeof process.argv[1] === 'string' && process.argv[1].trim().length > 0
    ? process.argv[1]
    : path.join(cliDirectory, '..', 'cli.js');
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
}

function buildStartupArgs(options: CliOptions = {}): string[] {
  const args = [resolveCliEntrypoint(), 'serve', '--foreground', '--port', String(options.port || DEFAULT_PORT)];
  if (typeof options.host === 'string' && options.host.length > 0) {
    args.push('--host', options.host);
  }
  if (options.apiOnly === true) {
    args.push('--api-only');
  }
  return args;
}

function writeMacosStartupWrapper(options: CliOptions = {}): string {
  const wrapperPath = getMacosStartupWrapperPath();
  const args = buildStartupArgs(options).map(startupShellQuote).join(' ');
  const content = `#!/bin/sh
exec ${startupShellQuote(process.execPath)} ${args}
`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  return wrapperPath;
}

function buildMacosLaunchAgent(options: CliOptions = {}): string {
  const wrapperPath = writeMacosStartupWrapper(options);
  const args = [wrapperPath];
  const env = collectStartupEnv(options);
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Varin');
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const envXml = Object.entries(env).length > 0
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STARTUP_SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(os.homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.err.log'))}</string>
</dict>
</plist>
`;
}

function buildSystemdUserService(options: CliOptions = {}): string {
  const args = buildStartupArgs(options).map((arg) => `"${systemdEscapeArg(arg)}"`).join(' ');
  const envFilePath = getStartupEnvFilePath();
  return `[Unit]
Description=Varin web server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-${systemdEscapeArg(envFilePath)}
ExecStart="${systemdEscapeArg(process.execPath)}" ${args}
WorkingDirectory=${systemdUnitPath(os.homedir())}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function runStartupCommand(command: string, args: string[], options: {
  allowFailure?: boolean;
  stdio?: 'ignore' | 'inherit' | 'pipe';
} = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function getStartupStatus(): StartupStatus {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    return { supported: false, platform: paths.platform, enabled: false, servicePath: null };
  }
  if (paths.platform === 'windows') {
    const result = runStartupCommand('schtasks.exe', ['/Query', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
    return { supported: true, platform: paths.platform, enabled: result.status === 0, active: null, servicePath: paths.servicePath };
  }
  if (paths.platform === 'linux') {
    const enabledResult = runStartupCommand('systemctl', ['--user', 'is-enabled', 'varin.service'], { allowFailure: true });
    const activeResult = runStartupCommand('systemctl', ['--user', 'is-active', 'varin.service'], { allowFailure: true });
    const activeState = (activeResult.stdout || '').trim() || 'inactive';
    return {
      supported: true,
      platform: paths.platform,
      enabled: enabledResult.status === 0 || fs.existsSync(paths.servicePath),
      active: activeState === 'active',
      activeState,
      servicePath: paths.servicePath,
    };
  }
  return {
    supported: true,
    platform: paths.platform,
    enabled: fs.existsSync(paths.servicePath),
    active: null,
    servicePath: paths.servicePath,
  };
}

function enableStartupService(options: CliOptions = {}): StartupStatus {
  assertNodeServerRuntime();
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    removeStartupEnvFile();
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs', 'Varin'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildMacosLaunchAgent(options), { mode: 0o600 });
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${currentUserId()}`, paths.servicePath], { allowFailure: true });
    runStartupCommand('/bin/launchctl', ['bootstrap', `gui/${currentUserId()}`, paths.servicePath]);
    runStartupCommand('/bin/launchctl', ['kickstart', '-k', `gui/${currentUserId()}/${STARTUP_SERVICE_ID}`], { allowFailure: true });
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    writeStartupEnvFile(options, { quoteValue: systemdEnvFileQuote });
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildSystemdUserService(options), { mode: 0o600 });
    runStartupCommand('systemctl', ['--user', 'daemon-reload']);
    runStartupCommand('systemctl', ['--user', 'enable', '--now', 'varin.service']);
    return getStartupStatus();
  }

  const envFilePath = writeStartupEnvFile(options);
  const startupArgs = buildStartupArgs(options).map(powershellQuote).join(', ');
  const powerShellCommand = [
    `$envFile=${powershellQuote(envFilePath)}`,
    `if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $v=$matches[2]; if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v=$v.Substring(1,$v.Length-2).Replace("'\\''","'") }; [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process') } } }`,
    `& ${powershellQuote(process.execPath)} ${startupArgs}`,
  ].join('; ');
  const taskArgs = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${powerShellCommand.replace(/"/g, '\\"')}"`;
  runStartupCommand('schtasks.exe', [
    '/Create',
    '/TN', STARTUP_SERVICE_ID,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
    '/TR', taskArgs,
  ]);
  runStartupCommand('schtasks.exe', ['/Run', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  return getStartupStatus();
}

function disableStartupService(): StartupStatus {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${currentUserId()}`, paths.servicePath], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {
    // Best-effort operation; continue when it is unavailable.
  }
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    runStartupCommand('systemctl', ['--user', 'disable', '--now', 'varin.service'], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {
    // Best-effort operation; continue when it is unavailable.
  }
    runStartupCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    return getStartupStatus();
  }

  runStartupCommand('schtasks.exe', ['/End', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  runStartupCommand('schtasks.exe', ['/Delete', '/TN', STARTUP_SERVICE_ID, '/F'], { allowFailure: true });
  return getStartupStatus();
}


export {
  getStartupStatus,
  enableStartupService,
  disableStartupService,
};
