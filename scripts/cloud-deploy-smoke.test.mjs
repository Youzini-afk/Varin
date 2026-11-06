import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInstalledServiceInvoker } from './smoke-cloud-services.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args, env = {}) => spawnSync('bash', ['scripts/smoke-cloud-deploy.sh', ...args], {
  cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
});

test('cloud smoke rejects invalid archive arguments before preparing or deploying products', { skip: process.platform !== 'linux' }, () => {
  for (const args of [['--unknown'], ['--archive'], ['--archive', 'missing.tgz', 'extra']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/u);
  }
});

test('cloud smoke consumes the supplied bytes, preserves the input, and cleans failed deployment staging', { skip: process.platform !== 'linux' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-archive-consumer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), temporary = path.join(directory, 'temporary');
  fs.mkdirSync(source); fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(source, 'fixture-marker'), 'not a deployable product\n');
  const archive = path.join(directory, 'input.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const original = fs.readFileSync(archive);
  const result = run(['--archive', archive], { TMPDIR: temporary });
  assert.notEqual(result.status, 0);
  // The real deployer inspected this archive. A hidden restage/build would
  // either validate a different product or fail at an unrelated build boundary.
  assert.match(result.stderr, /Cloud runtime archive is missing /u);
  assert.deepEqual(fs.readFileSync(archive), original);
  assert.deepEqual(fs.readdirSync(temporary), []);
});

test('installed service CLI executes through the deployment current symlink', { skip: process.platform !== 'linux' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-service-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const current = path.join(directory, 'current');
  fs.symlinkSync(path.join(root, 'scripts'), current, 'dir');
  const result = spawnSync(process.execPath, [path.join(current, 'smoke-cloud-services.mjs'),
    'http://127.0.0.1:1', path.join(directory, 'missing-runtime')], { encoding: 'utf8' });
  // A missing installed contract must fail, not silently skip the CLI body
  // because argv retains "current" while import.meta.url resolves its target.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot find module .*extension-contract/u);
});

test('installed service smoke uses the normal session and preserves service failures without logging bodies', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/session') {
      res.setHeader('Set-Cookie', 'varin_ui_session=smoke-session; HttpOnly; SameSite=Strict');
      res.end(JSON.stringify({ authenticated: true }));
    } else if (requests.length === 2) {
      res.end(JSON.stringify({ result: { status: 'ready' } }));
    } else {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: 'private failure body' } }));
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const invoke = await createInstalledServiceInvoker({ baseUrl, password: 'smoke-password' });
  const request = { serviceId: 'fixture.service', version: 1, method: 'read', args: [] };
  assert.deepEqual(await invoke(request), { status: 'ready' });
  assert.deepEqual(requests[0].body, { password: 'smoke-password' });
  assert.equal(requests[1].path, '/api/varin/extensions/v1/services/invoke');
  assert.equal(requests[1].headers.cookie, 'varin_ui_session=smoke-session');
  assert.equal(requests[1].headers.origin, baseUrl);
  assert.deepEqual(requests[1].body, request);
  await assert.rejects(invoke(request), error => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /private failure body|smoke-session|smoke-password/);
    return true;
  });
});
