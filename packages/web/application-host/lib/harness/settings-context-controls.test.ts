import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AgentSettingsService } from '../models/settings.js';
import { createSettingsService } from './settings-service.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'settings-context-controls-')); directories.push(directory);
  const project = join(directory, 'project'); await mkdir(join(project, '.varin'), { recursive: true });
  const owner = new AgentSettingsService(directory, () => true);
  const service = createSettingsService({ agentSettings: () => owner, readAppSettings: async () => ({}),
    persistAppSettings: async () => { throw new Error('Wrong settings owner'); }, resolveWorkspaceRoot: async () => project });
  const caller = { threadId: 'thread', branchId: 'branch', workspaceId: 'admitted-project' };
  return { owner, service, caller, project };
}
it('updates a context leaf through the real native owner without replacing message-time or legacy recovery siblings', async () => {
  const { owner, service, caller } = await fixture();
  const initial = await owner.snapshot();
  await owner.update({ scope: 'global', expectedRevision: initial.globalRevision, set: { harness: { context: {
    backgroundPreparation: true, preparationWaterline: 0.8, messageTime: { enabled: true, timeZone: 'UTC' }, compactionRecovery: { enabled: false },
  } } }, remove: [] });
  const before = await owner.snapshot();
  const changed = await service.update(caller, { id: 'harness.context', expectedRevision: before.globalRevision, set: { 'harness.context.backgroundPreparation': false } });
  expect(changed.status).toBe('applied');
  expect((await owner.snapshot()).global).toMatchObject({ harness: { context: {
    backgroundPreparation: false, preparationWaterline: 0.8, messageTime: { enabled: true, timeZone: 'UTC' }, compactionRecovery: { enabled: false },
  } } });
  const read = await service.read(caller, { id: 'harness.context.compactionRecovery' });
  expect(read.entry).toMatchObject({ writable: false, apply: 'unsupported' });
  const revision = (await owner.snapshot()).globalRevision;
  await expect(service.update(caller, { id: 'harness.context.compactionRecovery', set: { 'harness.context.compactionRecovery.enabled': true } })).rejects.toThrow(/read-only/);
  expect((await owner.snapshot()).globalRevision).toBe(revision);
});
it('routes the project-default alias to the admitted trusted project, not legacy app metadata or global defaults', async () => {
  const { owner, service, caller, project } = await fixture();
  const initial = await owner.snapshot(project);
  const changed = await service.update(caller, { id: 'projects.default-model', expectedRevision: initial.projectRevision,
    set: { defaultProvider: 'project-provider', defaultModel: 'project-model' } });
  expect(changed.status).toBe('applied');
  const current = await owner.snapshot(project);
  expect(current.project).toMatchObject({ defaultProvider: 'project-provider', defaultModel: 'project-model' });
  expect(current.global).not.toHaveProperty('defaultModel');
  await expect(service.update(caller, { id: 'projects.default-model', scope: 'global', set: { defaultModel: 'wrong-owner' } })).rejects.toThrow(/targets project/);
  expect((await owner.snapshot(project)).globalRevision).toBe(current.globalRevision);
});
it('validates compaction budgets before saving and exposes their actual effective configured values', async () => {
  const { owner, service, caller } = await fixture();
  expect((await service.update(caller, { id: 'harness.compaction', set: { 'compaction.reserveRatio': 0.2, 'compaction.keepRecentTokens': 1234 } })).status).toBe('applied');
  const read = await service.read(caller, { id: 'harness.compaction' });
  expect(read.fields?.find(field => field.path === 'compaction.reserveRatio')?.effective).toMatchObject({ value: 0.2, basis: 'configured' });
  const revision = (await owner.snapshot()).globalRevision;
  expect((await service.update(caller, { id: 'harness.compaction', set: { 'compaction.reserveRatio': 1 } })).status).toBe('failed');
  expect((await owner.snapshot()).globalRevision).toBe(revision);
});
it('edits OCR language without replacing executable routing and refuses retired controls without writes', async () => {
  const { owner, service, caller } = await fixture();
  expect((await service.update(caller, { id: 'harness.document-reading', set: { 'harness.documentReading.doclingCommand': 'original-docling', 'harness.documentReading.tesseractCommand': 'original-ocr' } })).status).toBe('applied');
  const snapshot = await owner.snapshot();
  expect((await service.update(caller, { id: 'harness.document-reading', expectedRevision: snapshot.globalRevision, set: { 'harness.documentReading.ocrLanguage': 'fra' } })).status).toBe('applied');
  expect((await owner.snapshot()).global).toMatchObject({ harness: { documentReading: { doclingCommand: 'original-docling', tesseractCommand: 'original-ocr', ocrLanguage: 'fra' } } });
  const unchanged = (await owner.snapshot()).globalRevision;
  for (const [id, path, value] of [
    ['harness.dispatch', 'harness.dispatch', { concurrency: 1 }], ['harness.worktree', 'harness.worktree', { setup: 'echo ignored' }],
    ['chat.server-permission-auto-accept', 'serverPermissionAutoAcceptEnabled', true],
  ] as const) await expect(service.update(caller, { id, set: { [path]: value } })).rejects.toThrow(/read-only/);
  expect((await owner.snapshot()).globalRevision).toBe(unchanged);
});
