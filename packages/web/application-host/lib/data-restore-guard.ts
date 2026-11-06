import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** Offline copies retain identity and pending effects. They are not runnable clones. */
export async function assertDataRootMayStart(dataDirectory: string): Promise<void> {
  for (const marker of ['.varin-offline-restore.json', '.varin-cold-backup.lock']) {
    try {
      await lstat(path.join(dataDirectory, marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Varin data root is fenced by ${marker}. Do not start an offline copy or a cold-backup source. See the cold-backup recovery procedure.`);
  }
}
