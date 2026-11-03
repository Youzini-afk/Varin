/** Real native Storage is supplied by the existing Rust stdio fixture. This
 * exercises original Source/Router owners, not product network/socket transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router, type Express } from 'express';
import { KernelClient, KernelClientError } from '../kernel/kernel-client.js';
import type { KernelHandshakeResult, KernelObjectSlice, KernelProcessSnapshot } from '../kernel/protocol.generated.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { prepareManagedAttachmentPath } from '../kernel/managed-attachment-path.js';
import { createSourceQueryService } from '../kernel/source-query-service.js';
import { createManagedSourceService } from './managed-source-service.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity } from './managed-remote-client.js';
import { registerManagedRemoteRoutes } from './managed-remote-routes.js';
import { routerTransport } from '../extensions/direct-router.test-helper.js';

const send = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let serial = 0;
const hash = (bytes: Uint8Array) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
async function run(frame: { root: string; epoch: string; storageRoot: string }) {
  const kernel = new KernelClient({ hostId: 'target', hostGeneration: 'target-generation', storageRoot: frame.storageRoot, buildVersion: '0.9.37' });
  const state = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  state.epoch = frame.epoch; state.started = true;
  state.handshakeResult = { hostId: 'target', storageRoot: frame.storageRoot, kernelEpoch: frame.epoch } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: (method: string, params: unknown, options: { grant?: { grantId: string }; signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted(); const id = `attachment-fixture:${++serial}`;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject });
      send({ kind: 'fixture-request', id, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) }); });
  } });
  const workspace = join(frame.root, 'execution'); await mkdir(workspace);
  const actor = kernel.scoped(await kernel.issueGrant({ grantId: 'fixture-owner', owningWorkspace: 'workspace', executionWorkspace: 'workspace',
    threadId: 'recipient', runId: 'actual-run', capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }));
  const root = await actor.fileRootRegister({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: workspace });
  const createSources = () => {
    const query = createSourceQueryService({ kernel, documents: { admitWorkspaceRegistration: async () => ({}) } as never,
      validateLiveSource: async () => {}, storage: {} as never, resourceOwners: { dataDirectory: frame.root } as never });
    return createManagedSourceService({ kernel, hostId: 'target', serviceOperation: query, releaseSource: scope => query.release(scope),
    documents: { admitWorkspaceRegistration: async () => ({ workspaceId: 'workspace', hostId: 'target', canonicalPath: workspace }) } as never,
    validateLiveSource: async () => {}, prepareSource: async () => { throw new Error('Attachment import must not prepare a Source'); } });
  };
  let sources = createSources();
  const remote = createManagedRemoteExecutionService({ hostId: 'target', client: kernel, sourceOwner: sources,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never });
  const router = Router(); const capabilities = ['filesystem:read', 'filesystem:write', 'terminal:use', 'process:control'];
  registerManagedRemoteRoutes(router as unknown as Express, { service: { ...remote, sources: () => sources }, resolveAuthContext: async request => {
    const token = request.headers.authorization;
    if (token !== 'Bearer original' && token !== 'Bearer foreign') return null;
    const id = token === 'Bearer original' ? 'principal' : 'foreign';
    return { type: 'client', clientId: id, client: { id, capabilities } };
  } });
  const transport = routerTransport(router);
  let dropped = false, dropNext = true, dropCapture = true, objectRequests = 0;
  const apiUrl = 'https://fixture.invalid';
  const resourceOwner = { kind: 'managed_host' as const, hostId: 'target', connectionId: 'target', endpointIdentity: managedEndpointIdentity({ apiUrl }) };
  const registry = (token: string) => createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'target', apiUrl, clientToken: token }] }),
    fetch: async (url, init = {}) => {
      if (String(url).includes('/sources/attachments/objects/')) objectRequests++;
      const response = await transport(new URL(String(url)), init);
      if (String(url).endsWith('/sources/service') && typeof init.body === 'string' && init.body.includes('attachment_capture') && dropCapture && response.ok) {
        dropCapture = false; throw new Error('Lost original capture reply');
      }
      if (String(url).endsWith('/sources/attachmentPath') && dropNext && response.ok) { dropNext = false; dropped = true; throw new Error('Lost path reply'); }
      return response;
    } });
  const client = await registry('original').source(resourceOwner);
  const selected = { resourceOwner, workspaceId: 'workspace', executionWorkspaceId: 'workspace', mode: 'live_root' as const,
    liveRoot: { hostId: 'target', rootId: String(root.rootId), canonicalRoot: String(root.canonicalRoot) }, tools: ['file_read', 'process_spawn', 'process_read', 'process_inspect'] };
  const binding = await client.bind({ coordinatorHostId: 'coordinator', scope: { kind: 'run', threadId: 'recipient', runId: 'actual-run', epoch: 1 }, source: selected, purpose: 'source', retention: 'run' });
  const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  const runtime = { coordinatorHostId: 'coordinator', withManagedSourceAuthority: async (_run: string, _source: unknown, consume: (input: unknown) => Promise<unknown>) => consume({ client, binding }) } as AgentRuntimeClient;
  // Real source owner captures immutable bytes before a lost HTTP response.
  await writeFile(join(workspace, 'source.txt'), 'original');
  const selection = { operationId: 'source-send', ref: 'attachment:source-proof', path: 'source.txt' };
  await assert.rejects(client.service({ ...address, requestId: 'source-capture', operation: { kind: 'attachment_capture', ...selection } }), /Lost original capture reply/);
  await writeFile(join(workspace, 'source.txt'), 'changed');
  const recoveredBinding = await client.bind({ coordinatorHostId: 'coordinator', scope: { kind: 'run', threadId: 'recipient', runId: 'actual-run', epoch: 1 },
    source: selected, purpose: 'result', retention: 'caller', operationId: 'result-recovery', deferMaterialization: true });
  const recoveredAddress = { coordinatorHostId: 'coordinator', authorityId: recoveredBinding.authorityId, resourceEpoch: recoveredBinding.resourceEpoch };
  const recovered = await client.service({ ...recoveredAddress, requestId: 'source-recover', operation: { kind: 'attachment_recover', ...selection } });
  assert.equal(recovered?.attachment.byteLength, 8);
  const sourcePage = await client.service({ ...recoveredAddress, requestId: 'source-read', operation: { kind: 'attachment_read', ref: selection.ref, offset: 0, length: 8 } });
  assert.equal(Buffer.from(sourcePage.bytesBase64, 'base64').toString(), 'original');
  await client.service({ ...recoveredAddress, requestId: 'source-release', operation: { kind: 'attachment_release', ref: selection.ref } });
  await client.release({ ...recoveredAddress, mode: 'retire' });
  await unlink(join(workspace, 'source.txt'));
  const bytes = Buffer.alloc(512 * 1024, 0x9a), rawHash = hash(bytes);
  const descriptor = Buffer.from(JSON.stringify({ format: 1, byteLength: 9, ranges: [{ offset: 3, length: 4, objectHash: rawHash, objectOffset: 100, objectLength: bytes.length }] }));
  const contentHash = `ranges-${hash(descriptor)}`, objects = new Map([[rawHash, bytes], [contentHash, descriptor]]);
  const attachment = { ref: 'attachment:sparse-original', filename: 'sparse.bin', mimeType: 'application/octet-stream', byteLength: 9 };
  const prepare = () => prepareManagedAttachmentPath({ runtime, runId: 'actual-run', source: binding.source, attachment, contentHash,
    readPage: async (offset, length, view = {}): Promise<KernelObjectSlice> => { const key = view.rangeObject ?? contentHash, body = objects.get(key)!;
      const nextOffset = Math.min(offset + length, body.length);
      return { hash: key, byteLength: body.length, offset, nextOffset, eof: nextOffset === body.length, bytesBase64: body.subarray(offset, nextOffset).toString('base64') }; } });
  await assert.rejects(prepare(), /Lost path reply/); assert(dropped);
  const requestsBeforeRetry = objectRequests;
  sources = createSources();
  const view = await prepare();
  assert.equal(objectRequests, requestsBeforeRetry, 'Reopened target must reuse its retained root without retransmitting dependencies');
  assert.deepEqual(await readFile(view.path), Buffer.from([0, 0, 0, 0x9a, 0x9a, 0x9a, 0x9a, 0, 0]));
  assert.equal(view.readOnly, true); if (process.platform !== 'win32') assert.equal((await stat(view.path)).mode & 0o222, 0);
  assert.deepEqual(await readdir(workspace), []);
  const records = await actor.listRecords({ workspaceId: 'workspace', recordType: 'attachment.import', threadId: 'recipient', runId: 'actual-run' });
  assert(records.records.some(record => record.references.some(reference => reference.objectHash === contentHash)));
  const operationId = JSON.parse(records.records.find(record => record.state === 'preparing')!.payloadJson).operationId as string;
  const request = { ...address, operationId, attachment, contentHash };
  await assert.rejects(client.attachmentBegin({ ...request, attachment: { ...attachment, filename: 'changed.bin' } }), /retry changed/);
  // A retained hash in this workspace does not authorize a new import to
  // borrow it. The descriptor must name dependencies retained by its intent.
  const unrelated = { ...request, operationId: 'unrelated-import', attachment: { ...attachment, ref: 'attachment:unrelated' } };
  await client.attachmentBegin(unrelated);
  await assert.rejects(client.attachmentPut({ ...address, operationId: unrelated.operationId, ref: unrelated.attachment.ref,
    contentHash, objectHash: contentHash, byteLength: descriptor.length }, (async function* () { yield descriptor; })()), /no admitted content owner/);
  for (const [name, body] of [['raw', bytes], ['empty', Buffer.alloc(0)]] as const) {
    const selected = { ref: `attachment:${name}`, filename: `${name}.bin`, mimeType: 'application/octet-stream', byteLength: body.length };
    const stored = await prepareManagedAttachmentPath({ runtime, runId: 'actual-run', source: binding.source, attachment: selected, contentHash: hash(body),
      readPage: async (offset, length) => { const nextOffset = Math.min(offset + length, body.length); return { hash: hash(body), byteLength: body.length,
        offset, nextOffset, eof: nextOffset === body.length, bytesBase64: body.subarray(offset, nextOffset).toString('base64') }; } });
    assert.deepEqual(await readFile(stored.path), body);
  }
  const foreign = await registry('foreign').source(resourceOwner);
  await assert.rejects(foreign.attachmentPath(request));
  await assert.rejects(client.attachmentPath({ ...request, resourceEpoch: 'stale-epoch' }));
  // A separate real process authority shares the actual Run, not an invented
  // target Catalog row. Retiring the import's grant cannot delete its input.
  const worker = await client.bind({ coordinatorHostId: 'coordinator', scope: { kind: 'run', threadId: 'recipient', runId: 'actual-run', epoch: 1 },
    source: selected, purpose: 'source', retention: 'caller', operationId: 'process-owner' });
  const workerAddress = { ...address, authorityId: worker.authorityId };
  const call = { runId: 'actual-run', operationId: 'model:tool:consumer', origin: { kind: 'model_step' as const, request_id: 'model' }, callId: 'consumer', name: 'process_spawn', schemaVersion: '1',
    arguments: { cwd: '', command: process.execPath, args: ['-e', `const fs=require('fs');if(fs.readFileSync(process.argv[1])[3]!==0x9a)process.exit(2);fs.writeFileSync(process.argv[2],'read');setInterval(()=>{},1000);`, view.path, join(workspace, 'consumer-ready')], mode: 'pipe' } };
  const started = await client.execute({ ...workerAddress, call });
  assert.equal((started.result as { completion?: { kind: string } }).completion?.kind, 'job_accepted', JSON.stringify(started));
  try {
    const readyDeadline = Date.now() + 15_000;
    while (!await stat(join(workspace, 'consumer-ready')).then(() => true, () => false)) { assert(Date.now() < readyDeadline, 'Original process did not read its attachment'); await new Promise(resolve => setTimeout(resolve, 10)); }
    await assert.rejects(client.release({ ...address, mode: 'retire' }), /retained|executing|active/i); assert.equal((await readFile(view.path)).length, 9); }
  finally { await client.cancel({ ...workerAddress, operationId: call.operationId }); }
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await client.observe({ ...workerAddress, operationId: call.operationId });
    const process = (result as typeof result & { process?: KernelProcessSnapshot }).process;
    if (result.executorStopped && process?.writerActive === false) break;
    assert(Date.now() < deadline, 'Original process did not stop'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  await client.release({ ...address, mode: 'retire' });
  await client.release({ ...workerAddress, mode: 'retire' });
  await assert.rejects(stat(view.path), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace, 'consumer-ready'), 'utf8'), 'read', 'Attachment cleanup must preserve the real Source');
  assert.equal((await actor.listRecords({ workspaceId: 'workspace', recordType: 'attachment.import' })).records.length, 0);
  send({ kind: 'fixture-result', ok: true, objectRequests, contentHash });
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.kind === 'fixture-response') { const request = pending.get(frame.id); if (!request) return; pending.delete(frame.id);
    if (frame.ok) request.resolve(frame.result); else request.reject(new KernelClientError({ code: 'operation-error', message: String(frame.error), retryable: false }));
  } else if (frame.kind === 'fixture-init') void run(frame).catch(error => send({ kind: 'fixture-result', ok: false, error: error instanceof Error ? error.stack : String(error) }));
});
