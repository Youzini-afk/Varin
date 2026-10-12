import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseVarinExtensionPackageInstallRequest, parseVarinExtensionPackageRequest, VarinExtensionContractError,
  type VarinExtensionSourceViewProvenance,
} from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';
import { ExtensionArtifactStore } from '../src/artifact-store.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const source = (suffix = 'a'): VarinExtensionSourceViewProvenance => ({ workspaceId: 'workspace', executionWorkspaceId: 'workspace',
  runId: 'original-run', operationId: 'original-operation', mode: 'materialized', branchId: 'branch', revision: 0,
  rootId: 'actual-working-copy', packagePath: 'extension', captureIntegrity: `sha256-${suffix.repeat(64)}` });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-authored-package-'));
  const directory = join(root, 'capture'); await mkdir(directory);
  let blocked: ReturnType<typeof deferred> | undefined;
  let entered: ReturnType<typeof deferred> | undefined;
  let activations = 0;
  let forced = 0;
  let failActivation = false;
  const observerErrors: unknown[] = [];
  const options = { dataDir: join(root, 'data'), varinVersion: '1.2.3', brokerScript: 'never-spawned',
    onObserverError: (error: unknown) => { observerErrors.push(error); },
    transportFactory: () => ({ forceTerminate() { forced++; }, terminate: async () => {}, async request(method) {
      if (method === 'activate') {
        activations++; entered?.resolve(); await blocked?.promise;
        if (failActivation) { failActivation = false; throw new Error('candidate startup failed'); }
        return { provisions: [] };
      }
      return null;
    } }),
  } satisfies Parameters<typeof ApplicationExtensionRuntime.create>[0];
  let runtime = await ApplicationExtensionRuntime.create(options);
  const write = async (body: string, capabilities: string[] = [], withSurface = false) => {
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ id: 'example.authored', schemaVersion: 1, version: '1.0.0',
      engines: { varin: '*' }, capabilities: { host: capabilities }, entrypoints: { host: { mode: 'brokered', file: 'host.js' },
        ...(withSurface ? { surfaces: [{ id: 'panel', file: 'surface.cjs', mode: 'managed', supports: ['web'] }] } : {}) } }));
    await writeFile(join(directory, 'host.js'), `export default { activate() { ${body} } };`);
    if (withSurface) await writeFile(join(directory, 'surface.cjs'), 'exports.activate = () => {};');
  };
  return { root, directory, get runtime() { return runtime; }, write, observerErrors, activations: () => activations, forced: () => forced,
    restart: async (failCandidate = false) => { await runtime.stop(); failActivation = failCandidate;
      runtime = await ApplicationExtensionRuntime.create(options); await runtime.supervisor.reconcile(); },
    block: () => { blocked = deferred(); entered = deferred(); return { release: blocked.resolve, entered: entered.promise }; },
    close: async () => { blocked?.resolve(); await runtime.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('real authored panel is captured into the original artifact/catalog and first installation remains disabled', async () => {
  const f = await fixture();
  try {
    await cp(fileURLToPath(new URL('../../../examples/extensions/agent-authored-panel/', import.meta.url)), f.directory, { recursive: true });
    let observed = 0;
    f.runtime.subscribe(() => { throw new Error('observer failed'); });
    f.runtime.subscribe(() => { observed++; });
    const staged = await f.runtime.stageCapturedPackage(f.directory, source(), 0);
    assert.equal(staged.outcome, 'installed_disabled'); assert.equal(staged.applicationRequested, false);
    const entry = (await f.runtime.catalog.snapshot()).extensions[0]!;
    assert.equal(entry.desired.enabled, false); assert.equal(entry.source.kind, 'source_view');
    assert.deepEqual(entry.source.provenance, source()); assert.equal(f.activations(), 0);
    assert.equal(observed, 1); assert.equal(f.observerErrors.length, 1);
    const bytes = await f.runtime.packages.readSource({ action: 'read', kind: 'source', extensionId: entry.manifest.id,
      slot: 'selected', artifactIntegrity: staged.artifactIntegrity, path: 'host.js' });
    assert.equal(bytes.status, 'found');
    await writeFile(join(f.directory, 'host.js'), 'throw Error("mutable source must not be read");');
    assert.deepEqual(await f.runtime.packages.readSource({ action: 'read', kind: 'source', extensionId: entry.manifest.id,
      slot: 'selected', artifactIntegrity: staged.artifactIntegrity, path: 'host.js' }), bytes);
    const update = await f.runtime.stageCapturedPackage(f.directory, source('b'), staged.catalogRevision);
    const requested = await f.runtime.requestCandidateApplication({ extensionId: entry.manifest.id,
      candidateIntegrity: update.artifactIntegrity, expectedRevision: update.catalogRevision });
    const selected = await f.runtime.selectCandidate({ extensionId: entry.manifest.id,
      candidateIntegrity: update.artifactIntegrity, expectedRevision: requested.revision });
    assert.equal(selected.extensions[0]!.integrity, update.artifactIntegrity);
    assert.equal(selected.extensions[0]!.desired.enabled, false); assert.equal(f.activations(), 0);
    assert.throws(() => parseVarinExtensionPackageInstallRequest({ expectedRevision: 1, source: {
      kind: 'source_view', display: 'forged', specifier: '/host/private', provenance: source() } }), error => error instanceof VarinExtensionContractError && error.issues.some(issue => issue.includes('cannot be installed')));
    assert.throws(() => parseVarinExtensionPackageRequest({ action: 'stage', packagePath: '../host', expectedRevision: 0 }));
  } finally { await f.close(); }
});

test('same-version updates preserve enablement and capability decisions; apply cannot approve new capabilities', async () => {
  const f = await fixture();
  try {
    await f.write('return 1;');
    const installed = await f.runtime.stageCapturedPackage(f.directory, source(), 0);
    const enabled = await f.runtime.setEnabled(installed.extensionId, true, installed.catalogRevision);
    assert.equal(f.activations(), 1);
    await f.write('return 2;', ['workspace.documents']);
    const staged = await f.runtime.stageCapturedPackage(f.directory, source('b'), enabled.revision);
    const before = await f.runtime.catalog.snapshot();
    assert.equal(staged.outcome, 'candidate_staged'); assert.equal(before.extensions[0]!.desired.enabled, true);
    assert.equal(before.extensions[0]!.integrity, installed.artifactIntegrity);
    assert.equal(before.extensions[0]!.candidate!.capabilitiesReviewed, false);
    await assert.rejects(f.runtime.applyPackageCandidate({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: staged.catalogRevision }), /capability_review_required/);
    assert.deepEqual(await f.runtime.catalog.snapshot().then(s => s.extensions), before.extensions);
    const reviewed = await f.runtime.reviewCandidateCapabilities({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: staged.catalogRevision,
      decisions: [{ capability: 'workspace.documents', realm: 'host', granted: false }] });
    f.runtime.subscribe(() => { throw new Error('application observer failed'); });
    const selected = await f.runtime.applyPackageCandidate({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: reviewed.revision });
    assert.equal(selected.outcome, 'selected');
    assert.ok(f.observerErrors.length > 0);
    const promotedAsset = await f.runtime.packages.readAsset({ extensionId: installed.extensionId, slot: 'candidate',
      integrity: staged.artifactIntegrity, path: 'package/host.js' });
    assert.equal(promotedAsset.artifactIntegrity, staged.artifactIntegrity);
    const oldSlot = await f.runtime.packages.readSource({ action: 'read', kind: 'source', extensionId: installed.extensionId,
      slot: 'candidate', artifactIntegrity: staged.artifactIntegrity, path: 'host.js' });
    assert.equal(oldSlot.status, 'missing');
    assert.equal((await f.runtime.catalog.snapshot()).extensions[0]!.capabilityGrants[0]!.granted, false);
    assert.equal((await f.runtime.prepareCandidate(installed.extensionId, staged.artifactIntegrity)).integrity, staged.artifactIntegrity);
    assert.equal((await f.runtime.selectCandidate({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: reviewed.revision })).extensions[0]!.integrity, staged.artifactIntegrity);
  } finally { await f.close(); }
});

test('cancelled application drains preparation; restart resumes its immutable Host/Surface candidate and failure preserves selection', async () => {
  const f = await fixture();
  try {
    await f.write('return 1;');
    const installed = await f.runtime.stageCapturedPackage(f.directory, source(), 0);
    const enabled = await f.runtime.setEnabled(installed.extensionId, true, installed.catalogRevision);
    await f.write('return 2;', [], true);
    const staged = await f.runtime.stageCapturedPackage(f.directory, source('b'), enabled.revision);
    const gate = f.block(), controller = new AbortController(); let returned = false;
    const applying = f.runtime.applyPackageCandidate({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: staged.catalogRevision }, controller.signal).then(result => { returned = true; return result; });
    await gate.entered; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    const current = await f.runtime.catalog.snapshot();
    assert.equal(current.extensions[0]!.integrity, installed.artifactIntegrity);
    assert.equal(current.extensions[0]!.candidate!.applyRequested, true);
    gate.release();
    const result = await applying;
    assert.equal(result.outcome, 'application_requested'); assert.equal(result.resumesOnRestart, true);
    assert.deepEqual(f.runtime.supervisor.activeExtensions(), [installed.extensionId]);
    await rm(f.directory, { recursive: true });
    await f.restart(true);
    assert.equal((await f.runtime.catalog.snapshot()).extensions[0]!.integrity, installed.artifactIntegrity);
    assert.deepEqual(f.runtime.supervisor.activeExtensions(), [installed.extensionId]);
    await f.restart();
    assert.equal((await f.runtime.catalog.snapshot()).extensions[0]!.integrity, staged.artifactIntegrity);
    assert.deepEqual(f.runtime.supervisor.activeExtensions(), [installed.extensionId]);
  } finally { await f.close(); }
});

test('explicit candidate rejection commits its catalog CAS before revoking and draining shared preparation', async () => {
  const f = await fixture();
  try {
    await f.write('return 1;');
    const installed = await f.runtime.stageCapturedPackage(f.directory, source(), 0);
    const enabled = await f.runtime.setEnabled(installed.extensionId, true, installed.catalogRevision);
    await f.write('return 2;');
    const staged = await f.runtime.stageCapturedPackage(f.directory, source('b'), enabled.revision);
    const gate = f.block();
    const preparing = f.runtime.prepareCandidate(installed.extensionId, staged.artifactIntegrity);
    const rejected = assert.rejects(preparing, /cancel/);
    await gate.entered;
    let returned = false;
    const discarding = f.runtime.discardCandidate({ extensionId: installed.extensionId,
      candidateIntegrity: staged.artifactIntegrity, expectedRevision: staged.catalogRevision }).then(result => { returned = true; return result; });
    while (f.forced() === 0) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await f.runtime.catalog.snapshot()).extensions[0]!.candidate, undefined);
    assert.equal(returned, false);
    gate.release(); await rejected;
    assert.equal((await discarding).extensions[0]!.integrity, installed.artifactIntegrity);
    assert.deepEqual(f.runtime.supervisor.activeExtensions(), [installed.extensionId]);
  } finally { await f.close(); }
});

