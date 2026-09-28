import { describe, expect, it } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import type { VarinSettingsDocument } from '@varin/settings-store';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async (
  syncPresets: (presets: unknown) => Promise<void> = async () => {},
  mergePersistedSettings: (current: VarinSettingsDocument, changes: VarinSettingsDocument) => VarinSettingsDocument = (_current, changes) => changes,
) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'varin-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings as VarinSettingsDocument,
    mergePersistedSettings,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    formatSettingsResponse: (settings) => settings,
    syncManagedRemoteTunnelConfigWithPresets: syncPresets,
    upsertManagedRemoteTunnelToken: async () => {},
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('reads the current settings document without rewriting it', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      const source = '{"themeId":"varin-dark"}\n';
      await fsPromises.writeFile(settingsFilePath, source, 'utf8');

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ themeId: 'varin-dark' });
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(source);
    } finally {
      await cleanup();
    }
  });

  it('surfaces malformed settings instead of treating them as an empty first run', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      const source = '{"themeId":';
      await fsPromises.writeFile(settingsFilePath, source, 'utf8');

      await expect(runtime.readSettingsFromDisk()).rejects.toBeInstanceOf(SyntaxError);
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(source);
    } finally {
      await cleanup();
    }
  });

  it('keeps projects available while the workspace selection is explicitly empty', async () => {
    const { runtime, cleanup, tempRoot } = await createRuntime();
    try {
      const project = { id: 'workspace-a', path: tempRoot };
      await expect(runtime.persistSettings({
        activeProjectId: null,
        projects: [project],
      })).resolves.toEqual({
        activeProjectId: null,
        projects: [project],
      });

      await expect(runtime.persistSettings({
        activeProjectId: 'missing',
        projects: [project],
      })).resolves.toEqual({
        activeProjectId: null,
        projects: [project],
      });
    } finally {
      await cleanup();
    }
  });

  it('synchronizes the managed tunnel owner when presets are removed', async () => {
    const synchronized: unknown[] = [];
    const { runtime, cleanup } = await createRuntime(async (presets) => { synchronized.push(presets); });
    try {
      await runtime.persistSettings({ managedRemoteTunnelPresets: [{ id: 'one', name: 'One', hostname: 'one.test' }] });
      const current = await runtime.readSettingsFromDisk();
      const revision = (document: VarinSettingsDocument) => JSON.stringify(document);
      await runtime.persistSettingsCas({}, ['managedRemoteTunnelPresets'], revision(current), revision);
      expect(synchronized).toEqual([[{ id: 'one', name: 'One', hostname: 'one.test' }], undefined]);
    } finally {
      await cleanup();
    }
  });

  it('rotates a proxy credential binding whenever the endpoint changes', async () => {
    const { runtime, cleanup } = await createRuntime(async () => {}, (current, changes) => ({ ...current, ...changes }));
    const network = (proxyUrl: string) => ({ mode: 'proxy', proxyUrl, noProxy: '' });
    try {
      const a = await runtime.persistSettings({ outboundNetwork: network('http://proxy-a.test:8080') });
      const refA = (a.outboundNetwork as { credentialRef: string }).credentialRef;
      const same = await runtime.persistSettings({ outboundNetwork: network('http://proxy-a.test:8080') });
      expect((same.outboundNetwork as { credentialRef: string }).credentialRef).toBe(refA);
      const b = await runtime.persistSettings({ outboundNetwork: network('http://proxy-b.test:8080') });
      const refB = (b.outboundNetwork as { credentialRef: string }).credentialRef;
      expect(refB).not.toBe(refA);
      const back = await runtime.persistSettings({ outboundNetwork: network('http://proxy-a.test:8080') });
      expect((back.outboundNetwork as { credentialRef: string }).credentialRef).not.toBe(refA);
    } finally { await cleanup(); }
  });

});
