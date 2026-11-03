/** Actual upload, receipt replay and record retention against Rust Storage over
 * the existing test stdio bridge. No product socket or byte-store substitute. */
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { copyRangeContent, type FileContentReadOptions } from './file-content-transfer.js';
import { createMaterialReviewFixture, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';

const fixture = createMaterialReviewFixture(params => {
  assert.equal(params.owningWorkspace, 'workspace');
  assert.equal(params.executionWorkspace, 'workspace');
  assert.deepEqual(params.pathScopes, []);
  assert.deepEqual(params.capabilities, ['storage.read', 'storage.write', 'storage.maintenance']);
});
const { kernel } = fixture;
const bytes = async function* (value: Buffer) { yield value; };
async function run(frame: Record<string, unknown>) {
  fixture.initialize(frame);
  const grant = async (grantId: string) => kernel.issueGrant({ grantId, threadId: 'sender', owningWorkspace: 'workspace', executionWorkspace: 'workspace',
    capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [] });
  const firstGrant = await grant('first-upload'), first = kernel.scoped(firstGrant), original = Buffer.from([0, 0x81, 0xff, 0x55]);
  const receipt = await first.putBlobStream(bytes(original), { operationId: 'original-upload', byteLength: original.length });
  await kernel.revokeGrant(firstGrant.grantId); // finish committed, attachment record did not.
  const retry = kernel.scoped(await grant('retry-upload'));
  await assert.rejects(retry.getBlob(receipt.hash, { ownerId: receipt.ownerId }));
  const restored = await retry.putBlobStream(bytes(original), { operationId: 'original-upload', byteLength: original.length });
  assert.equal(restored.hash, receipt.hash); assert.notEqual(restored.ownerId, receipt.ownerId);
  const attachment = { ref: 'attachment:upload_original', filename: 'data.bin', mimeType: 'application/octet-stream', byteLength: original.length };
  await retry.putRecord({ operationId: 'retain-original', workspaceId: 'workspace', recordId: attachment.ref, recordType: 'attachment.file', state: 'temporary', threadId: 'sender',
    payloadJson: JSON.stringify({ attachment, contentHash: restored.hash }), references: [{ slot: 'source', objectHash: restored.hash }], ownerIds: [restored.ownerId] });
  const page = await retry.getBlob(restored.hash, { recordId: attachment.ref, slot: 'source' });
  assert.deepEqual(Buffer.from(page.bytesBase64, 'base64'), original);
  await assert.rejects(retry.putBlobStream(bytes(Buffer.from([1, 2, 3, 4])), { operationId: 'original-upload', byteLength: original.length }), /declared identity/);
  const empty = await retry.putBlobStream(bytes(Buffer.alloc(0)), { operationId: 'empty-upload', byteLength: 0 });
  assert.equal(empty.byteLength, 0);
  const hash = (body: Buffer) => `sha256-${createHash('sha256').update(body).digest('hex')}`;
  const dependency = Buffer.from('0123456789'), dependencyHash = hash(dependency);
  const descriptor = Buffer.from(JSON.stringify({ format: 1, byteLength: 8, ranges: [{ offset: 2, length: 4, objectHash: dependencyHash, objectOffset: 3, objectLength: dependency.length }] }));
  const reference = `ranges-${hash(descriptor)}`;
  const readPage = async (offset: number, length: number, view: FileContentReadOptions) => {
    const body = view.rangeObject ? dependency : descriptor, nextOffset = Math.min(body.length, offset + length);
    return { hash: view.rangeObject ?? reference, byteLength: body.length, offset, nextOffset, eof: nextOffset === body.length, bytesBase64: body.subarray(offset, nextOffset).toString('base64') };
  };
  const originalRangeGrant = await grant('first-range-upload');
  const originalRange = await copyRangeContent(kernel.scoped(originalRangeGrant), reference, 8, readPage, undefined, 'same-range-transfer');
  await kernel.revokeGrant(originalRangeGrant.grantId);
  const rangeRetry = kernel.scoped(await grant('retry-range-upload'));
  const range = await copyRangeContent(rangeRetry, reference, 8, readPage, undefined, 'same-range-transfer');
  assert.equal(range.hash, reference); assert.notEqual(range.ownerId, originalRange.ownerId);
  const rangedAttachment = { ref: 'attachment:ranged_original', filename: 'ranges.bin', mimeType: 'application/octet-stream', byteLength: 8 };
  await rangeRetry.putRecord({ operationId: 'retain-range', workspaceId: 'workspace', recordId: rangedAttachment.ref, recordType: 'attachment.file', state: 'temporary', threadId: 'sender',
    payloadJson: JSON.stringify({ attachment: rangedAttachment, contentHash: range.hash }), references: [{ slot: 'source', objectHash: range.hash }], ownerIds: [range.ownerId] });
  assert.deepEqual(Buffer.from((await rangeRetry.getBlob(reference, { recordId: rangedAttachment.ref, slot: 'source' })).bytesBase64, 'base64'), Buffer.from([0, 0, 51, 52, 53, 54, 0, 0]));
  write({ kind: 'fixture-result', ok: true });
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame.kind === 'fixture-init') void run(frame).catch(error => write({ kind: 'fixture-result', ok: false, error: error instanceof Error ? error.stack : String(error) }));
  else fixture.receive(frame);
});
