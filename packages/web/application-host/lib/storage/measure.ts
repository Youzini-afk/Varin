import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface MeasuredFile { path: string; bytes: number; identity: string; }
export interface DirectoryMeasurement { files: MeasuredFile[]; bytes: number; fingerprint: string; issues: string[] }
/** Metadata only. Never follows a symlink or reads user file bodies. The fingerprint
 * binds cleanup to the exact observed names, inode identities, lengths and mtimes. */
export async function measureDirectory(root: string, signal?: AbortSignal): Promise<DirectoryMeasurement> {
  const files: MeasuredFile[] = [], issues: string[] = [], identities: string[] = [];
  const pending = [path.resolve(root)];
  while (pending.length) {
    signal?.throwIfAborted();
    const filename = pending.pop()!;
    try {
      const entry = await lstat(filename);
      if (entry.isSymbolicLink()) { issues.push(`Symbolic link was not followed: ${filename}`); continue; }
      const relative = path.relative(root, filename);
      identities.push(`${relative}\0${entry.dev}:${entry.ino}\0${entry.size}\0${entry.mtimeMs}\0${entry.ctimeMs}`);
      if (entry.isDirectory()) {
        for (const name of (await readdir(filename)).sort().reverse()) pending.push(path.join(filename, name));
      } else if (entry.isFile()) files.push({ path: filename, bytes: entry.size, identity: entry.ino ? `${entry.dev}:${entry.ino}` : filename });
      else issues.push(`Unsupported filesystem entry: ${filename}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // An absent optional managed root is an observed empty root. Disappearance
      // during a scan is incomplete, rather than a misleading successful zero.
      if (filename === path.resolve(root) && code === 'ENOENT') continue;
      issues.push(`${code ?? 'unavailable'}: ${filename}`);
    }
  }
  const seen = new Set<string>();
  const bytes = files.reduce((sum, file) => { if (seen.has(file.identity)) return sum; seen.add(file.identity); return sum + file.bytes; }, 0);
  return { files, bytes, fingerprint: createHash('sha256').update(identities.sort().join('\n')).digest('hex'), issues };
}
export const within = (root: string, filename: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
