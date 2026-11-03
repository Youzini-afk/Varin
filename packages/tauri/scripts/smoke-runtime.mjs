import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest, hostPackage } from './runtime-manifest.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');

/** Exercise real packaged Node-API, worker IPC and Rust authority, never user data. */
export async function smokeDesktopRuntime(directory, { checks = ['kernel', 'knowledge', 'extension-broker'] } = {}) {
  const known = ['kernel', 'knowledge', 'extension-broker'];
  if (!Array.isArray(checks) || !checks.length || checks.some(name => !known.includes(name)) || new Set(checks).size !== checks.length) throw new Error('Unknown or duplicate runtime smoke check');
  directory = path.resolve(directory);
  const manifest = await verifyRuntimeManifest(directory, { platform: process.platform, architecture: process.arch });
  const node = path.join(directory, manifest.node.executable);
  const webRoot = path.join(directory, hostPackage);
  const env = { ...process.env, VARIN_NODE_PATH: node, VARIN_KERNEL_PATH: path.join(directory, manifest.kernel.executable),
    VARIN_DIST_DIR: path.join(directory, manifest.frontend.directory), VARIN_RESOURCES_PATH: directory, VARIN_RUNTIME: 'desktop' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const version = execFileSync(node, ['--version'], { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 }).trim();
  if (version !== `v${manifest.node.version}`) throw new Error(`Packaged Node returned unexpected version: ${version}`);
  const ripgrep = execFileSync(path.join(directory, manifest.tools.ripgrep), ['--version'], { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 });
  if (!ripgrep.startsWith('ripgrep ')) throw new Error('Bundled native ripgrep did not execute');
  const run = (script, args, timeout) => execFileSync(node, [path.join(repository, script), ...args], {
    cwd: directory, env, stdio: 'inherit', windowsHide: true, timeout,
  });
  const suites = {
    kernel: ['scripts/smoke-kernel-release.mjs', [webRoot, path.join(directory, 'kernel')], 120_000],
    knowledge: ['packages/electron/scripts/verify-knowledge-runtime.mjs', [webRoot], 30_000],
    'extension-broker': ['packages/electron/scripts/verify-extension-broker.mjs', [path.join(directory, 'host/node_modules/@varin/extension-host')], 30_000],
  };
  const results = Object.fromEntries(known.map(name => [name, { status: 'not-run' }]));
  for (const name of checks) {
    try { run(...suites[name]); results[name] = { status: 'passed' }; }
    catch (error) { results[name] = { status: 'failed', exitCode: error.status ?? null, signal: error.signal ?? null }; }
  }
  return { platform: manifest.platform, architecture: manifest.architecture, node: manifest.node.version,
    ripgrep: true, complete: checks.length === known.length, ok: checks.every(name => results[name].status === 'passed'), checks: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || args[1] && !args[1].startsWith('--checks=')) throw new Error('Usage: smoke-runtime.mjs <runtime-directory> [--checks=kernel,knowledge,extension-broker]');
  const result = await smokeDesktopRuntime(args[0], args[1] ? { checks: args[1].slice('--checks='.length).split(',') } : {});
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
