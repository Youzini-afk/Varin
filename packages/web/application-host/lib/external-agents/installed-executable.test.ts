import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { findDesktopCodexExecutable } from './installed-executable.js';

it('finds the newer desktop CLI when old and unrelated tool directories remain after updates', async () => {
  const localAppData = await mkdtemp(path.join(tmpdir(), 'varin-desktop-codex-'));
  try {
    const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    const addFile = async (directory: string, filename: string, modifiedAt: number) => {
      const folder = path.join(root, directory);
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, filename);
      await writeFile(file, '');
      await utimes(file, modifiedAt, modifiedAt);
      return file;
    };
    await addFile('old', 'codex.exe', 1_700_000_000);
    const current = await addFile('current', 'codex.exe', 1_710_000_000);
    await addFile('tools', 'rg.exe', 1_720_000_000);
    expect(await findDesktopCodexExecutable(localAppData)).toBe(current);
  } finally {
    await rm(localAppData, { recursive: true, force: true });
  }
});
