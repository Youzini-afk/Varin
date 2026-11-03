import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createSourceQueryService } from './source-query-service.js';

it('captures the selected fixed revision once, reads from its retained receipt and rejects another Run', async () => {
  type RecordValue = { recordId: string; recordType: string; state: string; threadId: string; runId: string; payloadJson: string; references: Array<{slot: string; objectHash: string}> };
  const records = new Map<string, RecordValue>();
  const readBranch = vi.fn(async (input: { paths?: string[]; includeEntries?: boolean }) => ({ workspaceId: 'source', branchId: 'branch', view: 'revision', revision: 3,
    entries: input.includeEntries ? [{ path: 'notes.txt', state: { kind: 'regular-file', objectHash: 'sha256-file', byteLength: 3 } }] : [] }));
  const client = { readBranch, getRecord: vi.fn(async (_workspace: string, id: string) => records.get(id)),
    putBlobStream: vi.fn(async () => ({ hash: 'sha256-absolute', ownerId: 'transfer-owner', byteLength: 3 })),
    putRecord: vi.fn(async (record: RecordValue) => { records.set(record.recordId, record); return record; }),
    listRecords: vi.fn(async (query: { recordType: string; threadId: string; cursor?: number }) => {
      const all = [...records.values()].filter(value => value.recordType === query.recordType && value.threadId === query.threadId && value.state !== 'released');
      const start = query.cursor ?? 0, end = Math.min(start + 10, all.length);
      return { records: all.slice(start, end), nextCursor: end < all.length ? end : null };
    }),
    getBlob: vi.fn(async (hash: string, proof: unknown, options: { offset: number }) => ({ hash, bytesBase64: 'YWJj', byteLength: 3, offset: options.offset, nextOffset: 3, eof: true, proof })),
    releaseRecord: vi.fn(async (_op: string, _workspace: string, id: string) => { records.get(id)!.state = 'released'; }) };
  const grant = { grantId: 'grant', pathScopes: [''] };
  const source = { resource_owner: { kind: 'local' }, workspace_id: 'source', execution_workspace_id: 'source', mode: 'fixed_branch', branch_id: 'branch', revision: 3 };
  const artifact: { value?: unknown } = {};
  const receipt = vi.fn(async (method: string, input: { principalId: string }) => method === 'source.authority.inspect_scope'
    ? [{ purpose: 'source', grantId: 'writer-grant', source }]
    : { state: 'committed', grantId: input.principalId === 'client' ? 'writer-grant' : 'foreign-grant', receipt: { attachment: artifact.value } });
  const kernel = { scoped: () => client, assertGrantForScope: () => grant, sourceRequest: receipt, subscribeExit: () => () => {}, isReady: true };
  const releaseAbsolute = vi.fn(async () => {});
  const captureAbsolute = vi.fn(async () => ({ filename: 'report.pdf', mimeType: 'application/pdf', byteLength: 3, contentHash: 'sha256-absolute',
    chunks: (async function* () { yield Buffer.from('abc'); })(), readPage: vi.fn(), release: releaseAbsolute }));
  const service = createSourceQueryService({ kernel: kernel as never, documents: { admitWorkspaceRegistration: async () => {} } as never,
    captureAbsoluteAttachment: captureAbsolute as never,
    validateLiveSource: async () => {}, storage: {} as never, resourceOwners: { dataDirectory: '/tmp' } as never });
  const scope = { principal: { principalId: 'client' }, coordinatorHostId: 'coordinator', authorityId: 'authority', resourceEpoch: 'epoch', grant,
    scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 }, physicalRoot: null,
    source } as never;
  const capture = { kind: 'attachment_capture', operationId: 'send', ref: 'attachment:abc', path: 'notes.txt' } as const;
  expect(await service(scope, capture, new AbortController().signal)).toMatchObject({ attachment: { ref: 'attachment:abc', byteLength: 3 }, contentHash: 'sha256-file' });
  expect(await service(scope, { ...capture, kind: 'attachment_recover' }, new AbortController().signal)).toMatchObject({ attachment: { ref: 'attachment:abc' } });
  expect(await service(scope, { ...capture, kind: 'attachment_recover', ref: 'attachment:missing' }, new AbortController().signal)).toBeNull();
  const count = readBranch.mock.calls.length;
  await service(scope, capture, new AbortController().signal);
  // Path authority is checked on retry, but contents are not recaptured.
  expect(readBranch.mock.calls.slice(count).every(([request]) => !request.includeEntries)).toBe(true);
  expect(await service(scope, { kind: 'attachment_read', ref: 'attachment:abc', offset: 0, length: 3 }, new AbortController().signal)).toMatchObject({ bytesBase64: 'YWJj' });
  expect(client.getBlob).toHaveBeenCalledWith('sha256-file', { recordId: 'attachment:abc', slot: 'source' }, expect.any(Object));
  const other = { ...(scope as object), authorityId: 'other', scope: { kind: 'run', threadId: 'thread', runId: 'other-run', epoch: 1 } } as never;
  await expect(service(other, { kind: 'attachment_read', ref: 'attachment:abc', offset: 0, length: 3 }, new AbortController().signal)).rejects.toThrow('invalid');
  const artifactRef = `attachment:operation_${Buffer.from('file-write').toString('base64url')}`;
  const attachment = { ref: artifactRef, filename: 'notes.txt', mimeType: 'text/plain', byteLength: 3 };
  artifact.value = attachment;
  records.set(artifactRef, { recordId: artifactRef, recordType: 'attachment.file', state: 'temporary', threadId: 'thread', runId: '',
    payloadJson: JSON.stringify({ attachment, contentHash: 'sha256-file', operationId: 'file-write', sourceGrantId: 'writer-grant' }), references: [{ slot: 'source', objectHash: 'sha256-file' }] });
  expect(await service(scope, { kind: 'attachment_describe', ref: artifactRef }, new AbortController().signal)).toEqual({ attachment, contentHash: 'sha256-file' });
  expect(await service(scope, { kind: 'attachment_read', ref: artifactRef, offset: 0, length: 3 }, new AbortController().signal)).toMatchObject({ bytesBase64: 'YWJj' });
  await expect(service(scope, { kind: 'attachment_release', ref: artifactRef }, new AbortController().signal)).rejects.toThrow('outside its Run');
  expect(await service(scope, { kind: 'attachment_capture', operationId: 'abs', ref: 'attachment:absolute', path: '/external/report.pdf' }, new AbortController().signal))
    .toMatchObject({ attachment: { filename: 'report.pdf', mimeType: 'application/pdf' }, contentHash: 'sha256-absolute' });
  expect(captureAbsolute).toHaveBeenCalledWith(expect.objectContaining({ selectedPath: '/external/report.pdf' }), expect.any(AbortSignal));
  expect(releaseAbsolute).toHaveBeenCalledWith(true);
  const otherPrincipal = { ...(scope as object), authorityId: 'different-authority', principal: { principalId: 'different-client' } } as never;
  await expect(service(otherPrincipal, { kind: 'attachment_describe', ref: artifactRef }, new AbortController().signal)).rejects.toThrow('Source owner');
  await expect(service(otherPrincipal, { kind: 'attachment_recover', operationId: 'abs', ref: 'attachment:absolute', path: '/external/report.pdf' }, new AbortController().signal)).rejects.toThrow('identity changed');
  await expect(service(otherPrincipal, { kind: 'attachment_read', ref: 'attachment:absolute', offset: 0, length: 3 }, new AbortController().signal)).rejects.toThrow('invalid');
  await expect(service(otherPrincipal, { kind: 'attachment_release', ref: 'attachment:absolute' }, new AbortController().signal)).rejects.toThrow('changed its owner');
  await expect(service(scope, { ...capture, path: 'different.txt' }, new AbortController().signal)).rejects.toThrow('identity changed');
  await service(scope, { kind: 'attachment_release', ref: 'attachment:abc' }, new AbortController().signal);
  await expect(service(scope, { kind: 'attachment_read', ref: 'attachment:abc', offset: 0, length: 3 }, new AbortController().signal)).rejects.toThrow('unavailable');
  records.set('other-run-file', { recordId: 'other-run-file', recordType: 'attachment.file', state: 'temporary', threadId: 'thread', runId: 'other-run', payloadJson: '{}', references: [] });
  const selectedSource = { branch_id: 'branch', execution_workspace_id: 'source', mode: 'fixed_branch', resource_owner: { kind: 'local' }, revision: 3, workspace_id: 'source' };
  const discardedId = createHash('sha256').update(JSON.stringify(['client', 'coordinator', selectedSource, 'thread', 'run', 'discard', 'attachment:discard'])).digest('hex');
  const discardedIntent = `attachment.managed-capture-intent:${discardedId}`, discardedCapture = `attachment.capture:${discardedId}`;
  records.set(discardedIntent, { recordId: discardedIntent, recordType: 'attachment.managed-capture-intent', state: 'temporary', threadId: 'thread', runId: 'run', payloadJson: JSON.stringify({ captureId: discardedId, operationId: 'discard', ref: 'attachment:discard', path: 'pending.txt' }), references: [] });
  records.set(discardedCapture, { recordId: discardedCapture, recordType: 'attachment.capture', state: 'temporary', threadId: 'thread', runId: '', payloadJson: '{}', references: [] });
  await service(scope, { kind: 'attachment_discard', operationId: 'discard', ref: 'attachment:discard', path: 'pending.txt' }, new AbortController().signal);
  expect(records.get(discardedIntent)?.state).toBe('released'); expect(records.get(discardedCapture)?.state).toBe('released');
  for (let i = 0; i < 129; i++) {
    const op = `op-${i}`, ref = `attachment:item-${i}`;
    const id = createHash('sha256').update(JSON.stringify(['client', 'coordinator', selectedSource, 'thread', 'run', op, ref])).digest('hex');
    const intent = `attachment.managed-capture-intent:${id}`, captureId = `attachment.capture:${id}`;
    records.set(intent, { recordId: intent, recordType: 'attachment.managed-capture-intent', state: 'temporary', threadId: 'thread', runId: 'run', payloadJson: JSON.stringify({ captureId: id, operationId: op, ref }), references: [] });
    records.set(captureId, { recordId: captureId, recordType: 'attachment.capture', state: 'temporary', threadId: 'thread', runId: '', payloadJson: '{}', references: [] });
  }
  const foreignId = createHash('sha256').update(JSON.stringify(['different-client', 'coordinator', selectedSource, 'thread', 'run', 'foreign', 'attachment:foreign'])).digest('hex');
  const foreignIntent = `attachment.managed-capture-intent:${foreignId}`;
  records.set(foreignIntent, { recordId: foreignIntent, recordType: 'attachment.managed-capture-intent', state: 'temporary', threadId: 'thread', runId: 'run', payloadJson: JSON.stringify({ captureId: foreignId, operationId: 'foreign', ref: 'attachment:foreign' }), references: [] });
  await service(scope, { kind: 'attachment_cleanup' }, new AbortController().signal);
  expect(records.get(artifactRef)?.state).toBe('released'); // Original native Source receipt proved ownership.
  expect([...records.values()].filter(record => record.recordType === 'attachment.capture' && record.state !== 'released')).toHaveLength(0);
  expect(records.get('other-run-file')?.state).toBe('temporary');
  expect(records.get(foreignIntent)?.state).toBe('temporary');
  await service.dispose();
});

