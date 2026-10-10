import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { DocumentsFileObservationOwner } from './file-observation-owner.js';
import type { FileObservationTarget, FileWatchPosition, FileObservationOwnerResult } from './protocol.generated.js';
import { FileObservationBridge, type PrivateFileObservationResponse } from './file-observation-bridge.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const requireValue = <T>(value: T | undefined | null): T => { if (value == null) throw new Error('Missing owner result'); return value; };
async function fixture(mode: 'live_root' | 'materialized' = 'live_root', relative = 'result.txt') {
  const h = await createDocumentAuthorityHarness();
  const changed = vi.fn();
  const validate = vi.fn(async () => {
    const workspace = await h.authority.inspectWorkspace(h.identity.workspaceId);
    if (!('root' in workspace) || workspace.root !== h.workspaceRoot) throw new Error('source unavailable');
  });
  const owner = new DocumentsFileObservationOwner(h.authority, validate, changed);
  const root = mode === 'live_root' ? h.workspaceRoot : path.join(h.root, 'managed');
  if (mode === 'materialized') await fs.mkdir(root);
  const physicalRoot = { hostId: h.identity.hostId, rootId: 'root:original', canonicalRoot: root };
  const target: FileObservationTarget = { receiptId: 'file-observation:one:0', followupId: 'one', sourceIndex: 0,
    sourceRunId: 'original-run', threadId: 'original-thread', physicalRoot, path: relative, immutable: false,
    source: { workspace_id: h.identity.workspaceId, execution_workspace_id: h.identity.workspaceId,
      mode, branch_id: mode === 'live_root' ? null : 'fixed-source', revision: mode === 'live_root' ? null : 1,
      live_root: mode === 'live_root' ? physicalRoot : null } };
  cleanups.push(async () => { owner.stop(); await h.cleanup(); });
  const signal = new AbortController().signal;
  const opened = await owner.query({ action: 'open', target }, signal);
  if (!opened.ok || !('watchId' in opened)) throw new Error('watch failed');
  const watchId = opened.watchId;
  const read = async (after: FileWatchPosition | null) => {
    const begin = await owner.query({ action: 'begin', target, watchId, after }, signal);
    if (!begin.ok || !('token' in begin)) throw new Error('begin failed');
    return owner.query({ action: 'finish', target, watchId, token: begin.token, after }, signal);
  };
  return { h, owner, root, target, changed, signal, read, watchId, validate };
}
function completed(result: FileObservationOwnerResult) {
  if (!result.ok || !('managedIdle' in result)) throw new Error('Expected completed read');
  return result;
}

it('retains real targeted invalidations until the Catalog cursor acknowledges them, and resets report gaps', async () => {
  const f = await fixture();
  const baseline = completed(await f.read(null));
  const sibling = await f.owner.query({ action: 'open', target: f.target }, f.signal);
  if (!sibling.ok || !('watchId' in sibling)) throw new Error('second watch failed');
  expect(sibling.watchId).not.toBe(f.watchId);
  await f.owner.query({ action: 'close', receiptId: f.target.receiptId, watchId: sibling.watchId }, f.signal);
  expect(f.owner.has(f.target.receiptId, f.watchId)).toBe(true);
  await fs.writeFile(path.join(f.root, 'result.txt'), 'first');
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalled());
  const observed = completed(await f.read(baseline.position));
  expect(observed).toMatchObject({ targetedChange: true, gap: false, stable: true, managedIdle: true });
  // A lost Catalog publication cannot consume a transient Host read's evidence.
  expect(completed(await f.read(baseline.position)).targetedChange).toBe(true);
  expect(completed(await f.read(observed.position)).targetedChange).toBe(false);
  f.h.authority.emitWatchOverflow(f.h.identity.workspaceId);
  expect(completed(await f.read(observed.position))).toMatchObject({ gap: true, targetedChange: false });
  const begin = await f.owner.query({ action: 'begin', target: f.target, watchId: f.watchId, after: observed.position }, f.signal);
  if (!begin.ok || !('token' in begin)) throw new Error('begin failed');
  expect(await f.owner.query({ action: 'discard', receiptId: f.target.receiptId, watchId: f.watchId, token: begin.token }, f.signal))
    .toEqual({ ok: true, discarded: true });
  expect(await f.owner.query({ action: 'close', receiptId: f.target.receiptId, watchId: f.watchId }, f.signal)).toEqual({ ok: true, closed: true });
  expect(f.h.authority.hasWatch(f.h.identity.workspaceId)).toBe(false);
  const reopened = await f.owner.query({ action: 'open', target: f.target }, f.signal);
  if (!reopened.ok || !('watchId' in reopened)) throw new Error('reopen failed');
  f.h.setTrusted(false);
  expect(await f.owner.query({ action: 'begin', target: f.target, watchId: reopened.watchId, after: observed.position }, f.signal))
    .toEqual({ ok: false, code: 'authority_denied' });
  expect(f.owner.has(f.target.receiptId, reopened.watchId)).toBe(false);
});

