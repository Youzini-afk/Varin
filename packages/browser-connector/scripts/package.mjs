import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['extension', 'native']) await cp(join(root, name), join(output, name), { recursive: true });
const manifest = JSON.parse(await readFile(join(output, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(join(output, 'extension/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// Native compilation is explicit, build-time only; startup never installs tools.
const index = process.argv.indexOf('--compile');
if (index >= 0) {
  const target = process.argv[index + 1];
  if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64'].includes(target)) throw new Error('Choose a supported Bun native target');
  const executable = join(output, `varin-browser-connector${target.startsWith('windows') ? '.exe' : ''}`);
  const result = spawnSync('bun', ['build', join(root, 'native/main.mjs'), '--compile', `--target=bun-${target}`, '--outfile', executable], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Native compilation requires the repository-pinned Bun toolchain');
}
console.log(`Browser connector files prepared at ${output}`);
