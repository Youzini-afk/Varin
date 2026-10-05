import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  getCurrentVersion,
  setPackageManagerSpawnSyncForTest,
} = await import('./package-manager.js');

/** Helper: create a fetch mock that routes by URL pattern */
type FetchMock = ReturnType<typeof vi.fn> & {
  when(pattern: string, response: unknown): FetchMock;
};

function createFetchMock(): FetchMock {
  const handlers = new Map<string, unknown>();

  const mock = vi.fn((url: unknown) => {
    const urlStr = typeof url === 'string' ? url : String(url);

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  const typedMock = mock as FetchMock;
  typedMock.when = (pattern: string, response: unknown) => {
    handlers.set(pattern, response);
    return typedMock;
  };

  return typedMock;
}

const fetchCall = (mock: FetchMock, index: number): [unknown, { body: string }] => {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Expected fetch call ${index}`);
  return [call[0], call[1] as { body: string }];
};

describe('checkForUpdates', () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;
  let originalUpdateApiUrl: string | undefined;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    originalUpdateApiUrl = process.env.VARIN_UPDATE_API_URL;
    process.env.VARIN_UPDATE_API_URL = 'https://updates.varin.test/v1/update/check';
    setPackageManagerSpawnSyncForTest(vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUpdateApiUrl === undefined) delete process.env.VARIN_UPDATE_API_URL;
    else process.env.VARIN_UPDATE_API_URL = originalUpdateApiUrl;
    setPackageManagerSpawnSyncForTest(null);
  });

  // --- Scenario: API says update available, npm confirms ---

  it('returns available=true when both API and npm confirm a newer version', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0' },
        }),
      })
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0] - 2026-05-01\n\n- Great new feature',
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(result.currentVersion).toBe('1.9.10');
    expect(result.updateCommand).toBe('varin update');
  });

  it('uses no legacy hosted update service when a Varin API is not configured', async () => {
    delete process.env.VARIN_UPDATE_API_URL;
    fetchMock.when('registry.npmjs.org', {
      ok: true,
      json: async () => ({ 'dist-tags': { latest: '1.9.10' } }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('registry.npmjs.org'),
    ]);
  });

  // --- Scenario (THE FIX): API says update available, npm does NOT have it ---

  it('returns available=false when API claims update but npm has same version', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  it('returns available=false when npm only has a prerelease of the current version', async () => {
    fetchMock
      .when('updates.varin.test', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0-beta.1' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.10.0' });

    expect(result.available).toBe(false);
  });

  it('accepts electron desktop update claims without npm cross-checking', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      });

    const result = await checkForUpdates({
      appType: 'desktop-electron',
      currentVersion: '1.9.10',
      platform: 'windows',
      arch: 'arm64',
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchCall(fetchMock, 0)[1].body);
    expect(payload).toMatchObject({
      platform: 'windows',
      arch: 'arm64',
    });
    expect(payload).not.toHaveProperty('installId');
    expect(payload).not.toHaveProperty('reportUsage');
    expect(payload).not.toHaveProperty('deviceClass');
    expect(payload).not.toHaveProperty('instanceMode');
  });

  it('resolves an Android APK asset when the update API returns an AAB', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          downloadUrl: 'https://github.com/Youzini-afk/Varin/releases/download/v1.10.0/Varin-1.10.0-42-android.aab',
        }),
      })
      .when('api.github.com/repos/Youzini-afk/Varin/releases/tags/v1.10.0', {
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'Varin-1.10.0-42-android.aab',
              browser_download_url: 'https://downloads.example/Varin-1.10.0-42-android.aab',
            },
            {
              name: 'app-release.apk',
              browser_download_url: 'https://downloads.example/app-release.apk',
            },
            {
              name: 'Varin-1.10.0-42-android.apk',
              browser_download_url: 'https://downloads.example/Varin-1.10.0-42-android.apk',
            },
          ],
        }),
      });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe('https://downloads.example/Varin-1.10.0-42-android.apk');
  });

  it('keeps a direct Android APK URL from the update API', async () => {
    const apkUrl = 'https://github.com/Youzini-afk/Varin/releases/download/v1.10.0/Varin-1.10.0-42-android.apk';
    fetchMock.when('updates.varin.test', {
      ok: true,
      json: async () => ({
        latestVersion: '1.10.0',
        updateAvailable: true,
        downloadUrl: apkUrl,
      }),
    });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe(apkUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns available=false when API claims update but npm is behind', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.9' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API says no update, npm agrees ---

  it('returns available=false when API says no update and versions match', async () => {
    fetchMock.when('updates.varin.test', {
      ok: true,
      json: async () => ({
        latestVersion: '1.9.10',
        updateAvailable: false,
      }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API unreachable, npm fallback ---

  it('returns available=true from npm fallback when API is unreachable and npm has newer version', async () => {
    fetchMock
      .when('updates.varin.test', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0' },
        }),
      })
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0] - 2026-05-01\n\n- Great new feature',
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
  });

  it('returns available=false from npm fallback when API is unreachable and versions match', async () => {
    fetchMock
      .when('updates.varin.test', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API returns null (bad response), npm fallback ---

  it('returns available=false when API returns non-ok status and versions match on npm', async () => {
    fetchMock
      .when('updates.varin.test', {
        ok: false,
        status: 500,
        json: async () => ({}),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: Both API and npm are unreachable ---

  it('returns available=false when both sources are unreachable', async () => {
    fetchMock
      .when('updates.varin.test', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', Promise.reject(new Error('Registry unreachable')));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});
