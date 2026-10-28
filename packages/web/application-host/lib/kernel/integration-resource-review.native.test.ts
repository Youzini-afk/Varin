import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from './authority.test-helper.js';
import { KernelRequestError } from './kernel-error.js';
import { IntegrationCoordinator } from '../harness/working-state/integration-coordinator.js';

const exec = promisify(execFile);

it('maps a scoped child publication into its parent subtree and undoes through the original file journal', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'varin-integration-subtree-')));
  const workspace = path.join(root, 'parent'), child = path.join(root, 'child'), dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(workspace, 'project'), { recursive: true }); await fs.mkdir(child);
  const before = 'original content\n';
  await fs.writeFile(path.join(workspace, 'project/body.txt'), before);
  await fs.writeFile(path.join(workspace, 'body.txt'), 'unrelated sibling');
  await fs.writeFile(path.join(child, 'body.txt'), before);
  const documents = createDocumentAuthority({ hostId: 'integration-scope', dataDir, isAllowedRoot: async () => true, isTrusted: async () => true });
  const parent = await documents.resolveWorkspace({ path: workspace }), execution = await documents.resolveWorkspace({ path: child });
  const native = await createAuthorityTestRuntime({ documents, hostId: 'integration-scope', dataDir });
  try {
    await native.workingStates.withBranchStore(parent.workspaceId, 'scope-baseline', async store => {
      const states = await store.captureDirectory(child, ['body.txt']);
      try { await store.createBranch(parent.workspaceId, 'scope-child', states); }
      finally { await store.releaseCapturedStates(states); }
    }, 'exclusive', { executionWorkspace: execution.workspaceId });
    await fs.writeFile(path.join(child, 'body.txt'), 'scoped child result\n');
    const result = await native.workingStates.withBranchStore(parent.workspaceId, 'scope-result',
      store => store.publishDirectoryResult('scope-child', child, ['body.txt']), 'exclusive', { executionWorkspace: execution.workspaceId });
    const coordinator = new IntegrationCoordinator({ workingStates: native.workingStates });
    const input = { workspaceId: parent.workspaceId, threadId: 'scope-child-thread', branchId: 'scope-child',
      resultRevision: result.resultRevision, operationId: 'scope-integration', pathMapping: { from: '', to: 'project' } };
    const preview = await coordinator.previewResult(input);
    expect(preview.mergeReady).toBe(true);
    const applied = await coordinator.mergeResult({ ...input, expectedBindingFingerprint: preview.bindingFingerprint });
    expect(applied.appliedPaths).toEqual(['project/body.txt']);
    expect(await fs.readFile(path.join(workspace, 'project/body.txt'), 'utf8')).toBe('scoped child result\n');
    expect(await fs.readFile(path.join(workspace, 'body.txt'), 'utf8')).toBe('unrelated sibling');
    expect((await coordinator.undoIntegration({ workspaceId: parent.workspaceId, threadId: input.threadId, operationId: applied.operationId })).status).toBe('compensated');
    expect(await fs.readFile(path.join(workspace, 'project/body.txt'), 'utf8')).toBe(before);
  } finally { await native.dispose(); await documents.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

/** Real Git linked worktree and native Storage IPC; all data belongs to this
 * temporary fixture. No renderer, installed-package or provider claim. */
it.skipIf(process.platform === 'win32')('integrates a fixed Git worktree result and undoes file-directory, deletion, binary, mode and symlink changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-integration-git-'));
  const workspace = path.join(root, 'workspace');
  const child = path.join(root, 'child');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(workspace);
  const git = async (...args: string[]) => (await exec('git', ['-C', workspace, ...args], { env: process.env })).stdout.trim();
  await git('init', '-q');
  for (const [name, body] of Object.entries({ node: 'original parent file\n', 'obsolete.txt': 'original deleted file\n',
    'run.sh': '#!/bin/sh\necho original\n', 'keep.txt': 'unrelated original\n' })) await fs.writeFile(path.join(workspace, name), body);
  await fs.mkdir(path.join(workspace, 'old-dir'));
  await fs.writeFile(path.join(workspace, 'old-dir', 'leaf.txt'), 'original directory child\n');
  await fs.chmod(path.join(workspace, 'run.sh'), 0o644);
  await git('add', '.');
  await git('-c', 'user.name=Varin fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline');
  await git('worktree', 'add', '--detach', child, 'HEAD');
  const head = await git('rev-parse', 'HEAD');
  const index = await fs.readFile(path.join(workspace, '.git', 'index'));
  const authority = createDocumentAuthority({ hostId: 'integration-git', dataDir,
    isAllowedRoot: async () => true, isTrusted: async () => true });
  const parent = await authority.resolveWorkspace({ path: workspace });
  const execution = await authority.resolveWorkspace({ path: child });
  const native = await createAuthorityTestRuntime({ documents: authority, hostId: 'integration-git', dataDir });
  let stage = 'capture original baseline';
  try {
    await native.workingStates.withBranchStore(parent.workspaceId, 'git-baseline', async store => {
      const base = await store.captureDirectory(workspace, ['node', 'old-dir', 'old-dir/leaf.txt', 'obsolete.txt', 'run.sh', 'keep.txt']);
      await store.createBranch(parent.workspaceId, 'git-child-source', base, head);
    });
    await fs.rm(path.join(child, 'node'));
    await fs.mkdir(path.join(child, 'node'));
    await fs.writeFile(path.join(child, 'node', 'child.txt'), 'fixed child content\n');
    await fs.rm(path.join(child, 'old-dir', 'leaf.txt'));
    await fs.rmdir(path.join(child, 'old-dir'));
    await fs.writeFile(path.join(child, 'old-dir'), 'fixed replacement file\n');
    await fs.rm(path.join(child, 'obsolete.txt'));
    await fs.writeFile(path.join(child, 'new.bin'), Buffer.from([0, 1, 254, 255]));
    await fs.chmod(path.join(child, 'run.sh'), 0o755);
    await fs.symlink('run.sh', path.join(child, 'run-link'));
    const paths = ['node', 'node/child.txt', 'old-dir', 'old-dir/leaf.txt', 'obsolete.txt', 'new.bin', 'run.sh', 'run-link'];
    stage = 'publish child result';
    const result = await native.workingStates.withBranchStore(parent.workspaceId, 'git-result',
      store => store.publishDirectoryResult('git-child-source', child, paths), 'exclusive',
      { executionWorkspace: execution.workspaceId });
    await fs.writeFile(path.join(child, 'node', 'child.txt'), 'later child content must not leak\n');
    await fs.writeFile(path.join(workspace, 'keep.txt'), 'later unrelated user edit\n');
    const coordinator = new IntegrationCoordinator({ workingStates: native.workingStates });
    const input = { workspaceId: parent.workspaceId, threadId: 'git-child-thread', branchId: 'git-child-source',
      resultRevision: result.resultRevision, operationId: 'git-integration-once' };
    stage = 'preview published result';
    const preview = await coordinator.previewResult(input);
    expect(preview.mergeReady).toBe(true);
    stage = 'reject parent changed after preview';
    await fs.writeFile(path.join(workspace, 'node'), 'later parent edit\n');
    await expect(coordinator.mergeResult({ ...input, operationId: 'git-integration-stale',
      expectedBindingFingerprint: preview.bindingFingerprint })).rejects.toThrow('Integration preview is stale');
    expect(await fs.readFile(path.join(workspace, 'node'), 'utf8')).toBe('later parent edit\n');
    expect(await fs.readFile(path.join(workspace, 'old-dir', 'leaf.txt'), 'utf8')).toBe('original directory child\n');
    expect((await native.recovery.getOperation(parent.workspaceId, 'git-integration-stale'))?.state).toBe('aborted');
    await fs.writeFile(path.join(workspace, 'node'), 'original parent file\n');
    // Restoring bytes is another parent change, including its native metadata.
    const restoredPreview = await coordinator.previewResult(input);
    expect(restoredPreview.mergeReady).toBe(true);
    stage = 'apply published result';
    const applied = await coordinator.mergeResult({ ...input, expectedBindingFingerprint: restoredPreview.bindingFingerprint });
    expect(applied.status).toBe('applied');
    expect(await fs.readFile(path.join(workspace, 'node', 'child.txt'), 'utf8')).toBe('fixed child content\n');
    expect(await fs.readFile(path.join(workspace, 'old-dir'), 'utf8')).toBe('fixed replacement file\n');
    expect(await fs.readFile(path.join(workspace, 'new.bin'))).toEqual(Buffer.from([0, 1, 254, 255]));
    expect(await fs.readlink(path.join(workspace, 'run-link'))).toBe('run.sh');
    expect((await fs.stat(path.join(workspace, 'run.sh'))).mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(workspace, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git('rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(workspace, '.git', 'index'))).toEqual(index);
    stage = 'undo original integration';
    expect((await coordinator.undoIntegration({ workspaceId: parent.workspaceId, threadId: input.threadId,
      operationId: applied.operationId })).status).toBe('compensated');
    expect(await fs.readFile(path.join(workspace, 'node'), 'utf8')).toBe('original parent file\n');
    expect(await fs.readFile(path.join(workspace, 'old-dir', 'leaf.txt'), 'utf8')).toBe('original directory child\n');
    expect(await fs.readFile(path.join(workspace, 'obsolete.txt'), 'utf8')).toBe('original deleted file\n');
    expect((await fs.stat(path.join(workspace, 'run.sh'))).mode & 0o777).toBe(0o644);
    for (const file of ['new.bin', 'run-link']) await expect(fs.lstat(path.join(workspace, file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(workspace, 'keep.txt'), 'utf8')).toBe('later unrelated user edit\n');
    expect(await git('status', '--porcelain')).toBe('M keep.txt');
    const journal = await native.recovery.getOperation(parent.workspaceId, applied.operationId);
    expect(journal?.state).toBe('undone');
    expect(journal?.result).toMatchObject({ effect: 'confirmed', executorStopped: true });
  } catch (error) {
    const rpc = error instanceof KernelRequestError ? ` [${error.method}; ${error.settlement}]` : '';
    throw new Error(`${stage}${rpc}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await authority.dispose();
    await native.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
