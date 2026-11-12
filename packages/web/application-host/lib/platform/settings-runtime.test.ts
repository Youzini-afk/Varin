import { describe, expect, it } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import type { VarinSettingsDocument } from '@varin/settings-store';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async (
  syncPresets: (presets: unknown) => Promise<void> = async () => {},
  mergePersistedSettings: (current: VarinSettingsDocument, changes: VarinSettingsDocument) => VarinSettingsDocument = (_current, changes) => changes,
  resolveProjectSource?: import('./settings-runtime.js').SettingsRuntimeDependencies['resolveProjectSource'],
) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'varin-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    ...(resolveProjectSource ? { resolveProjectSource } : {}),
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

it('registers remote folders through their owner and retains saved offline projects on metadata edits', async () => {
  const source = { resourceOwner: { kind: 'managed_host', hostId: 'remote', connectionId: 'connection', endpointIdentity: 'endpoint' }, workspaceId: 'remote-root' };
  let online = true;
  const resolutions: string[] = [];
  const { runtime, cleanup } = await createRuntime(undefined, (current, changes) => ({ ...current, ...changes }), async request => {
    resolutions.push(request.path);
    if (!online) throw new Error('Remote Host is offline');
    return { workspaceId: 'remote-root', path: request.path };
  });
  const project = { id: 'remote', path: 'Z:\\not-on-coordinator', source };
  try {
    await runtime.persistSettings({ projects: [project] });
    expect(resolutions).toEqual([project.path]);
    online = false;
    await runtime.persistSettings({ projects: [{ ...project, label: 'Still visible offline' }] });
    expect(resolutions).toHaveLength(1);
    expect((await runtime.readSettingsFromDisk()).projects).toEqual([{ ...project, label: 'Still visible offline' }]);
    await expect(runtime.persistSettings({ projects: [{ ...project, path: 'Z:\\another' }] })).rejects.toThrow('offline');
    await expect(runtime.persistSettings({ projects: [{ id: 'remote', path: project.path }] })).rejects.toThrow('explicit source binding');
    expect((await runtime.readSettingsFromDisk()).projects).toEqual([{ ...project, label: 'Still visible offline' }]);
  } finally { await cleanup(); }
});