it('last managed writer close wakes an unchanged path and cannot retroactively make an unstable read ready', async () => {
  const f = await fixture();
  const baseline = completed(await f.read(null));
  const writer = await f.h.authority.registerWriter(f.h.token(), { purpose: 'produce-file' });
  await fs.writeFile(path.join(f.root, 'result.txt'), 'visible while the writer continues');
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalled());
  const visible = completed(await f.read(baseline.position));
  expect(visible).toMatchObject({ stable: true, managedIdle: false, targetedChange: true });
  const begin = await f.owner.query({ action: 'begin', target: f.target, watchId: f.watchId, after: visible.position }, f.signal);
  if (!begin.ok || !('token' in begin)) throw new Error('begin failed');
  f.changed.mockClear();
  await writer.close();
  expect(f.changed).toHaveBeenCalledWith(f.target.receiptId);
  const stopped = completed(await f.owner.query({ action: 'finish', target: f.target, watchId: f.watchId, token: begin.token, after: visible.position }, f.signal));
  expect(stopped).toMatchObject({ stable: false, managedIdle: true, targetedChange: false });
  expect(completed(await f.read(stopped.position))).toMatchObject({ stable: true, managedIdle: true });
  // Root loss is source failure, never the missing-file condition or a new root.
  await fs.rename(f.root, `${f.root}-moved`);
  expect(await f.read(stopped.position).catch(() => 'unavailable')).toBe('unavailable');
});

it('watches the original materialized root and wakes for an atomically arriving directory without borrowing the workspace', async () => {
  const f = await fixture('materialized', 'nested/result.txt');
  const baseline = completed(await f.read(null));
  f.changed.mockClear();
  await fs.writeFile(path.join(f.h.workspaceRoot, 'result.txt'), 'other source');
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.changed).not.toHaveBeenCalled();
  const prepared = path.join(f.h.root, 'prepared');
  await fs.mkdir(prepared); await fs.writeFile(path.join(prepared, 'result.txt'), 'real original result');
  await fs.rename(prepared, path.join(f.root, 'nested'));
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalledWith(f.target.receiptId));
  const after = completed(await f.read(baseline.position));
  expect(after.gap).toBe(false);
  expect(await fs.readFile(path.join(f.root, 'nested/result.txt'), 'utf8')).toBe('real original result');
  expect(f.validate).not.toHaveBeenCalled();
  expect(await f.owner.query({ action: 'begin', target: { ...f.target, physicalRoot: { ...f.target.physicalRoot!, canonicalRoot: f.h.workspaceRoot } },
    watchId: f.watchId, after: after.position }, f.signal)).toEqual({ ok: false, code: 'root_changed' });
});

it('private channel cancellation drains its owner query and drops old-epoch replies and invalidations', async () => {
  let epoch = 'first'; const replies: PrivateFileObservationResponse[] = [];
  let finish: ((value: FileObservationOwnerResult) => void) | undefined; let signal: AbortSignal | undefined;
  const invalidate = vi.fn(); const reset = vi.fn();
  const bridge = new FileObservationBridge(() => epoch, async reply => { replies.push(reply); }, () => { throw new Error('transport'); });
  bridge.setOwner({ query: async (_query, caller) => { signal = caller; return new Promise(resolve => { finish = resolve; }); }, invalidate, reset });
  bridge.consume({ v: 1, kind: 'file-observation-request', id: 'one', kernelEpoch: epoch,
    query: { action: 'close', receiptId: 'original', watchId: 'watch' } });
  bridge.consume({ v: 1, kind: 'file-observation-cancel', id: 'one', kernelEpoch: epoch });
  expect(requireValue(signal).aborted).toBe(true); expect(replies).toEqual([]);
  epoch = 'second'; bridge.close(); requireValue(finish)({ ok: true, closed: true });
  await Promise.resolve(); await Promise.resolve(); expect(replies).toEqual([]);
  bridge.consume({ v: 1, kind: 'file-observation-invalidated', scope: 'root', kernelEpoch: 'first', rootId: 'root', canonicalRoot: '/old' });
  expect(invalidate).not.toHaveBeenCalled(); expect(reset).toHaveBeenCalledOnce();
  bridge.consume({ v: 1, kind: 'file-observation-invalidated', scope: 'receipt', kernelEpoch: 'second', receiptId: 'fixed-without-root' });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ v: 1, kind: 'file-observation-invalidated', scope: 'receipt', kernelEpoch: 'second', receiptId: 'fixed-without-root' });
});
