/** Native Windows installer acceptance path. This is not release eligibility. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest, sha256 } from './runtime-manifest.mjs';
import { verifyWindowsBootstrap, windowsBundleResources, installBootstrapForBundle } from './windows-bootstrap.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');

export function windowsBundleArguments({ cli, runtime, resources, bundles = ['nsis'], target }) {
  if (!Array.isArray(bundles) || !bundles.length || bundles.some(value => !['nsis', 'msi'].includes(value))) throw new Error('Only explicit Windows installer formats are accepted');
  if (target && !['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(target)) throw new Error('Unsupported Windows target');
  // A separate reset config removes the checked-in placeholder resource map.
  // CEF is already fully staged and verified in resources. Disable only the
  // upstream bundler's second CEF copy from an unrelated global SDK cache.
  // Keep the real signed bootstrap bytes untouched. Signing installers belongs
  // to the release pipeline, after all included binaries have been finalized.
  return [cli, 'bundle', '--debug', '--no-binary-patching', '--no-sign', '--ci', '--bundles', ...bundles,
    ...(target ? ['--target', target] : []),
    '--config', JSON.stringify({ build: { frontendDist: path.join(runtime, 'frontend') }, bundle: { active: true, resources: [], cef: { embed: false } } }),
    '--config', JSON.stringify({ bundle: { resources } })];
}

export async function prepareWindowsBundle({ runtime, engineDirectory, targetDirectory, cli, target, bundles, production = false }) {
  runtime = path.resolve(runtime); engineDirectory = path.resolve(engineDirectory); targetDirectory = path.resolve(targetDirectory);
  const engine = await verifyWindowsBootstrap(engineDirectory);
  // Production remains fail-closed until the complete per-target acceptance and
  // updater handoff have real receipts. A development installer is testable now.
  await verifyRuntimeManifest(runtime, { platform: 'win32', architecture: engine.architecture, production });
  if (target && (target.startsWith('aarch64') ? 'arm64' : 'x64') !== engine.architecture) throw new Error('Installer and CEF architectures differ');
  const resources = { ...await windowsBundleResources(engineDirectory), [runtime + path.sep]: 'runtime/' };
  const args = windowsBundleArguments({ cli, runtime, resources, target, bundles });
  const executable = await installBootstrapForBundle(engineDirectory, targetDirectory);
  return { executable: process.execPath, args, cwd: packageRoot, env: { ...process.env },
    bootstrap: executable, bootstrapSha256: await sha256(executable), resources };
}

export async function bundleWindowsDevelopment(options) {
  if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows; no foreign executable is run here');
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const invocation = await prepareWindowsBundle({ ...options, cli });
  const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: 'inherit' });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (status.code !== 0) throw new Error(`Windows installer build exited with ${status.signal ?? status.code}`);
  if (await sha256(invocation.bootstrap) !== invocation.bootstrapSha256) throw new Error('Bundler changed the real CEF bootstrap; discard the installer');
  // The installer may now be tested on a clean machine. Its existence cannot
  // promote release.eligible or replace a sandbox/native interaction smoke test.
  return { targetDirectory: path.resolve(options.targetDirectory), productionEligible: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = new Set(['--runtime', '--engine', '--target-directory', '--target', '--bundles']);
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!names.has(args[index]) || !args[index + 1]) throw new Error('Usage: windows-bundle.mjs --runtime DIR --engine DIR --target-directory cargo/debug [--target MSVC-TRIPLE] [--bundles nsis,msi]');
    options[args[index]] = args[index + 1];
  }
  for (const name of ['--runtime', '--engine', '--target-directory']) if (!options[name]) throw new Error(`Missing ${name}`);
  await bundleWindowsDevelopment({ runtime: options['--runtime'], engineDirectory: options['--engine'], targetDirectory: options['--target-directory'],
    target: options['--target'], bundles: options['--bundles']?.split(',') });
  console.log('[tauri] Development Windows installer built with the real sandbox bootstrap. Production acceptance remains required.');
}
