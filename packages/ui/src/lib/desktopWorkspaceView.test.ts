import { describe, expect, test } from 'vitest';
import { desktopWorkspaceIsOperable, resolveDesktopWorkspaceView } from './desktopWorkspaceView';
describe('native desktop workspace readiness', () => {
  test('opens on an authoritative catalog and preserves it through a refresh failure', () => {
    expect(resolveDesktopWorkspaceView({ catalogError: new Error('unavailable'), catalogLoaded: true })).toBe('main');
  });
  test('distinguishes pending boot from a failed catalog without an installer fallback', () => {
    expect(resolveDesktopWorkspaceView({ catalogError: null, catalogLoaded: false })).toBe('loading');
    expect(resolveDesktopWorkspaceView({ catalogError: null, catalogLoaded: false, catalogLoading: true })).toBe('loading');
    expect(resolveDesktopWorkspaceView({ catalogError: new Error('unavailable'), catalogLoaded: false })).toBe('catalog-recovery');
    expect(resolveDesktopWorkspaceView({ catalogError: new Error('unavailable'), catalogLoaded: false, catalogLoading: true })).toBe('catalog-recovery');
  });
  test('directory transitions cannot admit an unready workspace', () => {
    expect(desktopWorkspaceIsOperable('main', false)).toBe(true);
    expect(desktopWorkspaceIsOperable('main', true)).toBe(false);
    expect(desktopWorkspaceIsOperable('loading', false)).toBe(false);
    expect(desktopWorkspaceIsOperable('catalog-recovery', false)).toBe(false);
  });
});
