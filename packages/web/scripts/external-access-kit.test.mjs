import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildExternalAccessDownloads, kitArchivePath, kitFiles } from './external-access-kit.mjs';

function members(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let pos = 0;
  while (tar[pos]) {
    const header = tar.subarray(pos, pos + 512);
    const name = header.toString('ascii', 0, 100).split('\0')[0];
    const mode = parseInt(header.toString('ascii', 100, 108), 8);
    const size = parseInt(header.toString('ascii', 124, 136), 8);
    assert.equal(header[156], 0x30, 'ordinary files only');
    assert.equal(header.toString('ascii', 257, 263), 'ustar\0');
    const sum = Buffer.from(header);
    sum.fill(32, 148, 156);
    assert.equal(sum.reduce((a, b) => a + b, 0), parseInt(header.toString('ascii', 148, 156), 8));
    files.set(name, { mode, data: tar.toString('utf8', pos + 512, pos + 512 + size) });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(pos).equals(Buffer.alloc(1024)));
  return files;
}

test('downloads package exactly the deterministic public kit, no adjacent operator files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'varin-deploy-kit-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const file of kitFiles) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `shipped template ${file}\n`);
  }
  await writeFile(join(root, '.env'), 'private real token, must never build');
  const output = await buildExternalAccessDownloads(root);
  const archive = output.get(kitArchivePath);
  const extracted = members(archive);
  assert.deepEqual([...extracted.keys()], kitFiles.map(file => `varin-external-access/${file}`));
  for (const file of kitFiles) assert.deepEqual(extracted.get(`varin-external-access/${file}`), {
    mode: file === 'validate.sh' ? 0o755 : 0o644, data: `shipped template ${file}\n`,
  });
  assert.deepEqual(output, await buildExternalAccessDownloads(root));
  const snippet = 'downloads/varin-external-access/snippets/nginx.conf';
  assert.deepEqual(await buildExternalAccessDownloads(root, snippet), new Map([[snippet, output.get(snippet)]]));
  assert.equal((await buildExternalAccessDownloads(root, 'downloads/varin-external-access/.env')).size, 0);
  // A packaged name must be a normal file, not a symlink or operator directory.
  await rm(join(root, 'frps.toml'));
  if (process.platform === 'win32') await mkdir(join(root, 'frps.toml'));
  else await symlink('.env', join(root, 'frps.toml'));
  await assert.rejects(() => buildExternalAccessDownloads(root), /Invalid external access template/);
});