test('captured compiler input never resolves adjacent source or installs dependencies; cancellation drains its real builder', async () => {
  const f = await fixture();
  try {
    await f.write('return 1;'); await writeFile(join(f.root, 'outside.js'), 'export default 42');
    await writeFile(join(f.directory, 'host.js'), 'import value from "../outside.js"; export default { activate() { return value; } };');
    await assert.rejects(f.runtime.stageCapturedPackage(f.directory, source(), 0), /escapes its captured package/);
    assert.equal((await f.runtime.catalog.snapshot()).extensions.length, 0);
    await writeFile(join(f.directory, 'host.js'), 'import value from "missing-package"; export default { activate() { return value; } };');
    await assert.rejects(f.runtime.stageCapturedPackage(f.directory, source(), 0), /does not install/);
    const entered = deferred(), release = deferred(), controller = new AbortController(); let finished = false;
    const artifacts = new ExtensionArtifactStore({ dataDir: join(f.root, 'other-data'), varinVersion: '1.2.3',
      buildModule: async (_options, signal) => { entered.resolve(); await release.promise; assert.equal(signal?.aborted, true); return { metafile: undefined }; } });
    const preparing = artifacts.prepareCaptured(f.directory, source(), controller.signal).catch(error => error).finally(() => { finished = true; });
    await entered.promise; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.match(await readFile(join(f.directory, 'host.js'), 'utf8'), /missing-package/);
    release.resolve(); assert.ok(await preparing instanceof Error);
  } finally { await f.close(); }
});

