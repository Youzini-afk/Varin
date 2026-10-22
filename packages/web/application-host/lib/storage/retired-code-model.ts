import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { measureDirectory, within } from './measure.js';

/** This exact directory belonged exclusively to the retired code embedding
 * component. Speech and Bot knowledge models have different owners. New Hosts
 * neither install nor start the component; cleanup uses Storage's preview receipt. */
export async function inspectRetiredCodeModel(dataDirectory: string) {
  const parent = path.resolve(dataDirectory, 'optional-components');
  const directory = path.join(parent, 'local-semantic');
  try {
    for (const entry of [parent, directory]) {
      const info = await lstat(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Retired model cache is not an owned directory: ${entry}`);
    }
    const [root, actual] = await Promise.all([realpath(dataDirectory), realpath(directory)]);
    if (!within(root, actual) || path.relative(root, actual) !== path.join('optional-components', 'local-semantic')) {
      throw new Error('Retired model cache points outside its original application owner');
    }
    const measured = await measureDirectory(directory);
    if (measured.issues.length) throw new Error(measured.issues.join('; '));
    return { directory, ...measured };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeRetiredCodeModel(dataDirectory: string, fingerprint: string) {
  const current = await inspectRetiredCodeModel(dataDirectory);
  if (!current || current.fingerprint !== fingerprint) throw new Error('Retired model cache changed after preview; inspect cleanup candidates again');
  await rm(current.directory, { recursive: true, force: false });
  return { bytesReclaimed: current.bytes, filesDeleted: current.files.length };
}
