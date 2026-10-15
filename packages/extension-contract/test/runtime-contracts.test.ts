import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  parseVarinExtensionManifest, parseVarinExtensionServiceProvision, parseVarinRuntimeContractRequest,
  VARIN_CONTEXT_FRAGMENTS_CONTRACT, VARIN_CONTEXT_FRAGMENTS_SERVICE,
  VarinExtensionContractError,
  type VarinServiceMethodContract,
} from '../src/index.js';

const manifest = (service: unknown) => ({ schemaVersion: 1, id: 'example.contract', version: '1.0.0', engines: { varin: '*' },
  entrypoints: { host: { mode: 'brokered', file: 'host.cjs', activation: ['service-request'] } }, provides: { services: [service] } });

test('existing context method contract survives manifest parsing without loading the implementation', () => {
  const parsed = parseVarinExtensionManifest(manifest(VARIN_CONTEXT_FRAGMENTS_SERVICE));
  const declaration = parsed.provides!.services![0]!;
  assert.deepEqual(declaration.contract?.methods.describe, {
    inputSchema: VARIN_CONTEXT_FRAGMENTS_CONTRACT.inputSchema,
    outputSchema: VARIN_CONTEXT_FRAGMENTS_CONTRACT.outputSchema,
  });
  assert.equal(declaration.contract?.composition, 'ordered');
  assert.deepEqual(parseVarinExtensionServiceProvision(declaration), declaration);
  (declaration.contract!.methods.describe as VarinServiceMethodContract).outputSchema = false;
  assert.notEqual(VARIN_CONTEXT_FRAGMENTS_CONTRACT.outputSchema, false, 'parsed metadata is detached from the author declaration');
});

test('published manifest schema and runtime reject unsafe source locators and malformed member contracts', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema/varin.extension.schema.json', import.meta.url), 'utf8'));
  // Same schema engine as the existing manifest consistency suite.
  const Constructor = Ajv2020 as unknown as new (options: object) => { compile(schema: unknown): (input: unknown) => boolean };
  const validate = new Constructor({ strict: false, formats: { 'semver-range': () => true } }).compile(schema);
  const tool = { name: 'source', description: 'Locate its implementation', inputSchema: true, outputSchema: true,
    operation: 'read', completion: 'result' };
  for (const source of [{ path: '/host/private.ts' }, { path: '../escape' }, { path: 'file:///secret' },
    { path: 'C:\\secret' }, { path: './relative' }, { path: 'source//file' }, { path: 'source/file', line: 0 },
    { path: ' ' }, { path: 'src/\n/../secret' }, { path: 'src/\u0000file' }, { path: 'src/' },
    { path: 'src/file', line: Number.MAX_SAFE_INTEGER + 1 }, { path: 'src/file', host: '/private' }]) {
    for (const declaration of [
      { contract: { methods: { read: { inputSchema: true, outputSchema: true, source } } } },
      { contract: { methods: {}, events: { changed: { schema: true, source } } } },
      { tool: { ...tool, source } },
    ]) {
      const value = manifest({ id: 'example.service', version: 1, ...declaration });
      assert.equal(validate(value), false, JSON.stringify(source));
      assert.throws(() => parseVarinExtensionManifest(value));
    }
  }
  for (const source of [undefined, { path: 'src/entry.ts', line: Number.MAX_SAFE_INTEGER }, { path: 'src/中文 file.ts' }]) {
    const value = manifest({ id: 'example.tool', version: 1, tool: { ...tool, ...(source ? { source } : {}) } });
    assert.equal(validate(value), true);
    assert.deepEqual(parseVarinExtensionManifest(value).provides!.services![0]!.tool!.source, source);
  }
  const valid = manifest({ id: 'example.service', version: 1, contract: {
    methods: { read: { inputSchema: true, outputSchema: false, source: { path: 'src/entry.ts', line: 5 } } },
    events: { changed: { schema: { type: 'string' } } },
  } });
  assert.equal(validate(valid), true);
  const composed = structuredClone(valid);
  const compositionContract = (composed.provides.services[0] as { contract: Record<string, unknown> }).contract;
  Object.assign(compositionContract, { composition: 'ordered' });
  assert.equal(validate(composed), true);
  assert.doesNotThrow(() => parseVarinExtensionManifest(composed));
  Object.assign(compositionContract, { composition: 'installation-order' });
  assert.equal(validate(composed), false);
  assert.throws(() => parseVarinExtensionManifest(composed));
  assert.doesNotThrow(() => parseVarinExtensionManifest(valid));
  const invalid = structuredClone(valid);
  (invalid.provides.services[0] as { contract: { methods: object } }).contract.methods = { read: { outputSchema: {} } };
  assert.equal(validate(invalid), false);
  assert.throws(() => parseVarinExtensionManifest(invalid));
});

