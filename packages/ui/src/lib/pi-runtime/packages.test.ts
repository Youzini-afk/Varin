import { describe, expect, test } from 'vitest';
import { findPiPackage, isPiPackageUpdatable, piPackageNameFromSource } from './packages';

describe('Pi package identity', () => {
  test('recognizes unpinned and versioned npm sources', () => {
    expect(piPackageNameFromSource('npm:pi-workspace-history')).toBe('pi-workspace-history');
    expect(piPackageNameFromSource('npm:pi-workspace-history@0.2.2')).toBe('pi-workspace-history');
    expect(piPackageNameFromSource('npm:@example/history@1.0.0')).toBe('@example/history');
  });

  test('recognizes local Windows and file URL working copies', () => {
    expect(piPackageNameFromSource('D:\\tmp\\pi-wtf')).toBe('pi-wtf');
    expect(piPackageNameFromSource('file:///D:/tmp/pi-workspace-history.git')).toBe('pi-workspace-history');
    expect(piPackageNameFromSource('https://github.com/Youzini-afk/pi-mcp-adapter.git')).toBe('pi-mcp-adapter');
  });

  test('only offers updates for package-manager-owned sources', () => {
    expect(isPiPackageUpdatable('npm:pi-wtf')).toBe(true);
    expect(isPiPackageUpdatable('https://github.com/example/pi-plugin.git')).toBe(true);
    expect(isPiPackageUpdatable('git@example.com:example/pi-plugin.git')).toBe(true);
    expect(isPiPackageUpdatable('D:\\tmp\\pi-wtf')).toBe(false);
    expect(isPiPackageUpdatable('../../extensions/pi-wtf')).toBe(false);
  });

  test('finds a configured integration without replacing its original source', () => {
    const configured = findPiPackage([
      {
        enabled: true,
        installed: true,
        name: 'pi-wtf',
        scope: 'project',
        source: 'D:\\tmp\\pi-wtf',
        structured: false,
      },
    ], 'pi-wtf');
    expect(configured?.source).toBe('D:\\tmp\\pi-wtf');
    expect(findPiPackage([configured!], 'pi-wtf', 'global')).toBeUndefined();
    expect(findPiPackage([configured!], 'pi-wtf', 'project')).toBe(configured);
  });
});
