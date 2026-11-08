import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DesktopUpdateCheckResult } from '@varin/application-client';
import { checkForDesktopUpdate, type DesktopPendingUpdate, type DesktopUpdateInfo } from '../../../electron/updater-check';

vi.doMock('@varin/application-client', async () => ({
  ...await vi.importActual<typeof import('@varin/application-client')>('@varin/application-client'),
  runtimeFetch: async () => Response.json({ available: true, currentVersion: '1.0.0', nextSuggestedCheckInSec: 60 }),
}));
vi.doMock('@/lib/platform', () => ({ getClientPlatform: () => 'web', isCapacitorApp: () => false }));
vi.doMock('./usePreferencesStore', () => ({
  usePreferencesStore: { getState: () => ({ settingsAutoUpdateChecksEnabled: true }) },
}));

const { useUpdateStore } = await import('./useUpdateStore');
let pending: DesktopPendingUpdate | null;
let feed: DesktopUpdateInfo | null;
let failure: Error | undefined;
let installed: boolean[];
const check = async (): Promise<DesktopUpdateCheckResult> => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => {
      if (failure) throw failure;
      return feed ? { updateInfo: structuredClone(feed) } : null;
    } },
    currentVersion: '1.0.0', pendingUpdate: pending,
    compareVersions: (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  });
  pending = result.pendingUpdate;
  return { available: result.available, downloaded: pending?.downloaded === true,
    currentVersion: '1.0.0', version: result.available ? result.nextVersion : null, body: null, date: null };
};

beforeEach(() => {
  pending = null;
  feed = { version: '2.0.0', files: [{ url: 'Varin.exe', sha512: 'original' }] };
  failure = undefined;
  installed = [];
  vi.stubGlobal('window', {
    __VARIN_ELECTRON__: { runtime: 'electron', arch: 'x64' },
    __VARIN_DESKTOP__: { invoke: async (command: string) => {
      if (command === 'desktop_check_for_updates') return check();
      if (command === 'desktop_download_and_install_update') {
        if (!pending) throw new Error('No pending update');
        pending.downloaded = true; return null;
      }
      if (command === 'desktop_restart') { installed.push(pending?.downloaded === true); return null; }
      throw new Error(`Unexpected desktop command: ${command}`);
    } },
  });
  useUpdateStore.getState().reset();
});
afterEach(() => vi.unstubAllGlobals());

const download = async () => {
  await useUpdateStore.getState().checkForUpdates();
  await useUpdateStore.getState().downloadUpdate();
  expect(pending?.downloaded).toBe(true);
  expect(useUpdateStore.getState().downloaded).toBe(true);
};

test('native check, desktop bridge and store retain a same-payload download through restart', async () => {
  await download();
  feed = { ...feed!, releaseNotes: 'Revised release notes' };
  await useUpdateStore.getState().checkForUpdates();
  expect(useUpdateStore.getState().downloaded).toBe(true);
  await useUpdateStore.getState().restartToUpdate();
  expect(installed).toEqual([true]);
});

for (const replacement of [
  { name: 'new version', version: '3.0.0', hash: 'original' },
  { name: 'same-version replacement', version: '2.0.0', hash: 'replacement' },
]) test(`a ${replacement.name} clears the stale downloaded UI and downloads the selected installer`, async () => {
  await download();
  feed = { version: replacement.version, files: [{ url: 'Varin.exe', sha512: replacement.hash }] };
  await useUpdateStore.getState().checkForUpdates();
  expect(useUpdateStore.getState().available).toBe(true);
  expect(useUpdateStore.getState().downloaded).toBe(false);
  expect(pending?.downloaded).not.toBe(true);
  await useUpdateStore.getState().restartToUpdate();
  expect(installed).toEqual([]);
  await useUpdateStore.getState().downloadUpdate();
  await useUpdateStore.getState().restartToUpdate();
  expect(installed).toEqual([true]);
});

for (const missingFeed of [false, true]) test(`authoritative no update clears the downloaded UI (${missingFeed ? 'missing feed' : 'no release'})`, async () => {
  await download();
  feed = null;
  if (missingFeed) failure = new Error('HttpError: 404 Not Found');
  await useUpdateStore.getState().checkForUpdates();
  expect(useUpdateStore.getState().available).toBe(false);
  expect(useUpdateStore.getState().downloaded).toBe(false);
  expect(useUpdateStore.getState().error).toBeNull();
  expect(pending).toBeNull();
});

test('a failed check preserves the existing download and still reports a manual-check error', async () => {
  await download();
  failure = new Error('connection reset');
  await useUpdateStore.getState().checkForUpdates();
  expect(useUpdateStore.getState().downloaded).toBe(true);
  expect(pending?.downloaded).toBe(true);
  expect(useUpdateStore.getState().error).toMatch(/connection reset/);
  await useUpdateStore.getState().restartToUpdate();
  expect(installed).toEqual([true]);
});
