/** Real catalog/broker/SDK and ordinary capability owners over the existing Rust stdio fixture.
 * This helper never starts KernelClient's product transport or an HTTP listener. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_RUNTIME_CONTRACTS_CAPABILITY, VARIN_RUNTIME_TOOLS_CAPABILITY, parseVarinExtensionManifest } from '@varin/extension-contract';
import { createRuntimeContractOwner } from './runtime-contract-owner.js';
import { createNestedToolOwner } from './nested-tool-owner.js';
import { retainExtensionTool, type ExtensionToolLease } from './extension-tool-owner.js';
import { createMaterialReviewFixture, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';

const fixture = createMaterialReviewFixture(() => { throw new Error('Contract metadata must not acquire a Storage/file grant'); });
const { kernel, bridge } = fixture;
let extensions: ApplicationExtensionRuntime;
const leases: ExtensionToolLease[] = [];
let root: string;
const probeId = 'review.contract-probe';
const coldId = 'review.cold-contract';
const probe = { id: `${probeId}.query`, version: 1, tool: {
  name: 'contract_probe', description: 'Inspect this invocation and query one ordinary runtime contract.', operation: 'read', completion: 'result',
  inputSchema: { type: 'object', additionalProperties: false, properties: { nested: { type: 'boolean' } } },
  outputSchema: { type: 'object' },
} };
async function installProbe() {
  const repository = resolve('.'), path = join(root, 'probe');
  await mkdir(join(path, 'dist'), { recursive: true });
  const manifest = { schemaVersion: 1, id: probeId, displayName: 'Contract integration probe', version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { file: 'dist/host.cjs', mode: 'brokered', activation: ['service-request'] } },
    capabilities: { host: [VARIN_RUNTIME_TOOLS_CAPABILITY] }, provides: { services: [probe] } };
  parseVarinExtensionManifest(manifest);
  await writeFile(join(path, 'varin.extension.json'), JSON.stringify(manifest));
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'varin-contract-probe', version: '1.0.0', private: true }));
  const { build } = createRequire(join(repository, 'packages/extension-builtins/package.json'))('esbuild');
  await build({ stdin: { contents: `import { provideTool } from '@varin/extension-sdk';
    export function activate(context) { provideTool(context, ${JSON.stringify(probe)}, async (input, call) => {
      const listed = await call.tools.list();
      const described = await call.tools.describe('runtime_contract');
      const missing = await call.tools.describe('future_tool');
      const query = input.nested ? await call.tools.invoke({callId:'own-contract',name:'runtime_contract',arguments:{action:'describe',kind:'ui_slot',id:'workbench.editor.actions'}}) : null;
      return {listed,described,missing,query};
    }); }`, resolveDir: path, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(path, 'dist/host.cjs'),
    alias: { '@varin/extension-sdk': join(repository, 'packages/extension-sdk/dist/index.js'), '@varin/extension-contract': join(repository, 'packages/extension-contract/dist/index.js') } });
  await extensions.installOrStage({ source: { kind: 'local', display: 'Contract probe', specifier: path }, expectedRevision: (await extensions.catalog.snapshot()).revision });
  await extensions.reviewCapabilities({ extensionId: probeId, expectedRevision: (await extensions.catalog.snapshot()).revision,
    decisions: [{ realm: 'host', capability: VARIN_RUNTIME_TOOLS_CAPABILITY, granted: true }] });
  await extensions.setEnabled(probeId, true, (await extensions.catalog.snapshot()).revision);

  // A configured cold service is discoverable but never callable from this accepted directory.
  const cold = join(root, 'cold'); await mkdir(cold, { recursive: true });
  await writeFile(join(cold, 'package.json'), JSON.stringify({ name: 'varin-contract-cold', version: '1.0.0', private: true }));
  await writeFile(join(cold, 'host.cjs'), `exports.activate=()=>{require('node:fs').writeFileSync(${JSON.stringify(join(root, 'cold-executed'))},'unexpected');throw Error('Metadata discovery executed a cold provider');}`);
  await writeFile(join(cold, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id: coldId, displayName: 'Cold contract', version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
    provides: { services: [{ id: `${coldId}.future`, version: 1, tool: { ...probe.tool, name: 'future_tool', description: 'A cold configured tool, never selected for this Run.' } }] } }));
  await extensions.installOrStage({ source: { kind: 'local', display: 'Cold contract', specifier: cold }, expectedRevision: (await extensions.catalog.snapshot()).revision });
  await extensions.setEnabled(coldId, true, (await extensions.catalog.snapshot()).revision);
}
async function select(frame: Record<string, unknown>) {
  const state = await extensions.state();
  const query = state.catalog.extensions.flatMap(entry => entry.manifest.provides?.services ?? []).find(entry => entry.tool?.name === 'runtime_contract');
  assert(query, 'The real distribution must declare runtime_contract');
  const bindings = [];
  for (const descriptor of [query, probe]) {
    if (frame.onlyContract && descriptor === probe) continue;
    const selected = await extensions.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: 'execute', args: [], routing: { sessionId: String(frame.threadId) } });
    const retained = await retainExtensionTool({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [{ tool: descriptor.tool!.name, decision: 'allow' }] }) }, selected);
    leases.push(retained);
    const registered = bridge.register(String(frame.runId), retained.lease);
    bindings.push({ ownerId: registered.ownerId, generation: retained.generation, binding: retained.binding });
  }
  write({ kind: 'fixture-prepared', bindings });
}
async function handle(frame: Record<string, unknown>) {
  if (fixture.receive(frame)) return;
  if (frame.kind === 'fixture-initialize') {
    fixture.initialize(frame); root = String(frame.root);
    extensions = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'extensions'), varinVersion: '0.9.25', brokerScript: resolve('packages/extension-host/broker/broker-child.mjs') });
    extensions.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner(kernel));
    extensions.capabilities.register(VARIN_RUNTIME_CONTRACTS_CAPABILITY, createRuntimeContractOwner({ extensions, kernel }));
    await extensions.start(); await installProbe(); await select(frame); return;
  }
  if (frame.kind === 'fixture-select') return select(frame);
  if (frame.kind === 'fixture-finish') {
    const state = await extensions.state();
    assert(!state.services.providers.some(provider => provider.extensionId === coldId), 'Query must not prepare a cold service');
    await assert.rejects(access(join(root, 'cold-executed')), 'Cold provider must not execute');
    for (const lease of leases) lease.lease.release();
    bridge.close(); await extensions.stop();
    write({ kind: 'fixture-finished', cold: 'unprepared' }); return;
  }
  throw new Error(`Unexpected contract fixture frame ${String(frame.kind)}`);
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { void handle(JSON.parse(line) as Record<string, unknown>).catch(error => write({kind:'fixture-failed',error:String(error),stack:error instanceof Error ? error.stack : undefined})); });
