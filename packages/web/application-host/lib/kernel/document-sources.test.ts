import type { ThreadSource } from '@varin/application-client';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClient, KernelClientError } from './kernel-client.js';
import { KERNEL_PROTOCOL_VERSION, type LaunchSource } from './protocol.generated.js';
import { createDocumentSources, readSourceDocument } from './document-sources.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { ExperimentCaller } from '../harness/research-identity.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface Frame { kind: string; id: string; method?: string; grantId?: string; params?: Record<string, unknown> }

/** Real scoped KernelClient, Run-source admission and research caller projection.
 * The in-memory peer controls only Storage/Catalog responses, including actual drain. */
function fixture(mode: 'live_root' | 'fixed_branch', hold?: 'file.capture' | 'storage.getBlob') {
  const client = new KernelClient({ hostId: 'document-host', storageRoot: '/fixture/storage', buildVersion: 'fixture' });
  const owner = client as unknown as {
    epoch: string; handshakeResult: unknown; started: boolean; startPromise: Promise<unknown>;
    transport: { send(frame: Frame, lane: string): Promise<void>; cancelRequest(id: string, discard: boolean): void; close(): Promise<void> };
    consumeFrame(frame: unknown): void;
  };
  owner.epoch = 'original-epoch'; owner.handshakeResult = { storageRoot: '/fixture/storage' };
  owner.started = true; owner.startPromise = Promise.resolve(owner.handshakeResult);
  const bytes = Buffer.from('%PDF-1.7\noriginal source bytes');
  const state = { kind: 'regular-file', objectHash: `sha256-${createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.byteLength, mode: 420 };
  const source: LaunchSource = { resource_owner: { kind: 'local' }, mode, workspace_id: 'workspace', execution_workspace_id: 'execution',
    branch_id: mode === 'fixed_branch' ? 'fixed' : null, revision: mode === 'fixed_branch' ? 7 : null,
    live_root: mode === 'live_root' ? { hostId: 'document-host', rootId: 'original-root', canonicalRoot: '/fixture/source' } : null };
  const authority: ToolInvocationAuthority = { invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'op', callId: 'call',
    executorOwner: { kind: 'external', identity: 'web', epoch: 'web-owner' }, origin: { kind: 'model_step', request_id: 'step' },
    source, toolName: 'document_read', operation: 'read', completion: 'result', arguments: { path: 'paper.pdf' } };
  const frames: Array<{ frame: Frame; lane: string }> = [], cancellations: Array<{ id: string; discard: boolean }> = [];
  const entered = deferred<Frame>();
  const reply = (frame: Frame, result: unknown) => owner.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: frame.id, ok: true, result });
  const fail = (frame: Frame, code: string) => owner.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: frame.id, ok: false, error: { code, message: code } });
  owner.transport = {
    async send(frame, lane) {
      frames.push({ frame, lane });
      if (frame.kind === 'cancel') return;
      if (frame.method === hold) { entered.resolve(frame); return; }
      const p = frame.params!;
      switch (frame.method) {
        case 'runtime.run.inspect': reply(frame, { id: 'run', thread_id: 'thread', branch_id: 'branch' }); break;
        case 'runtime.launch.inspect': reply(frame, { run_id: 'run', selection: { source, tools: [], extension_bindings: [] } }); break;
        case 'runtime.operation.inspect': reply(frame, { id: 'op', execution_owner: authority.executorOwner,
          intent: { call: { call_id: 'call', schema_version: 'accepted-schema' }, contract: { completion: 'result', lifetime: 'run' } } }); break;
        case 'runtime.research.scopes': reply(frame, [{ rootThreadId: 'root', threadId: 'thread', branchId: 'branch', sourceRunId: 'run', source,
          canSubmit: true, readThreadIds: ['root', 'thread', 'sibling'], controlThreadIds: ['thread'] }]); break;
        case 'authority.grant.issue': reply(frame, { grant_id: p.grantId, kernel_epoch: owner.epoch, owning_workspace: p.owningWorkspace,
          execution_workspace: p.executionWorkspace, thread_id: p.threadId, run_id: p.runId, capabilities: p.capabilities, path_scopes: p.pathScopes }); break;
        case 'authority.grant.revoke': reply(frame, { revoked: true }); break;
        case 'file.root.register': reply(frame, { rootId: source.live_root!.rootId, canonicalRoot: source.live_root!.canonicalRoot }); break;
        case 'file.capture': reply(frame, { path: 'paper.pdf', stateJson: JSON.stringify(state), ownerId: 'capture-owner' }); break;
        case 'branch.read': reply(frame, { workspaceId: 'workspace', branchId: 'fixed', revision: 7, view: 'revision', root: 'fixed-root',
          entries: p.includeEntries === false ? [] : [{ path: 'paper.pdf', state }] }); break;
        case 'storage.getBlob': reply(frame, { hash: state.objectHash, byteLength: bytes.byteLength, offset: 0, bytesBase64: bytes.toString('base64'), nextOffset: bytes.byteLength, eof: true }); break;
        case 'storage.blob.release': reply(frame, { released: true }); break;
        default: throw new Error(`Unexpected document source wire request: ${frame.method}`);
      }
    },
    cancelRequest(id, discard) { cancellations.push({ id, discard }); }, async close() {},
  };
  const callers: ExperimentCaller[] = [];
  const documents = createDocumentSources({ kernel: client, runtime: new AgentRuntimeClient(client, undefined, undefined, undefined, undefined, undefined, async id => { expect(['workspace', 'execution']).toContain(id); }),
    resolveLiveSource: async selected => { expect(selected.liveRoot).toEqual(source.live_root); },
    experiments: { readArtifact: async caller => { callers.push(caller); return { name: 'plot.pdf',
      chunks: (async function* () { yield bytes; })() }; } },
  });
  return { documents, source, authority, bytes, frames, cancellations, entered: entered.promise, fail, callers };
}

it('captures the accepted live source without another file tool and preserves the fixed branch revision on immutable reads', async () => {
  for (const mode of ['live_root', 'fixed_branch'] as const) {
    const f = fixture(mode);
    const read = await f.documents.tool(f.authority).readPath!('paper.pdf');
    expect(read.source).toEqual(f.bytes);
    expect(read.sourceUrl).toBe(mode === 'live_root' ? 'file:///fixture/source/paper.pdf'
      : 'varin-source:///workspaces/workspace/branches/fixed/revisions/7/paper.pdf');
    const get = f.frames.find(value => value.frame.method === 'storage.getBlob')!.frame;
    expect(get.params).toMatchObject(mode === 'live_root' ? { ownerId: 'capture-owner' } : { branchId: 'fixed', revision: 7, path: 'paper.pdf' });
    expect(f.frames.filter(value => value.frame.method === 'file.capture')).toHaveLength(mode === 'live_root' ? 1 : 0);
    expect(f.frames.at(-1)!.frame.method).toBe('authority.grant.revoke');
  }
});

it.each(['file.capture', 'storage.getBlob'] as const)('keeps the original Run grant until cancelled %s actually settles', async method => {
  const f = fixture('live_root', method), controller = new AbortController();
  let settled = false;
  const reading = f.documents.tool(f.authority).readPath!('paper.pdf', controller.signal).catch(error => { settled = true; return error; });
  const request = await f.entered;
  controller.abort(); await tick();
  expect(settled).toBe(false);
  expect(f.cancellations).toEqual([{ id: request.id, discard: false }]);
  expect(f.frames.some(value => ['authority.grant.revoke', 'storage.blob.release'].includes(value.frame.method ?? ''))).toBe(false);
  f.fail(request, 'cancelled');
  expect(await reading).toBeInstanceOf(KernelClientError);
  expect(f.frames.at(-1)!.frame.method).toBe('authority.grant.revoke');
  expect(f.frames.filter(value => value.frame.method === 'storage.blob.release')).toHaveLength(method === 'storage.getBlob' ? 1 : 0);
});

it('uses the original research operation for tool artifact reads and the explicit historical source for user reads', async () => {
  const f = fixture('fixed_branch'), artifact = { attemptId: 'attempt', artifactId: 'artifact' };
  await f.documents.tool(f.authority).readArtifact!(artifact);
  await f.documents.artifact({ runtime: 'agent', threadId: 'thread', branchId: 'branch', sourceRunId: 'run' }, artifact);
  expect(f.frames.filter(value => value.frame.method === 'runtime.research.scopes').map(value => value.frame.params)).toEqual([
    { threadId: 'thread', branchId: 'branch', sourceRunId: 'run', operationId: 'op' },
    { threadId: 'thread', branchId: 'branch', sourceRunId: 'run' },
  ]);
  expect(f.callers[0]!.owner).toMatchObject({ runtime: 'agent', actor: { kind: 'tool', toolName: 'document_read', callId: 'call', schemaVersion: 'accepted-schema' }, operationId: 'op', source: f.source });
  expect(f.callers[1]!.owner).toMatchObject({ runtime: 'agent', actor: { kind: 'reader' }, runId: 'run' });
  expect(f.callers.every(caller => caller.access.kind === 'family' && caller.access.readThreadIds.includes('sibling') && caller.owner.threadId === 'thread')).toBe(true);
  await expect(f.documents.tool({ ...f.authority, source: null }).readPath!('paper.pdf')).rejects.toMatchObject({ harnessCode: 'unavailable' });
});


it('transfers managed binary pages into coordinator ingestion with target provenance and releases only the original capture', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(700_000, 0x7f)]);
  const objectHash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
  const original = fixture('live_root').authority;
  const source: LaunchSource = { ...original.source!, resource_owner: { kind: 'managed_host', hostId: 'host-b', connectionId: 'b', endpointIdentity: 'sha256-b' },
    live_root: { hostId: 'host-b', rootId: 'b-root', canonicalRoot: '/same-folder' } };
  const target = {
    readBranch: vi.fn(async () => { throw new Error('Live document must use its actual capture'); }),
    fileCapture: vi.fn(async () => ({ path: 'paper.pdf', ownerId: 'b-capture-owner', stateJson: JSON.stringify({ kind: 'regular-file', objectHash, byteLength: bytes.byteLength, mode: 420 }) })),
    getBlob: vi.fn(async (_hash, handle, range) => {
      expect(handle).toEqual({ ownerId: 'b-capture-owner' }); expect(range?.length).toBe(256 * 1024);
      const offset = range?.offset ?? 0, page = bytes.subarray(offset, offset + range!.length!);
      return { hash: objectHash, byteLength: bytes.byteLength, offset, nextOffset: offset + page.length, eof: offset + page.length === bytes.length, bytesBase64: page.toString('base64') };
    }),
    releaseBlob: vi.fn(async ownerId => { expect(ownerId).toBe('b-capture-owner'); return { released: true }; }),
  } satisfies Parameters<typeof readSourceDocument>[0]['client'];
  const service = vi.fn(async request => {
    expect(request.operation).toEqual({ kind: 'document_read', operationId: original.operationId, path: 'paper.pdf' });
    const document = await readSourceDocument({ client: target, source, physicalRoot: source.live_root,
      operationId: request.operation.operationId, path: request.operation.path });
    return { bytesBase64: document.source.toString('base64'), byteLength: document.source.length,
      sourceUrl: document.sourceUrl, title: document.title, contentType: document.contentType };
  });
  const access = { client: { service }, binding: { authorityId: 'original-b-authority', resourceEpoch: 'original-b-epoch' } };
  const runtime = { coordinatorHostId: 'host-a', launch: async () => ({ selection: { source } }),
    withManagedSourceAuthority: async (_run: string, selected: ThreadSource, consume: (owned: typeof access) => Promise<unknown>) => {
      expect(selected.resourceOwner).toEqual(source.resource_owner);
      return consume(access);
    } } as unknown as AgentRuntimeClient;
  const local = new Proxy({}, { get() { throw new Error('Managed document must not read the coordinator filesystem'); } });
  const documents = createDocumentSources({ kernel: local as never, runtime, resolveLiveSource: async () => { throw new Error('No local source'); },
    experiments: { readArtifact: async () => { throw new Error('No artifact read'); } } });
  const result = await documents.tool({ ...original, source }).readPath!('paper.pdf');
  expect(result.source).toEqual(bytes); expect(result.sourceUrl).toBe('varin-source:///hosts/host-b/workspaces/workspace/roots/b-root/paper.pdf');
  expect(target.getBlob).toHaveBeenCalledTimes(3); expect(target.releaseBlob).toHaveBeenCalledOnce();
  expect(result).not.toHaveProperty('content_object'); expect(target.readBranch).not.toHaveBeenCalled();
});

it('reads a user-selected PDF through the original research source and never fabricates a tool operation', async () => {
  const f = fixture('fixed_branch');
  const result = await f.documents.path({ runtime: 'agent', threadId: 'thread', branchId: 'branch', sourceRunId: 'run' }, 'paper.pdf');
  expect(result.contentType).toBe('application/pdf');
  expect(f.frames.filter(value => value.frame.method === 'runtime.research.scopes').map(value => value.frame.params)).toEqual([{ threadId: 'thread', branchId: 'branch', sourceRunId: 'run' }]);
  expect(f.frames.some(value => value.frame.method === 'runtime.operation.inspect')).toBe(false);
  expect(f.frames.at(-1)!.frame.method).toBe('authority.grant.revoke');
});
