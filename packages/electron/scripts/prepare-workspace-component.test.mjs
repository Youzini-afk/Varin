import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { downloadWorkspaceAsset } from './prepare-workspace-component.mjs';

test('WinFsp retries a temporary download failure and returns the original asset bytes', async () => {
  const bytes = Buffer.from([0, 17, 255, 4]);
  const waits = [];
  let requests = 0;
  const result = await downloadWorkspaceAsset('https://example.test/component.msi', {
    request: async () => ++requests === 1 ? new Response(null, { status: 504 }) : new Response(bytes),
    wait: async ms => waits.push(ms),
  });
  assert.deepEqual(result, bytes);
  assert.deepEqual(waits, [1000]);
  requests = 0;
  await assert.rejects(downloadWorkspaceAsset('https://example.test/missing', {
    request: async () => { requests++; return new Response(null, { status: 404 }); },
    wait: async () => assert.fail('Permanent errors must not be retried'),
  }), /404/);
  assert.equal(requests, 1);
});

test('native workspace CI prepares verified assets without installed npm dependencies', async t => {
  const checkout = await mkdtemp(path.join(tmpdir(), 'varin-workspace-assets-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const assets = new Map([
    ['/component.msi', Buffer.from([0, 17, 255, 4])],
    ['/license.txt', Buffer.from('Official component license fixture')],
  ]);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const bytes = assets.get(request.url);
    response.writeHead(bytes ? 200 : 404);
    response.end(bytes);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const resources = path.join(checkout, 'packages/electron/resources');
  const scripts = path.join(checkout, 'packages/electron/scripts');
  await mkdir(resources, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(checkout, 'scripts'));
  const script = path.join(scripts, 'prepare-workspace-component.mjs');
  await cp(new URL('./prepare-workspace-component.mjs', import.meta.url), script);
  await cp(new URL('../../../scripts/download-build-asset.mjs', import.meta.url), path.join(checkout, 'scripts/download-build-asset.mjs'));
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(resources, 'workspace-component.json'), JSON.stringify({
    file: 'component.msi', version: '2.2.26286', release: 'fixture',
    url: `${endpoint}/component.msi`, sha256: sha256(assets.get('/component.msi')),
    licenseUrl: `${endpoint}/license.txt`, licenseSha256: sha256(assets.get('/license.txt')),
  }));
  const run = () => promisify(execFile)(process.execPath, [script, '--assets-only'], {
    cwd: checkout, env: { ...process.env, NODE_PATH: '' },
  });
  await run();
  const directory = path.join(resources, 'workspace-component');
  assert.deepEqual(await readFile(path.join(directory, 'component.msi')), assets.get('/component.msi'));
  assert.deepEqual(await readFile(path.join(directory, 'License.txt')), assets.get('/license.txt'));
  assert.deepEqual((await readdir(directory)).sort(), ['License.txt', 'component.msi']);
  await run();
  assert.equal(requests, 2, 'Verified cached assets must be reused');
});
