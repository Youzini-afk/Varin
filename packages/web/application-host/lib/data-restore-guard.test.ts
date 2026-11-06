import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertDataRootMayStart } from './data-restore-guard.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('allows ordinary roots but refuses every form of an offline-copy or backup fence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-restore-fence-'));
  roots.push(root);
  await assertDataRootMayStart(root);
  const marker = path.join(root, '.varin-offline-restore.json');
  await writeFile(marker, 'malformed');
  await expect(assertDataRootMayStart(root)).rejects.toThrow('fenced');
  await rm(marker);
  await symlink('missing', marker);
  await expect(assertDataRootMayStart(root)).rejects.toThrow('fenced');
  await rm(marker);
  await mkdir(path.join(root, '.varin-cold-backup.lock'));
  await expect(assertDataRootMayStart(root)).rejects.toThrow('fenced');
});

it('the real Host startup rejects an offline copy before opening stores or creating identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-restore-startup-'));
  roots.push(root);
  await writeFile(path.join(root, '.varin-offline-restore.json'), '{}');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { startWebUiServer } = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
    await assert.rejects(startWebUiServer({ port: 0, apiOnly: true, attachSignals: false }), /data root is fenced/);
  `], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, VARIN_DATA_DIR: root } });
  expect(child.error ?? child.status, child.stderr).toBe(0);
  expect(await readdir(root)).toEqual(['.varin-offline-restore.json']);
});
