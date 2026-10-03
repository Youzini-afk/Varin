import { beforeEach, describe, expect, test, vi } from 'vitest';

let restartCalls = 0;
let restartImpl: () => Promise<boolean> = async () => true;

vi.doMock('@/lib/desktop', () => ({
  checkForDesktopUpdates: async () => null,
  downloadDesktopUpdate: async () => false,
  isDesktopShell: () => true,
  isElectronShell: () => true,
  isWebRuntime: () => false,
  restartToApplyUpdate: () => {
    restartCalls += 1;
    return restartImpl();
  },
}));

vi.doMock('@varin/application-client', async () => ({
  ...await vi.importActual<typeof import('@varin/application-client')>('@varin/application-client'),
  runtimeFetch: async () => new Response(null, { status: 204 }),
}));

vi.doMock('@/lib/platform', () => ({
  getClientPlatform: () => 'web',
  isCapacitorApp: () => false,
}));

vi.doMock('./usePreferencesStore', () => ({
  usePreferencesStore: {
    getState: () => ({ settingsAutoUpdateChecksEnabled: true }),
  },
}));

const { useUpdateStore } = await import('./useUpdateStore');

beforeEach(() => {
  restartCalls = 0;
  restartImpl = async () => true;
  useUpdateStore.getState().reset();
  useUpdateStore.setState({
    downloaded: true,
    error: null,
    restarting: false,
    runtimeType: 'desktop',
  });
});

describe('desktop update restart transition', () => {
  test('enters restarting immediately and suppresses duplicate restart requests', async () => {
    let resolveRestart!: (value: boolean) => void;
    restartImpl = () => new Promise((resolve) => {
      resolveRestart = resolve;
    });

    const restart = useUpdateStore.getState().restartToUpdate();

    expect(useUpdateStore.getState().restarting).toBe(true);
    expect(restartCalls).toBe(1);

    await useUpdateStore.getState().restartToUpdate();
    expect(restartCalls).toBe(1);

    resolveRestart(true);
    await restart;

    // A successful handoff keeps the transition locked until Electron exits.
    expect(useUpdateStore.getState().restarting).toBe(true);
  });

  test('restores interaction when the restart handoff fails', async () => {
    restartImpl = async () => false;

    await useUpdateStore.getState().restartToUpdate();

    expect(useUpdateStore.getState().restarting).toBe(false);
    expect(useUpdateStore.getState().error).toBe('Desktop restart only works on Local instance');
  });
});
