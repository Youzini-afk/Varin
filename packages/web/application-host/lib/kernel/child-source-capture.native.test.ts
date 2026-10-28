import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from './authority.test-helper.js';
import { createChildPhysicalCapture } from './child-source-capture.js';
import type { DelegatedExecution } from './protocol.generated.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it('shares one active native capture, drains cancellation independently, and observes later changes', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'varin-capture-sharing-')));
  const directory = path.join(root, 'work');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'body.txt'), 'original');
  const documents = createDocumentAuthority({ hostId: 'capture-sharing', dataDir: root,
    isAllowedRoot: async () => true, isTrusted: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: directory });
  const native = await createAuthorityTestRuntime({ documents, hostId: 'capture-sharing', dataDir: root });
  try {
    const registration = await native.client.issueGrant({ grantId: 'registration', owningWorkspace: workspaceId,
      executionWorkspace: workspaceId, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    const physical = await native.client.scoped(registration).fileRootRegister({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: directory });
    const source = { resource_owner: { kind: 'local' }, workspace_id: workspaceId, execution_workspace_id: workspaceId,
      branch_id: null, revision: null, mode: 'live_root', live_root: { hostId: 'capture-sharing', rootId: physical.rootId, canonicalRoot: directory } };
    // This test owns the capture boundary. Catalog admission is exercised by the
    // separate dispatch review; the pool reads only these admitted identities.
    const child = (id: string) => ({ execution_id: id, child_thread_id: `thread:${id}`, launch: {},
      source: { kind: 'pending', handoff: { operation_id: `handoff:${id}`, source, root: { kind: 'physical', root: source.live_root } } } }) as DelegatedExecution;
    const entered = gate(), proceed = gate(), joined = gate();
    let inspections = 0;
    const capture = createChildPhysicalCapture(native.client, native.adapter, { documents,
      inspectInventory: async () => { if (++inspections === 1) { entered.release(); await proceed.promise; } return { kind: 'directory' }; } });
    const first = new AbortController(), second = new AbortController();
    const input = { directory, rootId: String(physical.rootId), captureWorkspaceId: workspaceId };
    const a = capture({ ...input, child: child('a'), signal: first.signal });
    const rejected = expect(a).rejects.toThrow('first subscriber stopped');
    await entered.promise;
    const b = capture({ ...input, child: child('b'), signal: second.signal,
      onProgress: value => { if (value.phase === 'source_wait') joined.release(); } });
    await joined.promise;
    first.abort(new Error('first subscriber stopped'));
    proceed.release();
    await b;
    await rejected;
    expect(inspections).toBe(1);
    await native.workingStates.withBranchStore(workspaceId, 'inspect-capture', async store => {
      expect(await store.getBranchRoot('child-source:a')).toBeNull();
      expect((await store.getBranchRoot('child-source:b'))?.baseRoot).toBeDefined();
      const states = await store.readStateSlice('child-source:b', ['body.txt'], { revision: 0 });
      const state = states!['body.txt'];
      expect(state?.kind === 'regular-file' ? (await store.getObject(state.objectHash))?.toString() : null).toBe('original');
    });
    await fs.writeFile(path.join(directory, 'body.txt'), 'modified');
    await fs.writeFile(path.join(directory, 'added.txt'), 'new');
    await capture({ ...input, child: child('c'), signal: new AbortController().signal });
    expect(inspections).toBe(2);
    await native.workingStates.withBranchStore(workspaceId, 'inspect-later-capture', async store => {
      expect((await store.getBranchRoot('child-source:c'))?.baseRoot).not.toBe((await store.getBranchRoot('child-source:b'))?.baseRoot);
      const states = await store.readStateSlice('child-source:c', ['body.txt', 'added.txt'], { revision: 0 });
      const state = states!['body.txt'];
      expect(state?.kind === 'regular-file' ? (await store.getObject(state.objectHash))?.toString() : null).toBe('modified');
      expect(states!['added.txt']?.kind).toBe('regular-file');
    });
    const retainedHealth = await native.client.health();
    expect(retainedHealth.temporaryObjectOwners).toBe(0);
    const stopping = gate(), drain = gate(), lastEntered = gate();
    const cancelledCapture = createChildPhysicalCapture(native.client, native.adapter, { documents,
      inspectInventory: async (_directory, signal) => {
        lastEntered.release();
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
          stopping.release(); void drain.promise.then(() => reject(signal!.reason));
        }, { once: true }));
        return { kind: 'directory' };
      } });
    const last = new AbortController();
    let settled = false;
    const abandoned = cancelledCapture({ ...input, child: child('last'), signal: last.signal }).finally(() => { settled = true; });
    const cancelled = expect(abandoned).rejects.toThrow('last subscriber stopped');
    await lastEntered.promise;
    last.abort(new Error('last subscriber stopped'));
    await stopping.promise;
    expect(settled).toBe(false);
    drain.release(); await cancelled;
    // Count all owned branches, including native metadata companions, without
    // assuming how many implementation branches each retained source needs.
    expect(await native.client.health()).toMatchObject({
      temporaryObjectOwners: retainedHealth.temporaryObjectOwners, branches: retainedHealth.branches,
    });
    await native.workingStates.withBranchStore(workspaceId, 'inspect-cancelled-capture', async store => {
      expect(await store.getBranchRoot('child-source:last')).toBeNull();
      for (const [branch, expected] of [['b', 'original'], ['c', 'modified']] as const) {
        const states = await store.readStateSlice(`child-source:${branch}`, ['body.txt'], { revision: 0 });
        const state = states?.['body.txt'];
        expect(state?.kind === 'regular-file' ? (await store.getObject(state.objectHash))?.toString() : null).toBe(expected);
      }
    });
    await native.client.revokeGrant(registration.grantId);
  } finally {
    await native.dispose(); await documents.dispose(); await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
