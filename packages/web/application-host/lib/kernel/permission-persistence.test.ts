import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { evaluatePermissionSubjects } from '@varin/protocol';
import { AgentSettingsService } from '../models/settings.js';
import { createSettingsPermissionSubjects } from '../harness/settings-authority.js';
import { createPermissionPersistence } from './permission-persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('persists exactly the admitted setting targets through the real global settings owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-permission-target-')); roots.push(root);
  const settings = new AgentSettingsService(root, () => false);
  const persistence = createPermissionPersistence(settings, async () => undefined);
  const resolve = createSettingsPermissionSubjects({ models: () => { throw new Error('not a model action'); } });
  const signal = new AbortController().signal;
  const args = { items: [{ id: 'appearance.time-format', set: { timeFormatPreference: '24h' } },
    { id: 'harness.permissions.mode', set: { 'harness.permissions.mode': 'bypass' } }] };
  const subjects = (await resolve('settings_update', args, signal))!;
  const target = { name: 'settings_update', arguments: args, subjects };
  expect(await persistence.prepare('run', target)).toMatchObject({ scope: 'targets', available: true });
  const receipt = await persistence.save('run', target, signal);
  expect(Array.isArray(receipt.rules)).toBe(true);
  const saved = await settings.harness();
  const policy = { mode: saved.permissions?.mode ?? 'normal', rules: saved.permissions?.rules ?? [] };
  expect(evaluatePermissionSubjects(subjects, policy).decision).toBe('allow');
  const other = (await resolve('settings_update', { id: 'harness.permissions.rules', set: { 'harness.permissions.rules': [] } }, signal))!;
  expect(evaluatePermissionSubjects(other, policy).decision).toBe('ask');
  expect(saved.permissions?.rules).toHaveLength(2);
  await persistence.save('run', target, signal);
  expect((await settings.harness()).permissions?.rules).toHaveLength(2);
});

it('does not override a deny introduced while persistent approval was waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-permission-race-')); roots.push(root);
  const settings = new AgentSettingsService(root, () => false), persistence = createPermissionPersistence(settings, async () => undefined);
  const target = { name: 'settings_update', arguments: { id: 'harness.permissions.mode' }, subjects: [{ tool: 'settings_update', arguments: { id: 'harness.permissions.mode' }, authority: 'settings:permissions' }] };
  expect((await persistence.prepare('run', target)).available).toBe(true);
  const initial = await settings.read();
  const denied = await settings.updateHarness(initial.revision, () => ({ permissions: { rules: [{ tool: 'settings_update', decision: 'deny' }] } }));
  await expect(persistence.save('run', target, new AbortController().signal)).rejects.toMatchObject({ code: 'permission_policy_constrained' });
  expect((await settings.read()).revision).toBe(denied.revision);
});
