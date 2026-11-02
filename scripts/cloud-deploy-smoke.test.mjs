import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
