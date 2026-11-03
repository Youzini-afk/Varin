import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSettingsFileStore } from '@varin/settings-store';
import { createDesktopFrontendMigrationOwner } from './frontend-migration.js';
it('uses the real settings transaction, keeps staging through failure, and removes only the acknowledged temporary copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-migration-')); try {
    const file = path.join(root, 'settings.json'), store = createSettingsFileStore({ filePath: file });
    await store.update(root => { root.desktopLocalClientToken = 'existing-native-secret'; });
    const owner = createDesktopFrontendMigrationOwner(store);
    await owner.stage([['lastDirectory', '/work'], ['openaiApiKey', 'not-in-export']], '0.9.37');
    const stage = owner.read()!;
    expect(await readFile(file, 'utf8')).not.toContain('not-in-export');
    expect(store.readSync().desktopLocalClientToken).toBe('existing-native-secret');
    await expect(owner.complete({ id: stage.id, digest: stage.digest, importedKeys: [], retainedKeys: [] })).rejects.toThrow('every exported entry');
    expect(owner.read()?.id).toBe(stage.id);
    const again = await owner.stage([['lastDirectory', '/later']], '0.9.38');
    expect(again.id).toBe(stage.id);
    const receipt = { id: stage.id, digest: stage.digest, importedKeys: ['lastDirectory'], retainedKeys: [] };
    await owner.complete(receipt);
    await owner.complete(receipt);
    expect(owner.read()).toBeNull();
    const saved = store.readSync().desktopFrontendMigration as Record<string, unknown>;
    expect(saved.payload).toBeUndefined();
    expect(saved.credentialsComplete).toBe(false);
    expect(saved.credentialSlots).toEqual(['openaiApiKey']);
    expect(store.readSync().desktopLocalClientToken).toBe('existing-native-secret');
  }
    finally {
    await rm(root, { recursive: true, force: true });
  }
});
