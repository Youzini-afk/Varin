import { DocumentWorkspaceUnregisteredError } from '../documents/errors.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { KernelClient } from './kernel-client.js';
import { KERNEL_PROTOCOL_VERSION, type RetrievalQuery } from './protocol.generated.js';
import { createRetrievalSourceOwner } from './retrieval-source.js';

interface Frame { kind: string; id: string; method?: string; grantId?: string; params?: Record<string, unknown> }
const digest = (bytes: Buffer) => `d1_${createHash('sha256').update(bytes).digest('base64url')}`;
async function fixture(input: { bytes?: Buffer; stalled?: boolean; corruptOffset?: boolean; missingRegistration?: boolean } = {}) {
  const kernel = new KernelClient({ hostId: 'source-host', storageRoot: '/fixture/storage', buildVersion: 'fixture' });
  const peer = kernel as unknown as { epoch: string; handshakeResult: unknown; started: boolean; startPromise: Promise<unknown>;
    transport: { send(frame: Frame, lane: string): Promise<void>; cancelRequest(id: string, discard: boolean): void; close(): Promise<void> };
    consumeFrame(frame: unknown): void };
  peer.epoch = 'source-epoch'; peer.handshakeResult = { hostId: 'source-host', storageRoot: '/fixture/storage' };
  peer.started = true; peer.startPromise = Promise.resolve(peer.handshakeResult);
  const bytes = input.bytes ?? Buffer.from('\ufeffexport const value = "原始";\r\n' + '// filler\r\n'.repeat(10_000) + 'export const tailNeedle = true;\r\n');
  const frames: Frame[] = [];
  let cancelled = false, stopped = false;
  const reply = (frame: Frame, result: unknown) => peer.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: frame.id, ok: true, result });
  const pages = (jobId: string, cursor: number) => {
    const parts = [];
    for (let offset = 0; offset < bytes.length || offset === 0; offset += 64 * 1024) parts.push({ kind: 'bytes', path: 'allowed/source.ts', revision: digest(bytes),
      data: { offset: input.corruptOffset && offset > 0 ? offset + 1 : offset, byteLength: bytes.length, bytesBase64: bytes.subarray(offset, offset + 64 * 1024).toString('base64') } });
    const records = input.stalled ? [] : parts.slice(cursor, cursor + 1);
    return { jobId, workspaceId: 'workspace', kernelEpoch: peer.epoch, root: 'original-fixed-root',
      status: input.stalled ? stopped ? 'cancelled' : 'running' : 'ready', records,
      nextCursor: cursor + records.length, endCursor: input.stalled ? cursor : parts.length, scannedFiles: 1, message: null };
  };
  peer.transport = {
    async send(frame) {
      frames.push(frame); const p = frame.params!;
      switch (frame.method) {
        case 'authority.grant.issue': reply(frame, { grant_id: p.grantId, kernel_epoch: peer.epoch, owning_workspace: p.owningWorkspace,
          execution_workspace: p.executionWorkspace, thread_id: p.threadId, run_id: p.runId, capabilities: p.capabilities, path_scopes: p.pathScopes }); break;
        case 'branch.read': reply(frame, { workspaceId: 'workspace', branchId: 'original-branch', revision: 3, view: 'revision', root: 'original-fixed-root', entries: [] }); break;
        case 'compute.start': reply(frame, pages(String(p.jobId), 0)); break;
        case 'compute.read': reply(frame, pages(String(p.jobId), Number(p.cursor))); break;
        case 'compute.cancel': cancelled = true; reply(frame, { cancelled: true }); break;
        case 'compute.release': reply(frame, { released: true }); break;
        default: throw new Error(`Unexpected source request: ${frame.method}`);
      }
    }, cancelRequest() {}, async close() {},
  };
  const grant = await kernel.issueGrant({ grantId: 'original-grant', runId: 'run', threadId: 'thread', owningWorkspace: 'workspace', executionWorkspace: 'execution',
    capabilities: ['storage.read'], pathScopes: ['allowed'] });
  const query: RetrievalQuery = { runId: 'run', threadId: 'thread', grantId: grant.grantId, projectId: null,
    inferenceOwner: { kind: 'external', identity: 'retrieval', epoch: 'owner-epoch' }, invocation: { kind: 'model_step', requestId: 'step', toolCallId: 'call' },
    question: 'tailNeedle', source: { resource_owner: { kind: 'local' }, mode: 'fixed_branch', workspace_id: 'workspace', execution_workspace_id: 'execution',
      branch_id: 'original-branch', revision: 3, live_root: null }, physicalRoot: null };
  const readSnapshot = vi.fn(async () => { throw new Error('Fixed source must not read Documents disk or draft'); });
  const validateLiveSource = vi.fn(async () => { throw new Error('Fixed source must not validate a live directory'); });
  const sources = createRetrievalSourceOwner({ kernel, documents: { readSnapshot,
    admitWorkspaceRegistration: async workspaceId => { if (input.missingRegistration) throw new DocumentWorkspaceUnregisteredError(); return { workspaceId, canonicalPath: '/removed/original-project', hostId: 'source-host', kind: 'directory' }; } }, validateLiveSource });
  return { sources, query, bytes, frames, readSnapshot, validateLiveSource, cancelled: () => cancelled, stop: () => { stopped = true; } };
}

