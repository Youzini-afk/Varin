import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const directory of ['extension', 'scripts', 'test']) for (const name of await readdir(join(root, directory))) {
  if (!name.endsWith('.mjs')) continue;
  const result = spawnSync(process.execPath, ['--check', join(root, directory, name)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
