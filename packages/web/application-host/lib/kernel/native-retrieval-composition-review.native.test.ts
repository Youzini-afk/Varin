import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createNativeRetrievalComposition, type NativeRetrievalPipelineBinding } from './native-retrieval-composition.js';
import { createNativeRetrievalOwner } from './native-retrieval-owner.js';
import { createStructureSource } from '../structure/source.js';
import { createTreeSitterStructureProvider } from '../structure/tree-sitter-provider.js';
import { retrievalFixture, responseTool, responseDone, latestOutput, deferred } from './native-retrieval-review.test-helper.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const structuredKey = 'varin.builtin.retrieval-structured:host:varin.retrieval.plan@1';
const keywordKey = 'varin.builtin.retrieval-keyword:host:varin.retrieval.plan@1';
const once = (body: Record<string, unknown>, response: Parameters<typeof responseDone>[0]) => latestOutput(body) ? responseDone(response) : responseTool(response, 'native_code_retrieval', { question: 'retrievalNeedle' });
const sourceText = 'export function retrievalNeedle() {\n  return "COMPOSED_SOURCE_EVIDENCE";\n}\n';

async function fixture(holdStructure = false) {
  const f = await retrievalFixture(once); cleanups.push(f.dispose);
  await f.write('module.ts', sourceText);
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(f.documents.root, 'extensions'), varinVersion: '0.9.24', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  const actual = createStructureSource([createTreeSitterStructureProvider({ compute: f.compute, parseBudgetMs: 30_000 })]);
  const gate = deferred(); let entered = 0;
  const structure = { ...actual, outline: vi.fn(async (...args: Parameters<typeof actual.outline>) => { entered++; if (holdStructure) await gate.promise; return actual.outline(...args); }) };
  const composition = createNativeRetrievalComposition(extensions, { structure });
  const bindings: NativeRetrievalPipelineBinding[] = [];
  f.kernel.setNativeRetrievalOwner(createNativeRetrievalOwner({ documents: f.documents.authority, kernel: f.kernel, validateSource: f.liveSources.validate,
    preparePipeline: async (query, signal) => { const binding = await composition.prepare({ threadId: query.threadId, projectId: 'retrieval-project', workspaceId: f.documents.workspaceRoot }, signal); bindings.push(binding); return binding; } }));
  const route = async (providerKey: string, scope: { projectId?: string; sessionId?: string } = { projectId: 'retrieval-project' }) => extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey, scope, serviceId: 'varin.retrieval.plan', version: 1 } });
  return { ...f, extensions, structure, composition, bindings, route, gate, entered: () => entered };
}

