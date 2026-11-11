import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentSettingsService } from './settings.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-agent-settings-')); roots.push(root);
  return { root, settings: new AgentSettingsService(root, () => false) };
}
it('rejects new unsupported automation but preserves legacy mode during unrelated writes and supports reset', async () => {
  const { root, settings } = await fixture();
  const initial = await settings.read();
  await expect(settings.updateHarness(initial.revision, () => ({ permissions: { mode: 'smart' } })))
    .rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  expect(await settings.read()).toEqual(initial);
  await writeFile(join(root, 'agent-settings.json'), JSON.stringify({ harness: { permissions: { mode: 'smart' } } }));
  const legacy = await settings.read();
  const renamed = await settings.update({ scope: 'global', expectedRevision: legacy.revision, set: { titleUpdateInterval: 5 }, remove: [] });
  expect(renamed.global).toMatchObject({ titleUpdateInterval: 5, harness: { permissions: { mode: 'smart' } } });
  await expect(settings.update({ scope: 'global', expectedRevision: renamed.globalRevision, set: { harness: { permissions: { mode: 'accept-edits' } } }, remove: [] }))
    .rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  expect((await settings.read()).revision).toBe(renamed.globalRevision);
  const reset = await settings.updateHarness(renamed.globalRevision, harness => ({ ...harness, permissions: { mode: 'normal' } }));
  expect(reset.document).toMatchObject({ harness: { permissions: { mode: 'normal' } } });
});
it('returns its actual commit without a fallible postcommit observation or a later writers revision', async () => {
  const { settings } = await fixture();
  const initial = await settings.read();
  const original = settings.global.update.bind(settings.global);
  let committedRevision: string | undefined;
  vi.spyOn(settings.global, 'update').mockImplementationOnce(async (...args) => {
    const committed = await original(...args); committedRevision = committed.revision;
    await original(committed.revision, document => ({ ...document, titleUpdateInterval: 99 }));
    vi.spyOn(settings, 'snapshot').mockRejectedValue(new Error('later context unavailable'));
    return committed;
  });
  const saved = await settings.update({ scope: 'global', expectedRevision: initial.revision, set: { titleUpdateInterval: 5 }, remove: [] });
  expect(saved.global).toEqual({ titleUpdateInterval: 5 });
  expect(saved.globalRevision).toBe(committedRevision);
  expect((await settings.read()).document).toEqual({ titleUpdateInterval: 99 });
});

it('commits global settings independently of an unreadable project and marks effective context unavailable', async () => {
  const { root } = await fixture();
  const project = join(root, 'project'); await mkdir(join(project, '.varin'), { recursive: true });
  await writeFile(join(project, '.varin', 'settings.json'), '{ invalid');
  const settings = new AgentSettingsService(root, () => true), initial = await settings.read();
  const saved = await settings.update({ cwd: project, scope: 'global', expectedRevision: initial.revision, set: { titleUpdateInterval: 5 }, remove: [] });
  expect(saved.global).toEqual({ titleUpdateInterval: 5 });
  expect(saved.effectiveUnavailable).toContain('Project settings');
  expect((await settings.read()).revision).toBe(saved.globalRevision);
  await expect(settings.update({ cwd: project, scope: 'project', expectedRevision: 'unknown', set: {}, remove: [] })).rejects.toThrow();
});

it('normalizes legacy search on the first real owner save without changing its credential or raw read revision', async () => {
  const { root, settings } = await fixture();
  const legacy = { provider: 'brave', endpoint: 'https://search.example/api', credentialRef: 'old-reference' };
  await writeFile(join(root, 'agent-settings.json'), JSON.stringify({ harness: { web: { search: legacy } } }));
  const before = await settings.read(); expect(before.document).toMatchObject({ harness: { web: { search: legacy } } });
  expect((await settings.harness()).web?.search).toMatchObject({ connections: [{ id: 'configured-brave', credentialRef: 'old-reference' }] });
  const saved = await settings.update({ scope: 'global', expectedRevision: before.revision, set: { titleUpdateInterval: 2 }, remove: [] });
  expect(saved.global).toMatchObject({ harness: { web: { search: { connections: [{ id: 'configured-brave', provider: 'brave', endpoint: legacy.endpoint, credentialRef: legacy.credentialRef, enabled: true }], defaultConnectionId: 'configured-brave', fallbackConnectionIds: [] } } } });
  expect((await new AgentSettingsService(root, () => false).read()).document).toEqual(saved.global);
});

it('keeps registered remote project defaults independent of one another and of a same-path local project', async () => {
  const { root } = await fixture();
  const directory = join(root, 'same');
  await mkdir(join(directory, '.varin'), { recursive: true });
  await writeFile(join(directory, '.varin', 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'local-model' }));
  const settings = new AgentSettingsService(root, cwd => cwd === directory);
  const remoteA = await settings.snapshot(directory, 'remote-a');
  const remoteB = await settings.snapshot(directory, 'remote-b');
  expect(remoteA.project).toEqual({}); expect(remoteB.project).toEqual({});
  const saved = await settings.update({ registeredProjectId: 'remote-a', scope: 'project', expectedRevision: remoteA.projectRevision,
    set: { defaultProvider: 'provider-a', defaultModel: 'model-a' }, remove: [] });
  expect(saved.project).toEqual({ defaultProvider: 'provider-a', defaultModel: 'model-a' });
  expect((await settings.snapshot(directory)).project).toEqual({ defaultProvider: 'local', defaultModel: 'local-model' });
  expect((await settings.snapshot(directory, 'remote-b')).project).toEqual({});
  await expect(settings.update({ registeredProjectId: 'remote-a', scope: 'project', expectedRevision: remoteA.projectRevision,
    set: { defaultModel: 'stale' }, remove: [] })).rejects.toMatchObject({ code: 'config_conflict' });
  const reopened = new AgentSettingsService(root, () => false);
  expect((await reopened.snapshot(undefined, 'remote-a')).project).toEqual(saved.project);
  expect((await reopened.snapshot(undefined, 'remote-b')).project).toEqual({});
});
