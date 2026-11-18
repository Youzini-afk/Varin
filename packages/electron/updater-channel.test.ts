import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveUpdaterChannel } from './updater-channel.js';

test('uses an architecture-specific Windows ARM64 update channel', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'arm64' }), 'latest-arm64');
});

test('keeps the default channel for other desktop targets', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'x64' }), null);
  assert.equal(resolveUpdaterChannel({ platform: 'darwin', architecture: 'arm64' }), null);
  assert.equal(resolveUpdaterChannel({ platform: 'linux', architecture: 'arm64' }), null);
});

test('light uses a role channel and never falls back to the default full channel', () => {
  for (const architecture of ['x64', 'arm64'] as const) {
    assert.equal(resolveUpdaterChannel({ role: 'light', platform: 'linux', architecture }), 'light');
  }
});
