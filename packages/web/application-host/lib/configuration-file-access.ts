import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const pending = new Map<string, Promise<void>>();

async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(await canonicalDirectory(parent), basename(path));
  }
}

/** Short, process-local access to an original configuration file. Node's Windows
 * rename cannot replace an open target even when the reader shares DELETE access. Readers
 * retain admission through handle close; writers still own their filesystem CAS
 * lock. No filesystem write permission is required for a read.
 */
export async function withConfigurationFileAccess<T>(path: string, work: () => Promise<T>): Promise<T> {
  let key = resolve(path);
  if (process.platform === 'win32') {
    // Canonicalize only the parent: opening the target to identify it would
    // itself race replacement. Include TEMP's short/long parent aliases.
    key = join(await canonicalDirectory(dirname(key)), basename(key));
    key = (key.startsWith('\\\\?\\UNC\\') ? `\\\\${key.slice(8)}` : key.startsWith('\\\\?\\') ? key.slice(4) : key).toLowerCase();
  }
  const previous = pending.get(key);
  let release!: () => void;
  const current = new Promise<void>(done => { release = done; });
  pending.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