test('captured compilation preserves package-local JSONC extends and aliases without ambient configuration or source mutation', async () => {
  const f = await fixture();
  try {
    await f.write('return 1;');
    await mkdir(join(f.directory, 'config'));
    await writeFile(join(f.directory, 'value.ts'), 'export default "captured-config-value";');
    await writeFile(join(f.directory, 'host.js'), 'import value from "@captured"; export default { activate() { return value; } };');
    const base = { compilerOptions: { baseUrl: '..', paths: { '@captured': ['value.ts'] } } };
    await writeFile(join(f.directory, 'config/base.json'), JSON.stringify(base));
    const dependency = join(f.directory, 'node_modules/@fixture/config'); await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/config', exports: { require: './config.json' } }));
    await writeFile(join(dependency, 'config.json'), '{ "compilerOptions": { "strict": true } }');
    const config = '// Captured author configuration\n{ "extends": ["./config/base", "@fixture/config"], }';
    await writeFile(join(f.directory, 'tsconfig.json'), config);
    const prepared = await f.runtime.packages.artifacts.prepareCaptured(f.directory, source());
    assert.match(await readFile(join(prepared.resolvedPath, 'runtime/host/module.cjs'), 'utf8'), /captured-config-value/);
    assert.equal(await readFile(join(f.directory, 'tsconfig.json'), 'utf8'), config);
    assert.equal(await readFile(join(prepared.resolvedPath, 'package/tsconfig.json'), 'utf8'), config);
    assert.doesNotMatch(await readFile(join(prepared.resolvedPath, 'artifact-index.json'), 'utf8'), /varin-tsconfig-/);
    await writeFile(join(f.directory, 'tsconfig.json'), '{ "extends": "../outside.json" }');
    await writeFile(join(f.root, 'outside.json'), JSON.stringify({ compilerOptions: { baseUrl: './capture', paths: { '@captured': ['value.ts'] } } }));
    await assert.rejects(f.runtime.packages.artifacts.prepareCaptured(f.directory, source()), /tsconfig extends outside its captured package/);
    await rm(join(f.directory, 'tsconfig.json'));
    await writeFile(join(f.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: './capture', paths: { '@captured': ['value.ts'] } } }));
    await assert.rejects(f.runtime.packages.artifacts.prepareCaptured(f.directory, source()), /Could not resolve/);
  } finally { await f.close(); }
});
