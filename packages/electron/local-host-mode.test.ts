import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { createSettingsFileStore } from '@varin/settings-store';
import { readLocalHostMode, writeLocalHostMode, restartDesktopNormally, type LocalHostModeContext } from './local-host-mode.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const setup = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-local-mode-')); directories.push(directory);
  return createSettingsFileStore({ filePath: path.join(directory, 'settings.json') });
};
const context = (overrides: Partial<LocalHostModeContext> = {}): LocalHostModeContext => ({
  environment: {}, recoveryUiAvailable: true, startedEnabled: true, runtime: 'embedded', ...overrides,
});

test('saves only next-launch mode in the existing store, preserves connections, and reports current runtime separately', async () => {
  const store = await setup();
  await store.update(root => { root.desktopHosts = [{ id: 'peer', url: 'https://peer.example' }]; root.desktopDefaultHostId = 'peer'; });
  assert.equal(readLocalHostMode(store, context()).enabled, true);
  const saved = await writeLocalHostMode(store, { enabled: false }, context());
  assert.equal(saved.enabled, false); assert.equal(saved.effectiveEnabled, false);
  assert.equal(saved.runtime, 'embedded'); assert.equal(saved.requiresRestart, true);
  const reopened = createSettingsFileStore({ filePath: store.filePath });
  assert.equal(readLocalHostMode(reopened, context({ startedEnabled: false, runtime: 'stopped' })).requiresRestart, false);
  assert.equal(reopened.readSync().desktopDefaultHostId, 'peer');
  assert.deepEqual(reopened.readSync().desktopHosts, [{ id: 'peer', url: 'https://peer.example' }]);
});

test('environment override is authoritative and never silently rewritten', async () => {
  const store = await setup();
  const forced = context({ environment: { VARIN_SKIP_LOCAL_SERVER: '1' }, startedEnabled: false, runtime: 'stopped' });
  const mode = readLocalHostMode(store, forced);
  assert.equal(mode.enabled, true); assert.equal(mode.effectiveEnabled, false); assert.equal(mode.environmentDisabled, true);
  await assert.rejects(writeLocalHostMode(store, { enabled: true }, forced), /VARIN_SKIP_LOCAL_SERVER/);
  assert.deepEqual(store.readSync(), {});
});

test('development without an independent recovery shell cannot save frontend-only mode or become stranded by a saved preference', async () => {
  const store = await setup();
  await assert.rejects(writeLocalHostMode(store, { enabled: false }, context({ recoveryUiAvailable: false })), /bundled recovery UI/);
  await writeLocalHostMode(store, { enabled: false }, context());
  const mode = readLocalHostMode(store, context({ recoveryUiAvailable: false }));
  assert.equal(mode.enabled, false); assert.equal(mode.effectiveEnabled, true); assert.equal(mode.canDisable, false);
  assert.equal(readLocalHostMode(store, context({ recoveryUiAvailable: false, environment: { VARIN_SKIP_LOCAL_SERVER: '1' } })).effectiveEnabled, false);
});

test('offline recovery atomically selects local startup while preserving peers; explicit remote env cannot be overridden', async () => {
  const store = await setup();
  await store.update(root => { root.desktopLocalHostEnabled = false; root.desktopDefaultHostId = 'peer'; root.desktopHosts = [{ id: 'peer' }]; });
  await assert.rejects(writeLocalHostMode(store, { enabled: true, selectLocalOnRestart: true }, context({ environment: { VARIN_SERVER_URL: 'https://remote.example' } })), /VARIN_SERVER_URL/);
  assert.equal(store.readSync().desktopDefaultHostId, 'peer');
  await writeLocalHostMode(store, { enabled: true, selectLocalOnRestart: true }, context({ startedEnabled: false, runtime: 'stopped' }));
  assert.deepEqual(store.readSync(), { desktopLocalHostEnabled: true, desktopDefaultHostId: 'local', desktopHosts: [{ id: 'peer' }], desktopInitialHostChoiceCompleted: true });
  await assert.rejects(writeLocalHostMode(store, { enabled: 'false' as unknown as boolean }, context()), /boolean/);
});

test('ordinary restart waits for native shutdown and cannot reach updater or relaunch after a failed cleanup', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const restarting = restartDesktopNormally({ prepare: () => new Promise<void>(resolve => { calls.push('prepare'); release = resolve; }),
    relaunch: () => { calls.push('relaunch'); }, exit: () => { calls.push('exit'); } });
  assert.deepEqual(calls, ['prepare']); release(); await restarting;
  assert.deepEqual(calls, ['prepare', 'relaunch', 'exit']);
  await assert.rejects(restartDesktopNormally({ prepare: async () => { throw new Error('cleanup failed'); },
    relaunch: () => assert.fail('must not relaunch'), exit: () => assert.fail('must not exit') }), /cleanup failed/);
});

test('invalid saved mode is rejected without rewriting the settings document', async () => {
  const store = await setup();
  await store.update(root => { root.desktopLocalHostEnabled = 'disabled'; root.custom = { keep: true }; });
  assert.throws(() => readLocalHostMode(store, context()), /Invalid desktop/);
  await assert.rejects(writeLocalHostMode(store, { enabled: true }, context()), /Invalid desktop/);
  assert.deepEqual(store.readSync(), { desktopLocalHostEnabled: 'disabled', custom: { keep: true } });
});
