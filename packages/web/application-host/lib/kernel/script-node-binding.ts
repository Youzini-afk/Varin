/** The evaluator binding and spawn inputs belong to the Host that executes it. */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelProcessSpawnParams, NodeBinding } from './protocol.generated.js';

/** Hash the installed worker's JavaScript tree, including relative paths and exact bytes.
 * Ordering must not depend on the Host's locale or filesystem enumeration order. */
export async function hashScriptWorkerDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string, prefix = ''): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), `${name}/`);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        hash.update(name); hash.update('\0');
        hash.update(await readFile(join(current, entry.name))); hash.update('\0');
      }
    }
  };
  await walk(directory);
  return hash.digest('hex');
}

/** Non-secret, exact installed evaluator and Node binding. Missing or unbuilt packages
 * fail resolution; no source entry point or other Host's executable can replace them. */
export async function resolveScriptNodeBinding(): Promise<NodeBinding> {
  const { resolveVarinBuiltinPackageRoot } = await import('@varin/extension-builtins/host');
  const executable = await realpath(process.execPath);
  const worker = await realpath(resolveVarinBuiltinPackageRoot(fileURLToPath(import.meta.resolve('@varin/script-runtime/worker'))));
  const workerIdentity = await hashScriptWorkerDirectory(dirname(worker));
  const configurationIdentity = JSON.stringify({ version: 1, executable, worker, workerIdentity, nodeVersion: process.versions.node, replAwait: true });
  return { executable, worker_path: worker, worker_identity: workerIdentity, configuration_identity: configurationIdentity };
}

/** Call only on the executing Host, immediately before its original process.spawn.
 * Its inherited environment stays transient; it is never part of the durable binding. */
export function scriptNodeSpawnInput(node: NodeBinding): Pick<KernelProcessSpawnParams, 'command' | 'args' | 'env' | 'mode' | 'cols' | 'rows'> {
  return {
    command: node.executable, args: ['--experimental-repl-await', node.worker_path], mode: 'pipe', cols: 80, rows: 24,
    env: Object.entries({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })
      .flatMap(([name, value]) => value === undefined || name === 'NODE_CHANNEL_FD' ? [] : [{ name, value }]),
  };
}