it('recovers an already captured file after its execution root disappears without rereading the path', async () => {
  const source = { resource_owner: { kind: 'local' }, workspace_id: 'source', execution_workspace_id: 'source', mode: 'materialized', branch_id: 'branch', revision: 3 };
  const canonicalSource = Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)));
  const id = createHash('sha256').update(JSON.stringify(['client', 'coordinator', canonicalSource, 'thread', 'run', 'send', 'attachment:abc'])).digest('hex');
  const recordId = `attachment.capture:${id}`;
  const captured = { recordId, recordType: 'attachment.capture', state: 'temporary', threadId: 'thread',
    payloadJson: JSON.stringify({ path: 'notes.txt', operationId: `attachment-capture:${id}`, executionWorkspaceId: 'source', canonicalRoot: '/gone',
      stateJson: JSON.stringify({ kind: 'regular-file', objectHash: 'sha256-file', byteLength: 3 }) }), references: [{ slot: 'source', objectHash: 'sha256-file' }] };
  const client = { getRecord: vi.fn(async (_workspace: string, ref: string) => ref === recordId ? captured : null),
    putRecord: vi.fn(async () => ({})), releaseRecord: vi.fn(async () => ({})), fileCapture: vi.fn(async () => { throw new Error('must not reread'); }) };
  const grant = { grantId: 'grant', pathScopes: [''] };
  const kernel = { scoped: () => client, assertGrantForScope: () => grant, subscribeExit: () => () => {}, isReady: true };
  const service = createSourceQueryService({ kernel: kernel as never, documents: {} as never, validateLiveSource: async () => {}, storage: {} as never, resourceOwners: { dataDirectory: '/tmp' } as never });
  const scope = { principal: { principalId: 'client' }, coordinatorHostId: 'coordinator', authorityId: 'authority', resourceEpoch: 'epoch', grant,
    scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 }, physicalRoot: null,
    source } as never;
  expect(await service(scope, { kind: 'attachment_recover', operationId: 'send', ref: 'attachment:abc', path: '/gone/notes.txt' }, new AbortController().signal))
    .toMatchObject({ attachment: { filename: 'notes.txt', byteLength: 3 }, contentHash: 'sha256-file' });
  expect(client.fileCapture).not.toHaveBeenCalled();
  await service.dispose();
});
