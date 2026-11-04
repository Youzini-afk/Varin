import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { stageWindowsBootstrap, discoverWindowsCef } from './windows-bootstrap.mjs';
import { fileURLToPath } from 'node:url';
import { stageDesktopRuntime, defaultRuntimeDirectory } from './stage-desktop.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { frontendDist } from './frontend-dist.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');

export async function desktopInvocation(command, directory) {
  if (command !== 'dev' && command !== 'build') throw new Error('Only development dev/build are available; production distribution remains gated');
  directory = path.resolve(directory);
  await verifyRuntimeManifest(directory, { platform: process.platform, architecture: process.arch });
  // These commands never install or publish. No runtime resources are bundled;
  // a debug runtime comes
  // from its explicit, verified generation, never a shared mutable resource link.
  const config = { build: { frontendDist: frontendDist(directory) }, bundle: { active: false, resources: [] } };
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  return { executable: process.execPath, args: desktopArguments(command, cli, config, process.platform),
    cwd: packageRoot, env: { ...process.env, CEF_PATH: process.env.CEF_PATH || path.join(path.dirname(defaultRuntimeDirectory()), 'cef-cache'), VARIN_DESKTOP_RUNTIME_DIR: directory } };
}

export function desktopArguments(command, cli, config, platform) {
  const windows = platform === 'win32';
  // Windows dev runs a real official bootstrap after a native build. Never run
  // Cargo's intentionally non-runnable build sentinel or relax the sandbox.
  return [cli, windows ? 'build' : command,
    ...(windows || command === 'build' ? ['--debug', '--no-bundle'] : ['--no-watch']),
    '--features', 'desktop', '--config', JSON.stringify(config), ...(windows ? ['--', '--lib'] : [])];
}

async function execute(invocation) {
  const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: 'inherit', windowsHide: false });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const onInterrupt = () => forward('SIGINT'), onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    if (status.code !== 0) throw new Error(`Desktop process exited with ${status.signal ?? status.code}`);
  } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
}

export async function runDesktop(command, { runtime } = {}) {
  if (command !== 'dev' && command !== 'build') throw new Error('Usage: desktop.mjs dev|build [--runtime prepared-directory]');
  let directory;
  if (runtime) directory = path.resolve(runtime);
  else {
    const generationRoot = path.join(path.dirname(defaultRuntimeDirectory()), 'generations');
    await fs.mkdir(generationRoot, { recursive: true });
    const generation = await fs.mkdtemp(path.join(generationRoot, 'development-'));
    try { directory = (await stageDesktopRuntime({ destination: path.join(generation, 'runtime') })).directory; }
    catch (error) { await fs.rm(generation, { recursive: true, force: true }); throw error; }
  }
  const invocation = await desktopInvocation(command, directory);
  console.log(`[tauri] development runtime: ${directory}`);
  await execute(invocation);
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(process.env.CARGO || 'cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      cwd: path.join(packageRoot, 'src-tauri'), env: invocation.env, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const metadata = JSON.parse(stdout);
    const targetDirectory = path.join(metadata.target_directory, ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []), 'debug');
    const cefDirectory = await discoverWindowsCef({ configured: invocation.env.CEF_PATH, targetDirectory, architecture: process.arch });
    const stages = path.join(targetDirectory, 'varin-bootstrap'); await fs.mkdir(stages, { recursive: true });
    const stage = await stageWindowsBootstrap({ cefDirectory, targetDirectory, architecture: process.arch, destination: path.join(stages, randomUUID()) });
    if (command === 'dev') await execute({ executable: stage.executable, args: [], cwd: stage.directory,
      env: { ...invocation.env, CEF_PATH: stage.directory } });
    console.log(`[tauri] Sandboxed Windows executable: ${stage.executable}`);
    return { directory, executable: stage.executable, engineDirectory: stage.directory };
  }
  if (command === 'build') console.log(`[tauri] Debug executable built without an installer. Run with VARIN_DESKTOP_RUNTIME_DIR=${directory}`);
  return { directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--runtime' || !args[1])) throw new Error('Usage: desktop.mjs dev|build [--runtime prepared-directory]');
  await runDesktop(command, { runtime: args[1] });
}
