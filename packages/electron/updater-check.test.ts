import assert from 'node:assert/strict';
import { test } from 'vitest';

import { checkForDesktopUpdate } from './updater-check.js';

const compareVersions = (left: string, right: string): number => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { updateInfo: { version: '2.0.0' } } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { updateInfo: { version: '2.0.0' } } });
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

test('retains the downloaded installer on a same-payload check even when release notes change', async () => {
  const pendingUpdate = { version: '2.0.0', downloaded: true, electronUpdate: {
    updateInfo: { version: '2.0.0', files: [{ url: 'Varin.exe', sha512: 'original' }], releaseNotes: 'Old notes' },
  } };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: {
      version: '2.0.0', files: [{ sha512: 'original', url: 'Varin.exe' }], releaseNotes: 'Updated notes',
    } }) },
    currentVersion: '1.0.0', pendingUpdate, compareVersions,
  });
  assert.equal(result.available, true);
  assert.equal(result.pendingUpdate, pendingUpdate);
  assert.equal(result.pendingUpdate?.downloaded, true);
  assert.equal(result.updateInfo?.releaseNotes, 'Updated notes');
});

test('a completing download keeps its record across an overlapping same-payload check', async () => {
  const updateInfo = { version: '2.0.0', files: [{ url: 'Varin.exe', sha512: 'original' }] };
  const pendingUpdate = { version: '2.0.0', downloaded: false, electronUpdate: { updateInfo } };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: structuredClone(updateInfo) }) },
    currentVersion: '1.0.0', pendingUpdate, compareVersions,
  });
  // The native download event can arrive before the check handler publishes its result.
  pendingUpdate.downloaded = true;
  assert.equal(result.pendingUpdate?.downloaded, true);
});

test('a new version or replaced same-version payload requires its own download', async () => {
  const updateInfo = { version: '2.0.0', files: [{ url: 'Varin.exe', sha512: 'original' }],
    path: 'Varin.exe', sha512: 'original', packages: { x64: { path: 'payload.7z', sha512: 'package' } } };
  for (const replacement of [
    { ...updateInfo, version: '3.0.0' },
    { ...updateInfo, files: [{ url: 'Varin.exe', sha512: 'replacement' }] },
    { ...updateInfo, sha512: 'replacement' },
    { ...updateInfo, packages: { x64: { path: 'payload.7z', sha512: 'replacement' } } },
  ]) {
    const result = await checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => ({ updateInfo: replacement }) },
      currentVersion: '1.0.0',
      pendingUpdate: { version: '2.0.0', downloaded: true, electronUpdate: { updateInfo } }, compareVersions,
    });
    assert.equal(result.available, true);
    assert.equal(result.pendingUpdate?.version, replacement.version);
    assert.notEqual(result.pendingUpdate?.downloaded, true);
    assert.deepEqual(result.pendingUpdate?.electronUpdate?.updateInfo, replacement);
  }
});

test('an empty successful check clears even a downloaded pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => null }, currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0', downloaded: true }, compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});
