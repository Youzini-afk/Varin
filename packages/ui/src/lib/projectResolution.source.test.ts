import { expect, test } from 'vitest';
import { projectModelSettingsId, resolveProjectForSource } from './projectResolution';
import type { ProjectEntry } from '@varin/application-client';
const owner = { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'saved', endpointIdentity: 'endpoint' };
const projects: ProjectEntry[] = [{ id: 'local', path: '/same' }, { id: 'remote', path: '/same', source: { resourceOwner: owner, workspaceId: 'remote-root' } }];
test('prepared remote execution views retain original project registration rather than matching a local path', () => {
  expect(resolveProjectForSource(projects, { resourceOwner: owner, workspaceId: 'remote-root', path: '/private/execution' })?.id).toBe('remote');
  expect(resolveProjectForSource(projects, { resourceOwner: { kind: 'local' }, path: '/same' })?.id).toBe('local');
  expect(resolveProjectForSource(projects, { resourceOwner: { ...owner, endpointIdentity: 'replacement' }, path: '/same' })).toBeNull();
});
test('ambiguous projects are not guessed, and deepest actual additional folder wins', () => {
  expect(resolveProjectForSource([...projects, { ...projects[1]!, id: 'other' }], { resourceOwner: owner, workspaceId: 'remote-root' })).toBeNull();
  const nested = [{ id: 'short', path: '/a', additionalPaths: ['/same/deep'] }, { id: 'long-id', path: '/same' }];
  expect(resolveProjectForSource(nested, { resourceOwner: { kind: 'local' }, path: '/same/deep/file' })?.id).toBe('short');
});

test('model defaults use frozen local cwd and never redirect an old remote source through a replaced registration', () => {
  expect(projectModelSettingsId(projects, 'local', { resourceOwner: { kind: 'local' }, path: '/old/local' })).toBeUndefined();
  expect(projectModelSettingsId(projects, 'remote', { resourceOwner: owner, path: '/same' })).toBe('remote');
  expect(projectModelSettingsId([{ id: 'remote', path: '/replacement' }], 'remote', { resourceOwner: owner, path: '/same' })).toBeUndefined();
  expect(projectModelSettingsId([{ ...projects[1]!, path: '/other-remote' }], 'remote', { resourceOwner: owner, path: '/same' })).toBeUndefined();
});
