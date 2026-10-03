import { describe, expect, test } from 'vitest';
import { desktopWorkspaceIsOperable, resolveDesktopWorkspaceView } from './desktopWorkspaceView';

describe('resolveDesktopWorkspaceView', () => {
  test('keeps the main workspace after the Pi catalog loads', () => {
    expect(resolveDesktopWorkspaceView({
      catalogError: new Error('stale'),
      catalogLoaded: true,
      runtimeStatus: 'missing',
    })).toBe('main');
  });

  test('waits while discovery is in progress', () => {
    expect(resolveDesktopWorkspaceView({
      catalogError: null,
      catalogLoaded: false,
      runtimeStatus: null,
    })).toBe('loading');
    expect(resolveDesktopWorkspaceView({
      catalogError: new Error('catalog'),
      catalogLoaded: false,
      runtimeStatus: 'discovering',
    })).toBe('loading');
    expect(resolveDesktopWorkspaceView({
      catalogError: null,
      catalogLoaded: false,
      runtimeStatus: 'probing',
    })).toBe('loading');
  });

  test('treats a missing or unusable Pi as runtime setup, not app failure', () => {
    for (const runtimeStatus of ['missing', 'upgrade-required', 'failed', 'installing', 'upgrading'] as const) {
      expect(resolveDesktopWorkspaceView({
        catalogError: new Error('session.list failed'),
        catalogLoaded: false,
        runtimeStatus,
      })).toBe('runtime-setup');
    }
  });

  test('keeps a ready Pi on the loading path until catalog success or a true catalog failure', () => {
    expect(resolveDesktopWorkspaceView({
      catalogError: null,
      catalogLoaded: false,
      runtimeStatus: 'ready',
    })).toBe('loading');
    expect(resolveDesktopWorkspaceView({
      catalogError: new Error('session.list failed'),
      catalogLoaded: false,
      catalogLoading: true,
      runtimeStatus: 'ready',
    })).toBe('loading');
    expect(resolveDesktopWorkspaceView({
      catalogError: new Error('session.list failed'),
      catalogLoaded: false,
      runtimeStatus: 'ready',
    })).toBe('catalog-recovery');
  });
});

describe('desktopWorkspaceIsOperable', () => {
  test('marks runtime setup as operable and ignores a directory switch there', () => {
    expect(desktopWorkspaceIsOperable('runtime-setup', true)).toBe(true);
    expect(desktopWorkspaceIsOperable('main', false)).toBe(true);
    expect(desktopWorkspaceIsOperable('main', true)).toBe(false);
    expect(desktopWorkspaceIsOperable('loading', false)).toBe(false);
    expect(desktopWorkspaceIsOperable('catalog-recovery', false)).toBe(false);
  });
});