it('reads the exact original fixed source through all native pages with existing BOM, Unicode and revision semantics', async () => {
  const f = await fixture();
  expect(await f.sources.routingWorkspace(f.query, new AbortController().signal)).toBe('/removed/original-project');
  const result = await f.sources.read(f.query, 'allowed/source.ts', new AbortController().signal);
  expect(result).toEqual({ status: 'ready', source: 'working-branch', revision: digest(f.bytes), content: f.bytes.toString('utf8').slice(1) });
  expect(f.bytes.length).toBeGreaterThan(64 * 1024);
  const start = f.frames.find(frame => frame.method === 'compute.start')!;
  expect(start.grantId).toBe('original-grant');
  expect(start.params).toMatchObject({ operation: 'bytes', branchId: 'original-branch', revision: 3, paths: ['allowed/source.ts'], byteLength: Number.MAX_SAFE_INTEGER });
  expect(start.params).not.toHaveProperty('rootId');
  expect(f.frames.filter(frame => frame.method === 'authority.grant.issue')).toHaveLength(1);
  expect(f.frames.filter(frame => frame.method === 'compute.start')).toHaveLength(1);
  expect(f.frames.at(-2)?.method).toBe('compute.release');
  expect(f.readSnapshot).not.toHaveBeenCalled(); expect(f.validateLiveSource).not.toHaveBeenCalled();
});

it('does not accept missing source registration, a foreign grant or a changed byte continuation as empty source', async () => {
  const f = await fixture({ corruptOffset: true });
  const missing = await fixture({ missingRegistration: true });
  await expect(missing.sources.routingWorkspace(missing.query, new AbortController().signal)).rejects.toThrow(/not registered/);
  await expect(f.sources.routingWorkspace({ ...f.query, source: { ...f.query.source, workspace_id: 'unknown' } }, new AbortController().signal)).rejects.toThrow(/grant/);
  await expect(f.sources.read({ ...f.query, grantId: 'another-grant' }, 'allowed/source.ts', new AbortController().signal)).rejects.toThrow(/grant/);
  await expect(f.sources.read(f.query, 'allowed/source.ts', new AbortController().signal)).rejects.toThrow(/incomplete pages/);
  expect(f.frames.at(-1)?.method).toBe('compute.release');
});

it.each([Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from('binary\0body')])('keeps unsupported and binary source distinct from empty text', async bytes => {
  const f = await fixture({ bytes });
  expect(await f.sources.read(f.query, 'allowed/source.ts', new AbortController().signal)).toMatchObject({ status: 'unavailable' });
  const empty = await fixture({ bytes: Buffer.alloc(0) });
  expect(await empty.sources.read(empty.query, 'allowed/source.ts', new AbortController().signal)).toMatchObject({ status: 'ready', content: '', revision: digest(Buffer.alloc(0)) });
});

it('keeps the original compute reader through cancel until the real worker terminal page', async () => {
  const f = await fixture({ stalled: true }), controller = new AbortController();
  let settled = false;
  const reading = f.sources.read(f.query, 'allowed/source.ts', controller.signal).catch(error => { settled = true; return error; });
  await vi.waitFor(() => expect(f.frames.some(frame => frame.method === 'compute.start')).toBe(true));
  controller.abort();
  await vi.waitFor(() => expect(f.cancelled()).toBe(true));
  expect(settled).toBe(false); expect(f.frames.some(frame => frame.method === 'compute.release')).toBe(false);
  f.stop(); await reading;
  expect(settled).toBe(true); expect(f.frames.at(-1)?.method).toBe('compute.release');
});
