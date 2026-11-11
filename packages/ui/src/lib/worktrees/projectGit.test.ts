import { beforeEach, expect, test, vi } from 'vitest';
import type { ProjectEntry } from '@varin/application-client';
const f = vi.hoisted(() => ({ execute: vi.fn(), github: vi.fn(), epoch: 1 }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), executeProjectGit: f.execute, executeProjectGitHub: f.github, getRuntimeEndpointGeneration: () => f.epoch }));
import { projectGitDirectory, scopedProjectGit, scopedProjectGitHub, projectGitFileLocation } from './projectGit';
const project = (host: string): ProjectEntry => ({ id: 'project', label: 'Project', path: '/same', source: { workspaceId: 'root', resourceOwner: { kind: 'managed_host', hostId: host, connectionId: host, endpointIdentity: host } } });
beforeEach(() => { vi.clearAllMocks(); f.epoch++; });
test('same path on different source owners has distinct status keys and frozen requests', async () => {
  const a = projectGitDirectory(project('a')), b = projectGitDirectory(project('b'));
  expect(a).not.toBe(b);
  await scopedProjectGit(a)!.stageGitFiles(a, ['file']);
  expect(f.execute).toHaveBeenLastCalledWith('project', project('a').source, { mode: 'live_root' }, 'stageGitFiles', [a, ['file']], undefined);
  await scopedProjectGit(b)!.getGitStatus(b);
  expect(f.execute.mock.calls.at(-1)?.[1]).toEqual(project('b').source);
});
test('explicit local source keeps the original local directory', () => {
  expect(projectGitDirectory({ ...project('a'), source: { resourceOwner: { kind: 'local' }, workspaceId: 'root' } })).toBe('/same');
});
test('old Host response cannot publish and old API cannot start another command', async () => {
  const address = projectGitDirectory(project('a')), api = scopedProjectGit(address)!;
  f.execute.mockImplementationOnce(async () => { f.epoch++; return {}; });
  await expect(api.getGitStatus(address)).rejects.toThrow('Application Host changed');
  await expect(api.stageGitFile(address, 'file')).rejects.toThrow('Application Host changed');
  expect(f.execute).toHaveBeenCalledTimes(1);
});
test('read cancellation reaches transport but does not cancel a Git mutation observation', async () => {
  const controller = new AbortController(), address = projectGitDirectory(project('a'));
  const api = scopedProjectGit(address, () => controller.signal)!;
  await api.getGitFileDiff(address, { path: 'file' });
  expect(f.execute.mock.calls.at(-1)?.[5]).toBe(controller.signal);
  await api.stageGitFile(address, 'file');
  expect(f.execute.mock.calls.at(-1)?.[5]).toBeUndefined();
});
test('full GitHub mutation and identity operations go to original source', async () => {
  const address = projectGitDirectory(project('a')), github = scopedProjectGitHub(address)!;
  await github.authActivate!('account');
  expect(f.github).toHaveBeenLastCalledWith('project', project('a').source, { mode: 'live_root' }, 'authActivate', ['account']);
  await github.prMerge!({ directory: address, number: 1, method: 'squash' } as never);
  expect(f.github.mock.calls.at(-1)?.[3]).toBe('prMerge');
});

test('adopted editor Git keeps original registration while addressing the actual view', async () => {
  const selection = { mode: 'native_workspace' as const, workspaceId: 'original-root', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
  const address = projectGitFileLocation({ projectId: 'project', resourceOwner: project('a').source!.resourceOwner, workspaceId: 'view-documents', root: '/target/execution/view', selection })!;
  await scopedProjectGit(address)!.getGitStatus(address);
  expect(f.execute.mock.calls.at(-1)?.[1]).toEqual({ resourceOwner: project('a').source!.resourceOwner, workspaceId: 'original-root' });
  expect(f.execute.mock.calls.at(-1)?.[2]).toEqual(selection);
});