test('tool execution schemas cannot acquire a second method declaration and queries cannot supply authority', () => {
  assert.throws(() => parseVarinExtensionServiceProvision({ id: 'example.tool', version: 1,
    tool: { name: 'inspect', description: 'Example', inputSchema: {}, outputSchema: {}, operation: 'read', completion: 'result' },
    contract: { methods: { execute: { inputSchema: {}, outputSchema: {} } } },
  }), (error: unknown) => error instanceof VarinExtensionContractError && error.issues.some(issue => issue.includes('duplicate')));
  for (const added of [{ runId: 'another' }, { routing: { projectId: 'another' } }, { providerId: 'old-generation' }, { path: '/private' }]) {
    assert.throws(() => parseVarinRuntimeContractRequest({ action: 'describe', kind: 'service', serviceId: 'example.service', version: 1, ...added }), /unknown field/);
  }
});

test('source query schema and decoder share exact identity, path and byte-page admission', async () => {
  const { VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA, parseVarinRuntimeContractResult } = await import('../src/index.js');
  const Constructor = Ajv2020 as unknown as new (options: object) => { compile(schema: unknown): (input: unknown) => boolean };
  const validate = new Constructor({ strict: false }).compile(VARIN_RUNTIME_CONTRACT_REQUEST_SCHEMA);
  const request = { action: 'read', kind: 'source', extensionId: 'example.source', slot: 'selected',
    artifactIntegrity: 'sha256-' + 'a'.repeat(64), path: 'src/中文.no-extension', offset: 0, maxBytes: 1 };
  assert.equal(validate(request), true);
  assert.deepEqual(parseVarinRuntimeContractRequest(request), request);
  for (const change of [{ runId: 'forged' }, { artifactIntegrity: '1.0.0' }, { slot: 'retained' }, { maxBytes: 0 },
    { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { path: '../secret' }, { path: '/secret' },
    { path: 'file:///secret' }, { path: 'foo\\bar' }, { path: 'src/./a' }, { path: 'src//a' }, { path: 'src/' }]) {
    assert.equal(validate({ ...request, ...change }), false, JSON.stringify(change));
    assert.throws(() => parseVarinRuntimeContractRequest({ ...request, ...change }), JSON.stringify(change));
  }
  const result = { ...request, origin: 'immutable_artifact', permission: 'checked_on_invocation', status: 'found',
    fileIntegrity: 'sha256-' + 'b'.repeat(64), page: { encoding: 'utf-8', text: '😀', offset: 0, byteLength: 4, totalBytes: 4, nextOffset: null } };
  assert.equal(parseVarinRuntimeContractResult(result).kind, 'source');
  assert.throws(() => parseVarinRuntimeContractResult({ ...result, page: { ...result.page, byteLength: 1 } }), /Invalid source page/);
  assert.throws(() => parseVarinRuntimeContractResult({ ...result, status: 'found', page: { ...result.page, nextOffset: 0 } }), /Invalid source page/);
  assert.throws(() => parseVarinRuntimeContractResult({ ...result, status: 'missing', code: 'artifact_corrupt' }), /Invalid source failure/);
});
