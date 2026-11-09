import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from './authority.test-helper.js';
import { prepareRefreshedContinuationSourceStore } from './child-source-store.js';
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
      const baseline = await store.putObject(Buffer.concat([gbkPrefix, Buffer.from('\r\nown=0\r\n\r\nteam=0\r\n')]));
      const attrBase = await store.putObject(Buffer.from('base'));
      await store.createBranch(workspace.workspaceId, 'previous', { 'file.txt': { kind: 'regular-file', objectHash: baseline.hash, byteLength: baseline.byteLength },
        'attributes.txt': { kind: 'regular-file', objectHash: attrBase.hash, byteLength: attrBase.byteLength, mode: 0o644 } },
        undefined, [], [], { sourceProvenance: provenance('gbk') });
      await baseline.release?.(); await attrBase.release?.();
      await fs.writeFile(path.join(directory, 'file.txt'), Buffer.concat([gbkPrefix, Buffer.from('\r\nown=1\r\n\r\nteam=0\r\n')]));
      await fs.writeFile(path.join(directory, 'attributes.txt'), gbkPrefix, { mode: 0o644 });
      const result = await store.publishDirectoryResult('previous', directory, ['file.txt', 'attributes.txt'], { publicationId: 'legacy-result' });
      const incoming = await store.putObject(Buffer.from('中文\r\nown=0\r\n\r\nteam=1\r\n', 'utf8'));
      const attrIncoming = await store.putObject(Buffer.from('base'));
      await store.createBranch(workspace.workspaceId, 'child-incoming:refresh-encoding', { 'file.txt': { kind: 'regular-file', objectHash: incoming.hash, byteLength: incoming.byteLength },
        'attributes.txt': { kind: 'regular-file', objectHash: attrIncoming.hash, byteLength: attrIncoming.byteLength, mode: 0o600 } },
        undefined, [], [], { sourceProvenance: provenance('utf-8') });
      await incoming.release?.(); await attrIncoming.release?.();
      const source: LaunchSource = { resource_owner: { kind: 'local' }, mode: 'fixed_branch', live_root: null,
        workspace_id: workspace.workspaceId, execution_workspace_id: workspace.workspaceId, branch_id: 'previous', revision: result.resultRevision };
      const child = { execution_id: 'refresh-encoding', child_thread_id: 'child-thread', selected_profile: { work_mode: 'read_only' },
        source_basis: { kind: 'refreshed', source, root: result.root, provenance: provenance('gbk'), incoming: { run_id: 'incoming-run', source },
          result: { branch_id: 'previous', result_revision: result.resultRevision, root: result.root } } } as DelegatedExecution;
      const prepared = await prepareRefreshedContinuationSourceStore(child, store, signal);
      const entry = await store.readPath(prepared.source.branch_id!, 'file.txt', { revision: 0 });
      expect(await store.readContent(entry!)).toEqual(Buffer.from('中文\r\nown=1\r\n\r\nteam=1\r\n', 'utf8'));
      const attr = await store.readPath(prepared.source.branch_id!, 'attributes.txt', { revision: 0 });
      expect(await store.readContent(attr!)).toEqual(gbkPrefix);
      expect(attr?.state).toMatchObject({ mode: 0o600 });
      expect(prepared.provenance).toMatchObject({ consistency: 'refreshed-root', conflicts: [], textEncoding: { files: { 'file.txt': 'utf-8', 'attributes.txt': 'gbk' } } });
      expect((await prepareRefreshedContinuationSourceStore(child, store, signal)).pin.root).toBe(prepared.pin.root);
    });
  } finally { await native?.dispose(); await documents.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
