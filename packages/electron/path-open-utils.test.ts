import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { validateLocalPath, unsupportedAppSpecificOpenError } from './path-open-utils.js';

test('opening a path preserves file/directory identity and rejects unavailable input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-path-open-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'existing.txt');
  await fs.writeFile(file, 'retained');
  assert.equal((await validateLocalPath(file)).path, file);
  assert.equal((await validateLocalPath(file)).stats.isFile(), true);
  assert.equal((await validateLocalPath(root, 'Directory')).stats.isDirectory(), true);
  await assert.rejects(validateLocalPath(path.join(root, 'missing')), /does not exist/);
  await assert.rejects(validateLocalPath('   '), /Path is required/);
  assert.match(unsupportedAppSpecificOpenError('projects', 'linux'), /not supported on Linux.*default open action/);
});

test('an inaccessible directory is not reported as missing', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-path-denied-'));
  t.onTestFinished(async () => {
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.chmod(root, 0o000);
  await assert.rejects(validateLocalPath(root), /is not accessible/);
});
