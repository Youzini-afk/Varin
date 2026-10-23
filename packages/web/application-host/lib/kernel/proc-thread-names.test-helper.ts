import fs from 'node:fs/promises';
import path from 'node:path';

type ThreadNameFileSystem = {
  readdir: (directory: string) => Promise<string[]>;
  readFile: (file: string, encoding: 'utf8') => Promise<string>;
  access: (directory: string) => Promise<void>;
};

export async function readProcThreadNames(taskRoot: string, io: ThreadNameFileSystem = fs): Promise<string[]> {
  const names = await Promise.all((await io.readdir(taskRoot)).map(async tid => {
    try {
      return (await io.readFile(path.join(taskRoot, tid, 'comm'), 'utf8')).trim();
    } catch (error) {
      // procfs enumeration is not atomic: unrelated short-lived threads can exit
      // before their names are read. Missing persistent workers still fail counts.
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      return null;
    }
  }));
  // Do not mistake the whole process disappearing for individual thread exits.
  await io.access(taskRoot);
  return names.filter((name): name is string => name !== null);
}