it('installed builtin plan selection reaches actual retrieval and a project routing change selects keyword-only without changing the old result', async () => {
  const f = await fixture();
  const first = await f.admit('composition-structured', ['code_retrieval']); await first.start();
  await expect.poll(async () => (await f.runtime.run(first.receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(f.bindings[0]!.selection.providerKey).toBe(structuredKey);
  const firstHistory = await f.runtime.history(first.branchId); const outlineCalls = f.structure.outline.mock.calls.length; expect(outlineCalls).toBeGreaterThan(0);
  await f.route(keywordKey);
  const second = await f.admit('composition-keyword', ['code_retrieval']); await second.start();
  await expect.poll(async () => (await f.runtime.run(second.receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect(f.bindings[1]!.selection.providerKey).toBe(keywordKey);
  expect(f.structure.outline.mock.calls).toHaveLength(outlineCalls);
  expect(await f.runtime.history(first.branchId)).toEqual(firstHistory);
  const secondHistory = JSON.stringify(await f.runtime.history(second.branchId));
  expect(secondHistory).toContain('COMPOSED_SOURCE_EVIDENCE');
  expect(secondHistory).toContain(keywordKey);
  expect(secondHistory).toContain(f.bindings[1]!.selection.artifactId);
  expect(JSON.stringify(firstHistory)).toContain(structuredKey);
  expect(f.bindings[1]!.plan.stages.find(stage => stage.kind === 'structure')?.status).toBe('disabled');
  expect(f.bindings[1]!.plan.id).not.toBe(f.bindings[0]!.plan.id);
  const unrelated = await f.composition.prepare({ threadId: 'different-project-thread', projectId: 'different-project', workspaceId: f.documents.workspaceRoot });
  try { expect(unrelated.selection.providerKey).toBe(structuredKey); } finally { unrelated.release(); }
}, 30_000);

it('a slow old query keeps its real selected service pin while another project selection and a failed declaration do not rewrite it', async () => {
  const f = await fixture(true);
  const old = await f.admit('composition-held-old', ['code_retrieval']);
  try {
    await old.start(); await expect.poll(f.entered, { timeout: 10_000 }).toBeGreaterThan(0);
    const original = f.bindings[0]!;
    await f.route(keywordKey);
    const next = await f.admit('composition-new-selection', ['code_retrieval']); await next.start();
    await expect.poll(async () => (await f.runtime.run(next.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(() => original.assertAvailable()).not.toThrow();
    const bad = await installLocal(f, 'review.retrieval-bad', '1.0.0', "throw new Error('deliberate retrieval declaration failure')");
    await f.route(`${bad.id}:host:varin.retrieval.plan@1`);
    await expect(f.composition.prepare({ threadId: old.binding.threadId, projectId: 'retrieval-project', workspaceId: f.documents.workspaceRoot })).rejects.toThrow(/deliberate retrieval declaration failure/);
    expect(() => original.assertAvailable()).not.toThrow();
    const failed = await f.admit('composition-explicit-failure', ['code_retrieval']); await failed.start();
    await expect.poll(async () => (await f.runtime.run(failed.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(JSON.stringify(await f.runtime.history(failed.branchId))).not.toContain('COMPOSED_SOURCE_EVIDENCE');
    await f.route(structuredKey);
    const retained = await f.composition.prepare({ threadId: old.binding.threadId, projectId: 'retrieval-project', workspaceId: f.documents.workspaceRoot });
    try { expect(retained.plan.id).toBe(original.plan.id); } finally { retained.release(); }
    f.gate.resolve(); await expect.poll(async () => (await f.runtime.run(old.receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
    expect(JSON.stringify(await f.runtime.history(old.branchId))).toContain(original.plan.id);
    expect(JSON.stringify(await f.runtime.history(old.branchId))).toContain('COMPOSED_SOURCE_EVIDENCE');
  } finally { f.gate.resolve(); }
}, 40_000);

it('explicit service disable revokes a held query rather than treating it like ordinary generation retirement', async () => {
  const f = await fixture(true); const run = await f.admit('composition-revoked', ['code_retrieval']);
  try {
    await run.start(); await expect.poll(f.entered, { timeout: 10_000 }).toBeGreaterThan(0);
    const binding = f.bindings[0]!;
    await f.extensions.setEnabled('varin.builtin.retrieval-structured', false, (await f.extensions.state()).catalog.revision);
    expect(() => binding.assertAvailable()).toThrow();
    f.gate.resolve(); await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(JSON.stringify(await f.runtime.history(run.branchId))).not.toContain('COMPOSED_SOURCE_EVIDENCE');
    const outputs = f.requests.map(latestOutput).filter(Boolean);
    expect(outputs.at(-1)).toMatchObject({ outcome: 'failed' });
  } finally { f.gate.resolve(); }
}, 30_000);

async function installLocal(f: Awaited<ReturnType<typeof fixture>>, id: string, version: string, describeBody: string) {
  const folder = path.join(f.documents.root, id); await fs.mkdir(folder, { recursive: true });
  await writeLocal(folder, id, version, describeBody);
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision,
    source: { kind: 'local', display: 'Independent retrieval declaration fixture', specifier: folder } });
  return { id, folder };
}
async function writeLocal(folder: string, id: string, version: string, describeBody: string, failActivation = false) {
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version }));
  await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version, engines: { varin: '*' },
    entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
    provides: { services: [{ id: 'varin.retrieval.plan', version: 1, multiple: true }] } }));
  await fs.writeFile(path.join(folder, 'host.cjs'), failActivation ? "module.exports={activate(){throw new Error('candidate activation failed')}}"
    : `module.exports={activate(context){context.services.provide({id:'varin.retrieval.plan',version:1,multiple:true},{describe(){${describeBody}}})}}`);
}

it('a real local extension candidate publishes a new callable generation while a failed candidate preserves the previous selected artifact', async () => {
  const f = await fixture();
  const local = await installLocal(f, 'review.retrieval-candidate', '1.0.0', "return {configurationId:'one',structure:'native'}");
  await f.route(`${local.id}:host:varin.retrieval.plan@1`);
  const scope = { threadId: 'candidate-review-thread', projectId: 'retrieval-project', workspaceId: f.documents.workspaceRoot };
  const first = await f.composition.prepare(scope);
  try {
    await writeLocal(local.folder, local.id, '2.0.0', "return {configurationId:'two',structure:'disabled'}");
    const changed = await f.extensions.reloadLocalSource({ extensionId: local.id, expectedRevision: (await f.extensions.state()).catalog.revision });
    const candidate = changed.snapshot.extensions.find(entry => entry.manifest.id === local.id)!.candidate!;
    await f.extensions.requestCandidateApplication({ extensionId: local.id, candidateIntegrity: candidate.integrity, expectedRevision: changed.snapshot.revision });
    await f.extensions.prepareCandidate(local.id, candidate.integrity);
    const selecting = f.extensions.selectCandidate({ extensionId: local.id, candidateIntegrity: candidate.integrity, expectedRevision: (await f.extensions.state()).catalog.revision });
    void selecting.catch(() => {});
    await expect.poll(() => f.extensions.services.getSnapshot().providers.some(provider => provider.providerKey === `${local.id}:host:varin.retrieval.plan@1` && provider.providerId !== first.selection.providerId && provider.status === 'active'), { timeout: 10_000 }).toBe(true);
    // Publication is observable before selectCandidate resolves retirement of the old pinned worker.
    const second = await f.composition.prepare(scope);
    try {
      expect(second.selection.artifactId).not.toBe(first.selection.artifactId);
      expect(second.selection.configurationId).toBe('two'); expect(first.selection.configurationId).toBe('one');
      expect(second.plan.configurationGeneration).toBe(first.plan.configurationGeneration + 1);
      expect(() => first.assertAvailable()).not.toThrow();
      expect((await f.runtime.status()).epoch).toBeGreaterThan(0);
      first.release(); await selecting;
      expect(f.extensions.services.getSnapshot().providers.some(provider => provider.providerId === first.selection.providerId)).toBe(false);
      await writeLocal(local.folder, local.id, '3.0.0', '', true);
      const failed = await f.extensions.reloadLocalSource({ extensionId: local.id, expectedRevision: (await f.extensions.state()).catalog.revision });
      const failedCandidate = failed.snapshot.extensions.find(entry => entry.manifest.id === local.id)!.candidate!;
      await f.extensions.requestCandidateApplication({ extensionId: local.id, candidateIntegrity: failedCandidate.integrity, expectedRevision: failed.snapshot.revision });
      await expect(f.extensions.prepareCandidate(local.id, failedCandidate.integrity)).rejects.toThrow(/candidate activation failed/);
      const retained = await f.composition.prepare(scope);
      try { expect(retained.plan.id).toBe(second.plan.id); expect(retained.selection.artifactId).toBe(second.selection.artifactId); } finally { retained.release(); }
    } finally { second.release(); }
  } finally { first.release(); }
}, 40_000);

it('retrieval routing uses the accepted Run project even when the visible project changes before the tool dispatches', async () => {
  let heldResponse!: Parameters<typeof responseDone>[0]; let requests = 0;
  const f = await retrievalFixture((body, response) => { requests++; if (!latestOutput(body)) heldResponse = response; else responseDone(response); }); cleanups.push(f.dispose);
  await f.write('module.ts', sourceText);
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(f.documents.root, 'extensions'), varinVersion: '0.9.24', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  const structure = createStructureSource([createTreeSitterStructureProvider({ compute: f.compute, parseBudgetMs: 30_000 })]);
  const outline = vi.spyOn(structure, 'outline');
  const composition = createNativeRetrievalComposition(extensions, { structure });
  for (const [projectId, providerKey] of [['accepted-project', keywordKey], ['visible-project', structuredKey]]) await extensions.upsertServiceRoutingRule({
    expectedRevision: (await extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey: providerKey!, scope: { projectId: projectId! }, serviceId: 'varin.retrieval.plan', version: 1 },
  });
  const observedProjects: Array<string | null> = [];
  let visibleProject = 'accepted-project';
  f.kernel.setNativeRetrievalOwner(createNativeRetrievalOwner({ documents: f.documents.authority, kernel: f.kernel, validateSource: f.liveSources.validate,
    preparePipeline: async (query, signal) => { observedProjects.push(query.projectId); return composition.prepare({ threadId: query.threadId,
      ...(query.projectId ? { projectId: query.projectId } : {}), workspaceId: query.liveRoot.canonicalRoot }, signal); } }));
  const run = await f.admit('frozen-project', ['code_retrieval'], [''], ['storage.read', 'storage.write'], {
    effectiveSystemPrompt: 'Project identity fixture', instructionSources: ['review:project-source'], memoryCheckpoint: null,
    personalization: { mode: 'agent', threadRole: 'main', revision: 0, sessionId: 'frozen-project-thread', projectId: visibleProject,
      originalSections: [{ name: 'preamble', content: 'Project identity fixture' }], instructionSources: ['review:project-source'] },
  });
  await run.start(); await expect.poll(() => requests, { timeout: 10_000 }).toBe(1);
  visibleProject = 'visible-project';
  responseTool(heldResponse, 'native_code_retrieval', { question: 'retrievalNeedle' });
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(observedProjects).toEqual(['accepted-project']); expect(visibleProject).toBe('visible-project'); expect(outline).not.toHaveBeenCalled();
  expect(JSON.stringify(await f.runtime.history(run.branchId))).toContain(keywordKey);
}, 30_000);
