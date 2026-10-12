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
  assert.deepEqual(parseVarinExtensionServiceProvision(declaration), declaration);
  (declaration.contract!.methods.describe as VarinServiceMethodContract).outputSchema = false;
  assert.notEqual(VARIN_CONTEXT_FRAGMENTS_CONTRACT.outputSchema, false, 'parsed metadata is detached from the author declaration');
});

test('published manifest schema and runtime reject unsafe source locators and malformed member contracts', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema/varin.extension.schema.json', import.meta.url), 'utf8'));
  // Same schema engine as the existing manifest consistency suite.
  const Constructor = Ajv2020 as unknown as new (options: object) => { compile(schema: unknown): (input: unknown) => boolean };
  const validate = new Constructor({ strict: false, formats: { 'semver-range': () => true } }).compile(schema);
  for (const source of [{ path: '/host/private.ts' }, { path: '../escape' }, { path: 'file:///secret' },
    { path: 'C:\\secret' }, { path: './relative' }, { path: 'source//file' }, { path: 'source/file', line: 0 }]) {
    const value = manifest({ id: 'example.service', version: 1,
      contract: { methods: { read: { inputSchema: true, outputSchema: true, source } } } });
    assert.equal(validate(value), false, JSON.stringify(source));
    assert.throws(() => parseVarinExtensionManifest(value));
  }
  const valid = manifest({ id: 'example.service', version: 1, contract: {
    methods: { read: { inputSchema: true, outputSchema: false, source: { path: 'src/entry.ts', line: 5 } } },
    events: { changed: { schema: { type: 'string' } } },
  } });
  assert.equal(validate(valid), true);
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
