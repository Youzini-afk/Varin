/** Shared installed-application discovery and opening. Native icon/default-open
 * primitives are injected; caches and launch selection retain their Node owner. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { unsupportedAppSpecificOpenError, validateLocalPath } from './path-open-utils.js';
import {
  buildLinuxInstalledApps,
  buildLinuxOpenSpecs,
  fetchLinuxAppIcons,
  filterLinuxInstalledApps,
  readLinuxDesktopEntries,
  type InstalledAppInfo,
  type LinuxDesktopEntry,
  type LinuxOpenSpec,
} from './linux-app-discovery.js';
const execFileAsync = promisify(execFile);
const INSTALLED_APPS_CACHE_TTL_SECS = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE = 'discovered-apps.json';
const LINUX_DESKTOP_ENTRIES_CACHE_TTL_MS = 30_000;
export interface DesktopAppLaunch { program: string; args: string[]; waitForExit: boolean; windowsVerbatimArguments?: boolean }
export interface DesktopAppsOwner { invoke(input: unknown): Promise<unknown>; dispose(): Promise<void> }
export function createDesktopAppsOwner(options: {
  dataDirectory: string;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  fileIcon(path: string): Promise<string | null>;
  updated(apps: InstalledAppInfo[]): void;
  /** User-launched applications run outside the managed Node process scope. */
  launchApp?(input: DesktopAppLaunch): Promise<void>;
}): DesktopAppsOwner {
let refreshing: Promise<void> | undefined;
let disposed = false;
const buildInstalledAppsCachePath = () => path.join(options.dataDirectory, INSTALLED_APPS_CACHE_FILE);

// Async variants. sips + mdfind via spawnSync blocked the Electron main event
// loop for 2-3s on boot (22 OPEN_IN_APPS × ~200 ms each). Use execFile promises
// so each child-process wait yields to the loop and the UI stays responsive.
const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const resolveAppBundlePath = async (appName: string): Promise<string | null> => {
  if (process.platform !== 'darwin') return null;
  const bundleName = appName.endsWith('.app') ? appName : `${appName}.app`;
  const candidates = [
    `/Applications/${bundleName}`,
    `/System/Applications/${bundleName}`,
    `/System/Applications/Utilities/${bundleName}`,
    path.join(os.homedir(), 'Applications', bundleName),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync('mdfind', ['-name', bundleName], { encoding: 'utf8' });
    const first = (stdout || '').split('\n').map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
};

const isAppBundleInstalled = async (appName: string): Promise<boolean> => Boolean(await resolveAppBundlePath(appName));

const iconToDataUrl = async (iconPath: string | null, appName: string): Promise<string | null> => {
  if (!iconPath || !(await pathExists(iconPath))) return null;
  const safeName = String(appName || 'app').replace(/[^a-z0-9]/gi, '_');
  const tempPath = path.join(os.tmpdir(), `varin-icon-${safeName}-${Date.now()}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '32', iconPath, '--out', tempPath]);
  } catch {
    return null;
  }
  if (!(await pathExists(tempPath))) return null;
  try {
    const bytes = await fsp.readFile(tempPath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
};

const resolveAppIconPath = async (appPath: string): Promise<string | null> => {
  if (!appPath || !(await pathExists(appPath))) return null;
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  if (!(await pathExists(resourcesPath))) return null;
  let entries;
  try {
    entries = await fsp.readdir(resourcesPath);
  } catch {
    return null;
  }
  const icon = entries.find((entry) => entry.toLowerCase().endsWith('.icns'));
  return icon ? path.join(resourcesPath, icon) : null;
};

const buildInstalledApps = async (apps: unknown): Promise<InstalledAppInfo[]> => {
  const seen = new Set<string>();
  const names = (Array.isArray(apps) ? apps : [])
    .map((raw) => String(raw || '').trim())
    .filter((raw) => raw && !seen.has(raw) && seen.add(raw));
  const results: InstalledAppInfo[] = [];
  for (const name of names) {
    const appPath = await resolveAppBundlePath(name);
    if (!appPath) continue;
    const iconDataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), name);
    results.push({ name, iconDataUrl });
  }
  return results;
};

let linuxDesktopEntriesCache: { entries: LinuxDesktopEntry[] | null; expiresAt: number } = { expiresAt: 0, entries: null };

const getLinuxDesktopEntries = async (): Promise<LinuxDesktopEntry[]> => {
  const now = Date.now();
  if (linuxDesktopEntriesCache.entries && linuxDesktopEntriesCache.expiresAt > now) {
    return linuxDesktopEntriesCache.entries;
  }
  const entries = await readLinuxDesktopEntries();
  linuxDesktopEntriesCache = { entries, expiresAt: now + LINUX_DESKTOP_ENTRIES_CACHE_TTL_MS };
  return entries;
};

const buildPlatformInstalledApps = async (apps: unknown): Promise<InstalledAppInfo[]> => {
  if (process.platform === 'linux') {
    return buildLinuxInstalledApps(apps);
  }
  if (process.platform === 'win32') {
    return buildWindowsInstalledApps(apps);
  }
  return buildInstalledApps(apps);
};

const spawnDetachedLinux = (program: string, args: string[]): Promise<void> => options.launchApp
  ? options.launchApp({ program, args, waitForExit: false })
  : new Promise<void>((resolve, reject) => {
  const child = spawn(program, args, {
    detached: true,
    stdio: 'ignore',
  });
  let settled = false;
  const finish = (callback: (value?: unknown) => void, value?: unknown): void => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  child.once('error', (error) => finish(reject, error));
  child.once('spawn', () => {
    child.unref();
    if (!settled) {
      settled = true;
      resolve();
    }
  });
});

const isDefaultLinuxOpenSpec = (
  spec: LinuxOpenSpec,
): spec is Extract<LinuxOpenSpec, { kind: 'default' }> => 'kind' in spec;

const runLinuxSpecChain = async (specs: LinuxOpenSpec[], appName: string): Promise<void> => {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(`Failed to open in ${appName}: no launch candidates`);
  }

  const failures: string[] = [];
  for (const spec of specs) {
    if (isDefaultLinuxOpenSpec(spec)) {
      if (spec.targetKind === 'file') {
        await options.showItemInFolder(spec.targetPath);
        return;
      }
      try { await options.openPath(spec.targetPath); return; }
      catch (error) { failures.push(`default opener: ${error instanceof Error ? error.message : String(error)}`); }
      continue;
    }

    try {
      await spawnDetachedLinux(spec.program, spec.args);
      return;
    } catch (error) {
      failures.push(`${spec.program}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
};

const JETBRAINS_APP_IDS = new Set([
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rider',
  'rustrover',
  'android-studio',
]);

const CLI_BY_APP_ID: Record<string, string> = {
  vscode: 'code',
  cursor: 'cursor',
  vscodium: 'codium',
  windsurf: 'windsurf',
  zed: 'zed',
};

const WINDOWS_CLI_BY_APP_ID: Record<string, string> = {
  vscode: 'code.cmd',
  cursor: 'cursor.cmd',
  vscodium: 'codium.cmd',
  windsurf: 'windsurf.cmd',
  zed: 'zed.cmd',
};

const WINDOWS_APP_EXECUTABLES: Record<string, readonly string[]> = {
  terminal: ['wt.exe', 'WindowsTerminal.exe'],
  vscode: ['code.exe', 'code.cmd'],
  cursor: ['cursor.exe', 'cursor.cmd'],
  vscodium: ['codium.exe', 'codium.cmd'],
  windsurf: ['windsurf.exe', 'windsurf.cmd'],
  zed: ['zed.exe', 'zed.cmd'],
  'visual-studio': ['devenv.exe'],
  'sublime-text': ['subl.exe', 'sublime_text.exe'],
};

const WINDOWS_APP_ID_BY_NAME = new Map<string, string>([
  ['finder', 'finder'],
  ['file explorer', 'finder'],
  ['terminal', 'terminal'],
  ['windows terminal', 'terminal'],
  ['visual studio code', 'vscode'],
  ['cursor', 'cursor'],
  ['vscodium', 'vscodium'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
  ['visual studio', 'visual-studio'],
  ['sublime text', 'sublime-text'],
]);

const getWindowsAppIdForName = (appName: unknown): string => WINDOWS_APP_ID_BY_NAME.get(String(appName || '').trim().toLowerCase()) || '';

const runWhere = (program: string): string | null => {
  const result = spawnSync('where.exe', [program], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const first = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
};

const findWindowsExecutable = (appId: string): string | null => {
  for (const program of WINDOWS_APP_EXECUTABLES[appId] || []) {
    const resolved = runWhere(program);
    if (resolved) return resolved;
  }
  return null;
};

const resolveWindowsScriptIconExecutable = (scriptPath: string): string | null => {
  if (!scriptPath || !/\.(?:cmd|bat)$/i.test(scriptPath)) return null;
  let source = '';
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
  const scriptDir = path.dirname(scriptPath);
  const matches = [...source.matchAll(/(?:(?:%~dp0|%~dp0\\|%~dp0\/|\.\.\\|\.\.\/|[A-Za-z]:\\|[A-Za-z]:\/)[^"'\r\n]*?\.exe)/gi)];
  for (const match of matches) {
    const raw = String(match[0] || '').replace(/^%~dp0[\\/]?/i, '').trim();
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(scriptDir, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

let windowsTerminalPackagePathCache: string | null | undefined;

const resolveWindowsTerminalPackagePath = () => {
  if (windowsTerminalPackagePathCache !== undefined) return windowsTerminalPackagePathCache;

  const powershell = runWhere('powershell.exe') || runWhere('pwsh.exe');
  if (powershell) {
    const command = '$packages = @(' +
      'Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue;' +
      'Get-AppxPackage -Name Microsoft.WindowsTerminalPreview -ErrorAction SilentlyContinue' +
      ') | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending; ' +
      'if ($packages) { $packages[0].InstallLocation }';
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      const packagePath = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (packagePath && fs.existsSync(packagePath)) {
        windowsTerminalPackagePathCache = packagePath;
        return windowsTerminalPackagePathCache;
      }
    }
  }

  const programFilesRoots = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files']
    .filter((value, index, values): value is string => typeof value === 'string' && Boolean(value) && values.indexOf(value) === index);
  for (const root of programFilesRoots) {
    const windowsAppsPath = path.join(root, 'WindowsApps');
    let entries = [];
    try {
      entries = fs.readdirSync(windowsAppsPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const packageNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^Microsoft\.WindowsTerminal(?:Preview)?_.*__8wekyb3d8bbwe$/i.test(name))
      .sort()
      .reverse();
    const stable = packageNames.find((name) => /^Microsoft\.WindowsTerminal_/i.test(name));
    const selected = stable || packageNames[0];
    if (selected) {
      windowsTerminalPackagePathCache = path.join(windowsAppsPath, selected);
      return windowsTerminalPackagePathCache;
    }
  }

  windowsTerminalPackagePathCache = null;
  return windowsTerminalPackagePathCache;
};

const resolveWindowsTerminalIconPath = () => {
  const packagePath = resolveWindowsTerminalPackagePath();
  if (!packagePath) return null;
  const candidates = [
    path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96_altform-unplated.png'),
    path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96.png'),
    path.join(packagePath, 'Images', 'StoreLogo.scale-200.png'),
    path.join(packagePath, 'Images', 'StoreLogo.scale-100.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const resolveWindowsTerminalExecutable = () => {
  const packagePath = resolveWindowsTerminalPackagePath();
  if (packagePath) {
    const executable = path.join(packagePath, 'WindowsTerminal.exe');
    if (fs.existsSync(executable)) return executable;
  }
  return findWindowsExecutable('terminal');
};

const imageFileToDataUrl = (filePath: string | null): string | null => {
  if (!filePath) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
};

interface AppOpenIdentity { appId: string; appName: string }
interface ProjectOpenIdentity extends AppOpenIdentity { projectPath: string }
interface FileOpenIdentity extends AppOpenIdentity { filePath: string }
interface LaunchSpec { args: string[]; program: string; shellStart?: boolean | undefined }

const resolveWindowsAppIconExecutable = ({ appId, appName }: AppOpenIdentity): string | null => {
  if (appId === 'finder') {
    const explorerPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    return fs.existsSync(explorerPath) ? explorerPath : 'explorer.exe';
  }
  if (appId === 'terminal') {
    return resolveWindowsTerminalExecutable();
  }

  const executable = findWindowsExecutable(appId) || findWindowsAppNameExecutable(appName);
  if (!executable) return null;
  if (/\.exe$/i.test(executable)) return executable;
  return resolveWindowsScriptIconExecutable(executable) || executable;
};

const windowsIconToDataUrl = async (executablePath: string | null): Promise<string | null> => {
  if (!executablePath) return null;
  try {
    return await options.fileIcon(executablePath);
  } catch {
    return null;
  }
};

const findWindowsAppNameExecutable = (appName: string): string | null => {
  const program = `${String(appName || '').trim()}.exe`.replace(/\s+/g, '');
  return program === '.exe' ? null : runWhere(program);
};

const isWindowsAppInstalled = ({ appId, appName }: AppOpenIdentity): boolean => {
  if (appId === 'finder') return true;
  if (appId === 'terminal') return Boolean(findWindowsExecutable('terminal'));
  if (findWindowsExecutable(appId)) return true;
  return Boolean(findWindowsAppNameExecutable(appName));
};

const buildWindowsInstalledApps = async (apps: unknown): Promise<InstalledAppInfo[]> => {
  const seen = new Set<string>();
  const names = (Array.isArray(apps) ? apps : [])
    .map((appName) => String(appName || '').trim())
    .filter((appName) => appName && !seen.has(appName) && seen.add(appName))
    .filter((appName) => isWindowsAppInstalled({ appId: getWindowsAppIdForName(appName), appName }));
  const results: InstalledAppInfo[] = [];
  for (const name of names) {
    const appId = getWindowsAppIdForName(name);
    const executablePath = resolveWindowsAppIconExecutable({ appId, appName: name });
    const iconDataUrl = appId === 'terminal'
      ? imageFileToDataUrl(resolveWindowsTerminalIconPath()) || await windowsIconToDataUrl(executablePath)
      : await windowsIconToDataUrl(executablePath);
    results.push({ name, iconDataUrl });
  }
  return results;
};

const buildWindowsOpenProjectSpecs = ({ projectPath, appId, appName }: ProjectOpenIdentity): LaunchSpec[] => {
  if (appId === 'finder') {
    return [{ program: 'explorer.exe', args: [projectPath] }];
  }
  if (appId === 'terminal') {
    const specs: LaunchSpec[] = [];
    const terminal = findWindowsExecutable('terminal');
    if (terminal) {
      specs.push({ program: terminal, args: ['-d', projectPath] });
    }
    const shell = runWhere('pwsh.exe') || runWhere('powershell.exe');
    if (shell) {
      specs.push({ program: shell, args: ['-NoExit', '-Command', `Set-Location -LiteralPath ${JSON.stringify(projectPath)}`], shellStart: true });
    }
    const commandPrompt = process.env.ComSpec || runWhere('cmd.exe');
    if (commandPrompt) {
      specs.push({ program: commandPrompt, args: ['/k', 'cd', '/d', projectPath], shellStart: true });
    }
    return specs;
  }
  const specs: LaunchSpec[] = [];
  const cli = WINDOWS_CLI_BY_APP_ID[appId];
  if (cli) {
    const resolvedCli = runWhere(cli);
    if (resolvedCli) {
      specs.push({ program: resolvedCli, args: [projectPath] });
    }
  }
  const exe = findWindowsExecutable(appId);
  if (exe) {
    specs.push({ program: exe, args: [projectPath] });
  }
  const namedExe = findWindowsAppNameExecutable(appName);
  if (namedExe && !specs.some((spec) => spec.program === namedExe)) {
    specs.push({ program: namedExe, args: [projectPath] });
  }
  return specs;
};

const buildWindowsOpenFileSpecs = ({ filePath, appId, appName }: FileOpenIdentity): LaunchSpec[] => {
  if (appId === 'finder') {
    return [{ program: 'explorer.exe', args: ['/select,', filePath] }];
  }
  if (appId === 'terminal') {
    return buildWindowsOpenProjectSpecs({ projectPath: path.dirname(filePath), appId, appName });
  }
  const specs: LaunchSpec[] = [];
  const cli = WINDOWS_CLI_BY_APP_ID[appId];
  if (cli) {
    const resolvedCli = runWhere(cli);
    if (resolvedCli) {
      specs.push({ program: resolvedCli, args: [filePath] });
    }
  }
  const exe = findWindowsExecutable(appId);
  if (exe) {
    specs.push({ program: exe, args: [filePath] });
  }
  const namedExe = findWindowsAppNameExecutable(appName);
  if (namedExe && !specs.some((spec) => spec.program === namedExe)) {
    specs.push({ program: namedExe, args: [filePath] });
  }
  return specs;
};

const buildOpenProjectSpecs = ({ projectPath, appId, appName }: ProjectOpenIdentity): LaunchSpec[] => {
  if (appId === 'finder') {
    return [{ program: 'open', args: [projectPath] }];
  }

  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, projectPath] }];
  }

  const specs: LaunchSpec[] = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: ['-n', projectPath] });
  }

  if (JETBRAINS_APP_IDS.has(appId)) {
    specs.push({ program: 'open', args: ['-na', appName, '--args', projectPath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, projectPath] });
  return specs;
};

const buildOpenFileSpecs = ({ filePath, appId, appName }: FileOpenIdentity): LaunchSpec[] => {
  if (appId === 'finder') {
    return [{ program: 'open', args: ['-R', filePath] }];
  }

  const parentDir = path.dirname(filePath);
  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, parentDir] }];
  }

  const specs: LaunchSpec[] = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: [filePath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, filePath] });
  return specs;
};

const quoteWindowsCommandArg = (value: unknown): string => `"${String(value).replace(/"/g, '""')}"`;

const resolveWindowsLaunchProgram = (program: string): string | null => {
  if (path.isAbsolute(program)) {
    return fs.existsSync(program) ? program : null;
  }
  return runWhere(program);
};

const launchWindowsCommandScript = async (spec: LaunchSpec, program: string): Promise<void> => {
  const commandLine = ['call', quoteWindowsCommandArg(program), ...spec.args.map(quoteWindowsCommandArg)].join(' ');
  if (options.launchApp) return options.launchApp({ program: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine], waitForExit: false, windowsVerbatimArguments: true });
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  child.unref();
};

const launchWindowsSpec = async (spec: LaunchSpec): Promise<void> => {
  const program = resolveWindowsLaunchProgram(spec.program);
  if (!program) {
    throw new Error('program not found');
  }

  if (spec.shellStart) {
    const commandLine = ['start', '""', quoteWindowsCommandArg(program), ...spec.args.map(quoteWindowsCommandArg)].join(' ');
    if (options.launchApp) return options.launchApp({ program: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine], waitForExit: false, windowsVerbatimArguments: true });
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }

  if (/\.(cmd|bat)$/i.test(program)) {
    await launchWindowsCommandScript(spec, program);
    return;
  }

  if (options.launchApp) return options.launchApp({ program, args: spec.args, waitForExit: false });
  const child = spawn(program, spec.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
};

const runSpecChain = async (specs: LaunchSpec[], appName: string): Promise<void> => {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(`Failed to open in ${appName}: no launch candidates`);
  }

  if (process.platform === 'win32') {
    const failures: string[] = [];
    for (const spec of specs) {
      try {
        await launchWindowsSpec(spec);
        return;
      } catch (error) {
        failures.push(`${spec.program}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
  }

  const failures: string[] = [];
  for (const spec of specs) {
    if (options.launchApp) {
      try { await options.launchApp({ program: spec.program, args: spec.args, waitForExit: true }); return; }
      catch (error) { failures.push(`${spec.program}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    }
    const result = spawnSync(spec.program, spec.args, { stdio: 'ignore', windowsHide: true });
    if (result.error) {
      failures.push(`${spec.program}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0) {
      return;
    }
    failures.push(`${spec.program} exited ${result.status}`);
  }
  throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
};


const invoke = async (input: unknown): Promise<unknown> => {
    if (disposed) throw new Error('Desktop applications owner is stopped');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid desktop applications request');
    const value = input as { command?: unknown; args?: unknown };
    if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) throw new Error('Invalid desktop applications arguments');
    const args = (value.args ?? {}) as Record<string, unknown>;
    switch (value.command) {
    case 'desktop_open_in_app': {
      const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!projectPath || !appId || !appName) {
        throw new Error('Project path, app id, and app name are required');
      }
      const validated = await validateLocalPath(projectPath, 'Project path');
      if (process.platform === 'win32') {
        if (appId === 'finder') {
          await options.openPath(validated.path);
          return null;
        }
        await runSpecChain(buildWindowsOpenProjectSpecs({ projectPath: validated.path, appId, appName }), appName);
        return null;
      }
      if (process.platform === 'linux') {
        const entries = await getLinuxDesktopEntries();
        await runLinuxSpecChain(buildLinuxOpenSpecs({
          targetPath: validated.path,
          appId,
          appName,
          targetKind: 'project',
          entries,
        }), appName);
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error(unsupportedAppSpecificOpenError('projects'));
      }
      await runSpecChain(buildOpenProjectSpecs({ projectPath: validated.path, appId, appName }), appName);
      return null;
    }

    case 'desktop_open_file_in_app': {
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!filePath || !appId || !appName) {
        throw new Error('File path, app id, and app name are required');
      }
      const validated = await validateLocalPath(filePath, 'File path');
      if (process.platform === 'win32') {
        await runSpecChain(buildWindowsOpenFileSpecs({ filePath: validated.path, appId, appName }), appName);
        return null;
      }
      if (process.platform === 'linux') {
        const entries = await getLinuxDesktopEntries();
        await runLinuxSpecChain(buildLinuxOpenSpecs({
          targetPath: validated.path,
          appId,
          appName,
          targetKind: 'file',
          entries,
        }), appName);
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error(unsupportedAppSpecificOpenError('files'));
      }
      await runSpecChain(buildOpenFileSpecs({ filePath: validated.path, appId, appName }), appName);
      return null;
    }

    case 'desktop_filter_installed_apps': {
      if (process.platform === 'win32') {
        return (await buildWindowsInstalledApps(args.apps)).map((app) => app.name);
      }
      if (process.platform === 'linux') {
        return filterLinuxInstalledApps(args.apps);
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_filter_installed_apps is only supported on macOS, Windows, and Linux');
      }
      if (!Array.isArray(args.apps)) return [];
      const results = await Promise.all(
        args.apps.map(async (appName) => (await isAppBundleInstalled(String(appName))) ? String(appName) : null)
      );
      return results.filter((result): result is string => typeof result === 'string');
    }

    case 'desktop_fetch_app_icons': {
      if (process.platform === 'win32') {
        const names = Array.isArray(args.apps) ? args.apps : [];
        const results = [];
        for (const name of names) {
          const appName = String(name || '').trim();
          if (!appName) continue;
          const appId = getWindowsAppIdForName(appName);
          const dataUrl = appId === 'terminal'
            ? imageFileToDataUrl(resolveWindowsTerminalIconPath()) || await windowsIconToDataUrl(resolveWindowsAppIconExecutable({ appId, appName }))
            : await windowsIconToDataUrl(resolveWindowsAppIconExecutable({ appId, appName }));
          if (dataUrl) results.push({ app: appName, data_url: dataUrl });
        }
        return results;
      }
      if (process.platform === 'linux') {
        return fetchLinuxAppIcons(Array.isArray(args.apps) ? args.apps : []);
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_fetch_app_icons is only supported on macOS, Windows, and Linux');
      }
      const names = Array.isArray(args.apps) ? args.apps : [];
      const results = [];
      for (const name of names) {
        const appPath = await resolveAppBundlePath(String(name));
        if (!appPath) continue;
        const dataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), String(name));
        if (dataUrl) results.push({ app: String(name), dataUrl });
      }
      return results;
    }

    case 'desktop_get_installed_apps': {
      const cachePath = buildInstalledAppsCachePath();
      const now = Math.floor(Date.now() / 1000);
      let cache = null;
      try {
        cache = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      } catch {
        /* cache missing or corrupt; treat as no cache and refresh */
      }
      const cachedApps = Array.isArray(cache?.apps) ? cache.apps : [];
      const hasCache = Boolean(cache);
      const isCacheStale = !cache || (now - Number(cache.updatedAt || 0)) > INSTALLED_APPS_CACHE_TTL_SECS;
      const refresh = () => refreshing ??= (async () => {
        const apps = await buildPlatformInstalledApps(Array.isArray(args.apps) ? args.apps : []);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, JSON.stringify({ updatedAt: now, apps }, null, 2));
        options.updated(apps);
      })().finally(() => { refreshing = undefined; });
      if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
        return { apps: [], hasCache: false, isCacheStale: false, supported: false };
      }
      if (!hasCache || isCacheStale || args.force === true) {
        void refresh().catch(() => { /* Preserve the prior cache; the next request retries. */ });
      }
      return { apps: cachedApps, hasCache, isCacheStale };
    }


      default: throw new Error('Unknown desktop applications operation');
    }
};
const inFlight = new Set<Promise<unknown>>();
return {
  invoke(input) {
    const pending = invoke(input); inFlight.add(pending);
    void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  },
  async dispose() { disposed = true; await Promise.all([...inFlight, ...(refreshing ? [refreshing] : [])]); },
};
}
