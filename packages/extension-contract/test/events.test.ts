import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseVarinExtensionManifest, parseVarinEventBatch, parseVarinEventConnections,
  parseVarinExtensionServiceContract, type VarinDurableEventSource } from '../src/index.js';
const durable: VarinDurableEventSource = { sourceId: 'messages', displayName: 'Messages',
  connectionsMethod: 'connections', receiveMethod: 'receive', modes: ['poll', 'push'], recovery: 'history',
  credentials: 'required', filterSchema: { type: 'object' } };
const contract = { methods: { connections: { inputSchema: true, outputSchema: true }, receive: { inputSchema: true, outputSchema: true } },
  events: { message: { schema: { type: 'object' }, durable } } };
const manifest = (services: unknown[]) => ({ schemaVersion: 1, id: 'example.mail', version: '1.0.0', engines: { varin: '*' },
  entrypoints: { host: { mode: 'brokered', file: 'host.cjs', activation: ['service-request'] } }, provides: { services } });
test('durable declarations survive manifest/schema and exact member inspection without making UI events durable', async () => {
  const value = manifest([{ id: 'example.messages', version: 1, contract }]);
  const schema = JSON.parse(await readFile(new URL('../schema/varin.extension.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false, formats: { 'semver-range': () => true } }).compile(schema);
  assert.equal(validate(value), true);
  assert.deepEqual(parseVarinExtensionManifest(value).provides!.services![0]!.contract!.events!.message!.durable, durable);
  assert.deepEqual(parseVarinExtensionServiceContract({ methods: {}, events: contract.events }).events, contract.events);
  assert.equal(parseVarinExtensionServiceContract({ methods: {}, events: { changed: { schema: true } } }).events!.changed!.durable, undefined);
  for (const modes of [[], ['unknown'], ['push', 'push']]) {
    const invalid = manifest([{ id: 'example.messages', version: 1, contract: { ...contract,
      events: { message: { schema: true, durable: { ...durable, modes } } } } }]);
    assert.equal(validate(invalid), false); assert.throws(() => parseVarinExtensionManifest(invalid));
  }
});
test('declaration rejects missing receiver methods and ambiguous source identities', () => {
  assert.throws(() => parseVarinExtensionManifest(manifest([{ id: 'example.messages', version: 1,
    contract: { ...contract, methods: {} } }])));
  assert.throws(() => parseVarinExtensionManifest(manifest([{ id: 'example.messages', version: 1, contract },
    { id: 'example.other', version: 1, contract }])));
  assert.throws(() => parseVarinEventConnections([{ connectionId: 'a', displayName: 'A' }, { connectionId: 'a', displayName: 'A' } ]));
});
test('ingress preserves stable identity and inline content while rejecting fabricated authority and storage references', () => {
  const batch = { expectedCursor: null, nextCursor: 'cursor', events: [{ eventId: 'e', occurredAtMs: 1, attributes: {},
    content: { data: null, parts: [{ kind: 'media', media: { media_type: 'image/png', data_base64: 'aGVsbG8=' } }] } }] };
  assert.deepEqual(parseVarinEventBatch(batch), batch);
  assert.throws(() => parseVarinEventBatch({ ...batch, principalId: 'someone-else' }));
  assert.throws(() => parseVarinEventBatch({ ...batch, coverage: { kind: 'from' } }));
  assert.throws(() => parseVarinEventBatch({ ...batch, events: [{ ...batch.events[0], content: { data: null,
    parts: [{ kind: 'attachment', attachment: { ref: 'private', filename: 'private.txt', mimeType: 'text/plain', byteLength: 1 } }] } }] }));
});

test('original files and Host-scoped echo correlations keep typed bytes without caller references', () => {
  const file = { fileId: 'original-pdf', filename: 'invoice.pdf', mimeType: 'application/pdf', bytesBase64: 'JVBERi0xLjQ=' };
  const batch = { expectedCursor: null, nextCursor: 'one', events: [{ eventId: 'e', occurredAtMs: 1, attributes: {},
    files: [file], content: { data: null, parts: [] }, echoOf: { ownerHostId: 'executing-host', followupId: 'f', occurrenceId: 'o', operationId: 'op' } }] };
  assert.deepEqual(parseVarinEventBatch(batch), batch);
  for (const invalid of [{ ...file, filename: '../invoice.pdf' }, { ...file, bytesBase64: 'not base64' }, { ...file, ref: 'private' }]) {
    assert.throws(() => parseVarinEventBatch({ ...batch, events: [{ ...batch.events[0], files: [invalid] }] }));
  }
  assert.throws(() => parseVarinEventBatch({ ...batch, events: [{ ...batch.events[0], files: [file, file] }] }));
  assert.doesNotThrow(() => parseVarinEventBatch({ ...batch, events: [{ ...batch.events[0], files: [{ ...file, bytesBase64: '' }] }] }));
});

test('replaceable state is explicit and retains source ordering without changing ordinary messages', () => {
  const event = { eventId: 'build-3', occurredAtMs: 10, attributes: {}, content: { data: null, parts: [] } };
  const batch = { expectedCursor: null, nextCursor: 'a', events: [event] };
  assert.equal(parseVarinEventBatch(batch).events[0]!.state, undefined);
  const state = { key: 'checks', sequence: 3, value: 'healthy' };
  assert.deepEqual(parseVarinEventBatch({ ...batch, events: [{ ...event, state }] }).events[0]!.state, state);
  for (const invalid of [{ ...state, sequence: -1 }, { ...state, sequence: 0.5 }, { ...state, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, key: '' }, { key: 'checks', sequence: 3 }]) {
    assert.throws(() => parseVarinEventBatch({ ...batch, events: [{ ...event, state: invalid }] }), /Invalid event state snapshot/);
  }
});
