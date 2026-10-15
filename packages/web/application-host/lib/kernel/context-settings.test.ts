import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readContextPolicy } from './context-settings.js';
import { AgentSettingsService } from '../models/settings.js';

it('native settings preserve explicit zero, trusted overrides and immutable policy identity, without reading Pi assets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'context-settings-'));
  const projectRoot = path.join(root, 'project');
  let trusted = false;
  const settings = new AgentSettingsService(root, () => trusted);
  const read = async () => readContextPolicy({ settings: await settings.snapshot(projectRoot), projectRoot, providerId: 'p', modelId: 'm' });
  try {
    await writeFile(path.join(root, 'settings.json'), '{legacy broken');
    await mkdir(path.join(projectRoot, '.pi'), { recursive: true });
    await writeFile(path.join(projectRoot, '.pi', 'settings.json'), '{legacy broken');
    expect(await read()).toMatchObject({ keepRecentTokens: 20000, explicitKeepRecentTokens: null });
    let snapshot = await settings.snapshot();
    snapshot = await settings.update({ scope: 'global', expectedRevision: snapshot.globalRevision,
      set: { compaction: { keepRecentTokens: 123, modelOverrides: { 'p/m': { keepRecentTokens: 0 } } } }, remove: [] });
    const frozen = readContextPolicy({ settings: snapshot, providerId: 'p', modelId: 'm' });
    expect(frozen).toMatchObject({ keepRecentTokens: 0, explicitKeepRecentTokens: 0 });
    await mkdir(path.join(projectRoot, '.varin'), { recursive: true });
    await writeFile(path.join(projectRoot, '.varin/settings.json'), JSON.stringify({ compaction: { modelOverrides: { 'p/m': { keepRecentTokens: 456 } } } }));
    expect((await read()).explicitKeepRecentTokens).toBe(0);
    trusted = true;
    expect((await read()).explicitKeepRecentTokens).toBe(456);
    expect(readContextPolicy({ settings: snapshot, providerId: 'p', modelId: 'm' })).toEqual(frozen);
    expect(await readFile(path.join(projectRoot, '.pi', 'settings.json'), 'utf8')).toBe('{legacy broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects invalid native compaction writes atomically, including unselected model overrides', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'context-settings-validation-'));
  const settings = new AgentSettingsService(root, () => false);
  try {
    const before = await settings.snapshot();
    for (const compaction of [{ keepRecentTokens: -1 }, { enabled: 'yes' }, { modelOverrides: { unused: { reserveTokens: 1.5 } } }, { reserveTokens: null }]) {
      await expect(settings.update({ scope: 'global', expectedRevision: before.globalRevision, set: { compaction }, remove: [] })).rejects.toMatchObject({ code: 'invalid_settings' });
      expect(await settings.snapshot()).toEqual(before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
