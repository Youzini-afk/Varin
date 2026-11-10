/** The evaluator binding and spawn inputs belong to the Host that executes it. */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
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

/** Restore only a trusted original Catalog binding on its executing Host. This is
 * not an API for callers to choose an executable or grant access to a worker path.
 * In particular, managed-source clients must still use their target Host's resolver.
 * The v1 contract captured worker bytes, not its external dependency closure; do
 * not invent a new identity for already accepted work during restoration. */
export async function restoreScriptNodeBinding(original: string | null | undefined): Promise<NodeBinding> {
  try {
    if (typeof original !== 'string') throw new Error('Missing original binding');
    const saved: unknown = JSON.parse(original);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid original binding');
    const value = saved as Record<string, unknown>;
    const executable = await realpath(process.execPath);
    if (value.version !== 1 || value.executable !== executable || value.nodeVersion !== process.versions.node
      || value.replAwait !== true || typeof value.worker !== 'string' || !isAbsolute(value.worker)
      || normalize(value.worker) !== value.worker || basename(value.worker) !== 'worker.js'
      || typeof value.workerIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.workerIdentity)) {
      throw new Error('Original Node or worker identity changed');
    }
    const worker = await realpath(value.worker);
    if (worker !== value.worker) throw new Error('Original worker path changed');
    const workerIdentity = await hashScriptWorkerDirectory(dirname(worker));
    const configurationIdentity = JSON.stringify({ version: 1, executable, worker, workerIdentity, nodeVersion: process.versions.node, replAwait: true });
    if (configurationIdentity !== original) throw new Error('Original worker identity changed');
    return { executable, worker_path: worker, worker_identity: workerIdentity, configuration_identity: original };
  } catch {
    // Keep filesystem locations and malformed stored values out of public failures.
    throw new Error('Original script Node binding is unavailable');
  }
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
