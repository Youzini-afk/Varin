import { describe, expect, test } from 'vitest';

import type { RuntimeAPIs } from '@varin/application-client';
import {
  resolveDefaultDirectory,
  resolveRestoredDirectory,
  resolveRuntimeWorkspaceRoot,
  resolveWorkspaceAwareRestoredDirectory,
} from './defaultDirectory';
import { waitForRuntimeSettingsSync } from './directoryPersistence';

describe('resolveDefaultDirectory', () => {
  test('uses the runtime workspace root when the boot fallback is a filesystem root', () => {
    expect(resolveDefaultDirectory('/', '/home/varin/workspaces')).toBe('/home/varin/workspaces');
    expect(resolveDefaultDirectory('C:/', 'C:/Users/example/projects')).toBe('C:/Users/example/projects');
  });

  test('preserves an explicit project directory', () => {
    expect(resolveDefaultDirectory('/home/varin/workspaces/project', '/home/varin/workspaces')).toBe(
      '/home/varin/workspaces/project',
    );
  });

  test('does not replace one filesystem root with another', () => {
    expect(resolveDefaultDirectory('/', '/')).toBe('/');
  });

  test('ignores an automatically resolved home when no directory was persisted', () => {
    expect(resolveRestoredDirectory({
      latestPersistedDirectory: null,
      persistedDirectory: null,
      workspaceRoot: '/home/varin/workspaces',
    })).toBe('/home/varin/workspaces');
  });

  test('preserves a project selected while the workspace root was loading', () => {
    expect(resolveRestoredDirectory({
      latestPersistedDirectory: '/home/varin/workspaces/project',
      persistedDirectory: null,
      workspaceRoot: '/home/varin/workspaces',
    })).toBe('/home/varin/workspaces/project');
  });

  test('uses home for general chat instead of replaying the last workspace directory', () => {
    expect(resolveWorkspaceAwareRestoredDirectory({
      hasSelectedWorkspace: false,
      homeDirectory: 'C:/Users/example',
      latestPersistedDirectory: 'D:/projects/previous',
      persistedDirectory: 'D:/projects/previous',
      workspaceRoot: 'D:/projects',
    })).toBe('C:/Users/example');
  });

  test('does not use the server workspace root for a local desktop runtime', async () => {
    let calls = 0;
    const apis = {
      runtime: { platform: 'desktop', isDesktop: true },
      workspace: { getRoot: async () => { calls += 1; throw new Error('must not load'); } },
    } as unknown as RuntimeAPIs;
    expect(await resolveRuntimeWorkspaceRoot(apis, { desktopLocal: true })).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('waitForRuntimeSettingsSync', () => {
  test('releases immediately on the authoritative settings event and clears its timeout', async () => {
    let listener: EventListener | null = null;
    let cleared: number | undefined;
    const fakeWindow = {
      addEventListener: (_type: string, next: EventListenerOrEventListenerObject) => {
        listener = next as EventListener;
      },
      removeEventListener: () => {},
      setTimeout: () => 17,
      clearTimeout: (id: number | undefined) => { cleared = id; },
    } as unknown as Pick<Window, 'addEventListener' | 'clearTimeout' | 'removeEventListener' | 'setTimeout'>;

    const waiting = waitForRuntimeSettingsSync(fakeWindow);
    const registeredListener = listener as EventListener | null;
    registeredListener?.(new Event('varin:settings-synced'));
    expect(await waiting).toBe(true);
    expect(cleared).toBe(17);
  });

  test('reports timeout without treating missing settings as an empty snapshot', async () => {
    let timeoutHandler: (() => void) | null = null;
    const fakeWindow = {
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: (handler: TimerHandler) => {
        timeoutHandler = handler as () => void;
        return 23;
      },
      clearTimeout: () => {},
    } as unknown as Pick<Window, 'addEventListener' | 'clearTimeout' | 'removeEventListener' | 'setTimeout'>;

    const waiting = waitForRuntimeSettingsSync(fakeWindow);
    const registeredTimeout = timeoutHandler as (() => void) | null;
    registeredTimeout?.();
    expect(await waiting).toBe(false);
  });
});
