import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from './authority.test-helper.js';
import { prepareContinuationSourceStore, prepareRefreshedContinuationSourceStore } from './child-source-store.js';
import type { ChildSourceProvenance, DelegatedExecution, LaunchSource } from './protocol.generated.js';

it('refreshes differently encoded immutable versions through the native codec and retains the resulting interpretation', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'varin-child-encoding-')));
  const directory = path.join(root, 'files'); await fs.mkdir(directory);
  const documents = createDocumentAuthority({ hostId: 'child-encoding', dataDir: path.join(root, 'data') });
  let native: Awaited<ReturnType<typeof createAuthorityTestRuntime>> | undefined;
  const signal = new AbortController().signal;
  const provenance = (encoding: string): ChildSourceProvenance => ({ consistency: 'stable-capture',
    contentMode: 'saved-files', captureScopes: [], omittedDraftPaths: [], textEncoding: { files: { 'file.txt': encoding } } });
  const gbkPrefix = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  try {
    native = await createAuthorityTestRuntime({ documents, hostId: 'child-encoding', dataDir: path.join(root, 'data') });
    const workspace = await documents.resolveWorkspace({ path: directory });
    await native.workingStates.withBranchStore(workspace.workspaceId, 'child-encoding-test', async store => {
      await fs.writeFile(path.join(directory, 'file.txt'), Buffer.concat([gbkPrefix, Buffer.from('\r\nown=0\r\n\r\nteam=0\r\n')]));
      await fs.writeFile(path.join(directory, 'attributes.txt'), 'base', { mode: 0o644 });
      // Both fixed stages inherit the real baseline attributes. Creating unrelated
      // metadata-free trees would add an attribute conflict before codec merging.
      const baseline = await store.captureDirectory(directory, ['file.txt', 'attributes.txt']);
      const baselineFile = baseline['file.txt'], baselineAttributes = baseline['attributes.txt'];
      if (baselineFile?.kind !== 'regular-file' || baselineAttributes?.kind !== 'regular-file') throw new Error('Baseline files were not captured');
      await store.createBranch(workspace.workspaceId, 'previous', baseline,
        undefined, [], [], { sourceProvenance: provenance('gbk') });
      await store.releaseCapturedStates(baseline);
      await fs.writeFile(path.join(directory, 'file.txt'), Buffer.concat([gbkPrefix, Buffer.from('\r\nown=1\r\n\r\nteam=0\r\n')]));
      await fs.writeFile(path.join(directory, 'attributes.txt'), gbkPrefix, { mode: 0o644 });
      const result = await store.publishDirectoryResult('previous', directory, ['file.txt', 'attributes.txt'], { publicationId: 'legacy-result' });
      const incoming = await store.putObject(Buffer.from('中文\r\nown=0\r\n\r\nteam=1\r\n', 'utf8'));
      // Windows exposes writable/read-only, not POSIX owner/group permissions.
      // Capture a real supported attribute edit on each platform, independently
      // of the previous result's body edit.
      const incomingMode = process.platform === 'win32' ? 0o444 : 0o600;
      await fs.writeFile(path.join(directory, 'attributes.txt'), 'base');
      await fs.chmod(path.join(directory, 'attributes.txt'), incomingMode);
      const incomingStates = await store.captureDirectory(directory, ['attributes.txt']);
      const incomingAttributes = incomingStates['attributes.txt'];
      if (incomingAttributes?.kind !== 'regular-file') throw new Error('Incoming attributes were not captured');
      expect(incomingAttributes.mode).toBe(incomingMode);
      if (process.platform === 'win32') expect((incomingAttributes.native?.windowsAttributes ?? 0) & 1).toBe(1);
      await store.createBranch(workspace.workspaceId, 'child-incoming:refresh-encoding', { 'file.txt': { ...baselineFile, kind: 'regular-file', objectHash: incoming.hash, byteLength: incoming.byteLength },
        'attributes.txt': incomingAttributes },
        undefined, [], [], { sourceProvenance: provenance('utf-8') });
      await incoming.release?.();
      await store.releaseCapturedStates(incomingStates);
      await fs.chmod(path.join(directory, 'attributes.txt'), baselineAttributes.mode ?? 0o644);
      const source: LaunchSource = { resource_owner: { kind: 'local' }, mode: 'fixed_branch', live_root: null,
        workspace_id: workspace.workspaceId, execution_workspace_id: workspace.workspaceId, branch_id: 'previous', revision: result.resultRevision };
      const child = { execution_id: 'refresh-encoding', child_thread_id: 'child-thread', selected_profile: { work_mode: 'read_only' },
        source_basis: { kind: 'refreshed', source, root: result.root, provenance: provenance('gbk'), incoming: { run_id: 'incoming-run', source },
          result: { branch_id: 'previous', result_revision: result.resultRevision, root: result.root } } } as DelegatedExecution;
      const prepared = await prepareRefreshedContinuationSourceStore(child, store, signal);
      expect(prepared.provenance).toMatchObject({ consistency: 'refreshed-root', conflicts: [] });
      const entry = await store.readPath(prepared.source.branch_id!, 'file.txt', { revision: 0 });
      expect(await store.readContent(entry!)).toEqual(Buffer.from('中文\r\nown=1\r\n\r\nteam=1\r\n', 'utf8'));
      const attr = await store.readPath(prepared.source.branch_id!, 'attributes.txt', { revision: 0 });
      expect(await store.readContent(attr!)).toEqual(gbkPrefix);
      expect(attr?.state).toMatchObject({ mode: incomingMode });
      if (process.platform === 'win32') expect(attr?.state).toMatchObject({ native: { windowsAttributes: incomingAttributes.native!.windowsAttributes } });
      expect(prepared.provenance).toMatchObject({ consistency: 'refreshed-root', conflicts: [], textEncoding: { files: { 'file.txt': 'utf-8', 'attributes.txt': 'gbk' } } });
      expect((await prepareRefreshedContinuationSourceStore(child, store, signal)).pin.root).toBe(prepared.pin.root);
      const continuation = { ...child, execution_id: 'continue-encoding', source_basis: {
        kind: 'immutable_source', source: prepared.pin.source, root: prepared.pin.root, pin: prepared.pin,
        provenance: { consistency: 'fixed-root', root: prepared.pin.root },
      } } as DelegatedExecution;
      const continued = await prepareContinuationSourceStore(continuation, store, signal);
      expect(continued.provenance).toEqual(continuation.source_basis!.provenance);
      expect(await store.readTextEncoding(continued.source.branch_id!, 0, { root: continued.pin.root }))
        .toEqual(await store.readTextEncoding(prepared.source.branch_id!, 0, { root: prepared.pin.root }));
    });
  } finally {
    await native?.dispose(); await documents.dispose();
    // Also clear READONLY if capture or an assertion failed before restoration.
    await fs.chmod(path.join(directory, 'attributes.txt'), 0o666).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
