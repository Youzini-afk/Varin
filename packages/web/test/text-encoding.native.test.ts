import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createWebDocumentsAPI } from '@varin/application-client';
import { DocumentRegistry } from '@varin/ui/lib/documents/registry';
import { createDocumentAuthority } from '#application-host/lib/documents/authority.js';
import { registerDocumentRoutes } from '#application-host/lib/documents/routes.js';
import { createAuthorityTestRuntime } from '#application-host/lib/kernel/authority.test-helper.js';
import { readSourceDrafts } from '#application-host/lib/harness/working-state/source-drafts.js';
import { planThreeWayPath } from '#application-host/lib/harness/working-state/three-way-merge.js';
import { captureStableSourceBaseline } from '#application-host/lib/harness/working-state/source-preparation.js';
import { createThreadResourceScope } from '#application-host/lib/kernel/thread-resource-scope.js';
import { scopeFixedSourceResources } from '#application-host/lib/kernel/scoped-source-resources.js';
import { createAdmittedDirectoryReader, createPinnedResourceReader } from '#application-host/lib/agent-resources/source-reader.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-text-encoding-'));
  const workspacePath = path.join(root, 'workspace'); await fs.mkdir(workspacePath);
  close.push(() => fs.rm(root, { recursive: true, force: true }));
  let override: string | undefined;
  let failRemember = false;
  const documents = createDocumentAuthority({ hostId: 'text-codec-native', dataDir: path.join(root, 'data'),
    resolveTextEncoding: async () => override ? { encoding: override } : {},
    rememberTextEncoding: async (_resource, encoding) => { if (failRemember) throw new Error('Settings temporarily unavailable'); override = encoding; } });
  close.push(() => documents.dispose());
  const native = await createAuthorityTestRuntime({ documents, hostId: 'text-codec-native', dataDir: path.join(root, 'data') });
  close.push(() => native.dispose());
  const workspace = await documents.resolveWorkspace({ path: workspacePath });
  // Runner temp paths can be aliases. Source capture uses the original Documents-admitted root.
  const { root: directory } = await documents.inspectWorkspace(workspace.workspaceId);
  const app = express(); app.use(express.json({ limit: '256mb' })); registerDocumentRoutes(app, { documents });
  let server!: Server;
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  close.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP address');
  const base = `http://127.0.0.1:${address.port}`;
  const api = createWebDocumentsAPI(async (url, init) => {
    const target = new URL(String(url), base);
    for (const [key, value] of Object.entries(init?.query ?? {})) if (value !== undefined) target.searchParams.set(key, String(value));
    return fetch(target, init as RequestInit);
  });
  const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'encoding-native' });
  close.push(() => registry.dispose());
  const resource = { workspaceId: workspace.workspaceId, resourceId: 'legacy.txt' };
  const token = { workspaceId: workspace.workspaceId, epoch: workspace.epoch, owner: { kind: 'test', id: 'native-text' } };
  return { documents, native, api, registry, directory, resource, token,
    setOverride: (value?: string) => { override = value; }, override: () => override,
    failRemember: (value: boolean) => { failRemember = value; } };
}

const gbkChinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文, fixed external byte fixture.

it('captures original GBK draft instructions and UTF-16 skills through resource readers and fixed subtree capsules', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.directory, '.varin')); await fs.mkdir(path.join(f.directory, 'rules')); await fs.mkdir(path.join(f.directory, 'src'));
  await fs.writeFile(path.join(f.directory, '.varin/settings.json'), JSON.stringify({ resources: { skills: ['../../rules'] } }));
  await fs.writeFile(path.join(f.directory, 'AGENTS.md'), gbkChinese);
  await fs.writeFile(path.join(path.dirname(f.directory), 'AGENTS.md'), gbkChinese);
  const skill = '---\nname: review\ndescription: 中文\n---\n中文规则';
  await fs.writeFile(path.join(f.directory, 'rules/SKILL.md'), Buffer.from(skill, 'utf16le'));
  const resource = { ...f.resource, resourceId: 'AGENTS.md' };
  await f.registry.open(resource); f.registry.applyTransaction(resource, '中文草稿', { origin: 'native-resource-test' });
  const consumer = { kind: 'thread' as const, threadId: 'resource-thread', branchId: 'main' };
  const context = await f.registry.captureAgentInputContext(consumer, resource.workspaceId);
  const drafts = await readSourceDrafts({ documents: f.documents, consumer, context, workspaceId: resource.workspaceId });
  const policy = { root: f.directory, files: { 'rules/SKILL.md': 'utf-16le', 'AGENTS.md': 'gbk' } };
  const documents = { ...f.documents, resolveTextEncodingPolicy: async () => policy };
  const scope = createThreadResourceScope({ dataDirectory: path.join(f.directory, 'absent-user'), homeDir: path.join(f.directory, 'absent-home'),
    documents, workingStates: f.native.workingStates, projectTrusted: () => true, configuration: async () => ({ packages: [] }),
    validateLiveSource: async () => { throw new Error('No live source requested'); },
    withSourceRead: (input, consume) => f.native.adapter.withResourceRead(input, consume) });
  await f.native.workingStates.withBranchStore(resource.workspaceId, 'resource-codec-capture', async store => {
    const prepared = await captureStableSourceBaseline({ store, workspaceId: resource.workspaceId, captureWorkspaceId: resource.workspaceId,
      branchId: 'resource-source', directory: f.directory, captureScopes: [], content: { mode: 'fixed-draft-baseline' }, ...drafts },
    { documents, inspectInventory: async () => ({ kind: 'directory' }), prepareResources: scope.prepareSourceCapture });
    expect(prepared.provenance.resources?.ancestors.flatMap(item => item.capsule.files).some(file => file.content === '中文')).toBe(true);
    const pin = await store.pinBranch('resource-source', { revision: 0 });
    try {
      const reader = createPinnedResourceReader({ domainId: 'resource-source', store, pin, coverage: { kind: 'complete' }, textEncoding: prepared.provenance.textEncoding });
      const scoped = await scopeFixedSourceResources(store, { branchId: 'resource-source', revision: 0 }, prepared.provenance.resources!, 'src', new AbortController().signal, prepared.provenance.textEncoding);
      policy.files['AGENTS.md'] = 'utf-8'; policy.files['rules/SKILL.md'] = 'utf-8'; f.setOverride('utf-8');
      expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'ready', content: '中文草稿' });
      expect(await reader.read('rules/SKILL.md')).toMatchObject({ status: 'ready', content: skill });
      expect(scoped.ancestors.flatMap(item => item.capsule.files).some(file => file.content === '中文草稿')).toBe(true);
      const selected = scoped.configuredPaths[0]!.target;
      expect(selected.kind).toBe('capsule');
      if (selected.kind === 'capsule') expect(selected.capsule.files).toEqual(expect.arrayContaining([expect.objectContaining({ content: skill })]));
    } finally { await pin.release(); }
  });
  const assets = await createAdmittedDirectoryReader({ domainId: 'assets', viewId: 'fixed-policy', root: f.directory,
    textEncoding: { root: f.directory, files: { 'rules/SKILL.md': 'utf-16le' } } });
  expect(await assets.read('rules/SKILL.md')).toMatchObject({ status: 'ready', content: skill });
  expect(await fs.readFile(path.join(f.directory, 'AGENTS.md'))).toEqual(gbkChinese);
});

it('reads GBK through HTTP/Registry, saves original bytes, and conflicts after external binary replacement', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  await fs.writeFile(file, Buffer.concat([gbkChinese, Buffer.from('\r\nplain\r\n')]));
  const opened = await f.registry.open(f.resource);
  expect(opened).toMatchObject({ buffer: '中文\nplain\n', encoding: 'gbk', lineEnding: 'crlf' });
  f.setOverride('utf-8'); // A project change between read and write cannot reinterpret the baseline.
  f.registry.applyTransaction(f.resource, '中文\nedit\n', { origin: 'native-test' });
  const saved = await f.registry.save(f.resource);
  expect(saved.dirty).toBe(false);
  expect(await fs.readFile(file)).toEqual(Buffer.concat([gbkChinese, Buffer.from('\r\nedit\r\n')]));
  await fs.writeFile(file, Buffer.from([0, 1, 2, 3]));
  const result = await f.api.write({ resource: f.resource, token: f.token, content: 'overwrite', encoding: 'gbk', bom: false,
    sourceFormat: saved.baseFormat, expectedRevision: saved.baseRevision, operationId: 'external-binary-cas' });
  expect(result.status).toBe('conflict'); expect(await fs.readFile(file)).toEqual(Buffer.from([0, 1, 2, 3]));
});

it('preserves mixed EOL/no-op bytes and serializes immutable surface snapshots with their original format', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  const original = Buffer.concat([gbkChinese, Buffer.from('\r\na\nb\rfinal')]); await fs.writeFile(file, original);
  const opened = await f.registry.open(f.resource);
  const noOp = await f.api.write({ resource: f.resource, token: f.token, content: opened.buffer, encoding: opened.encoding, bom: opened.bom,
    sourceFormat: opened.baseFormat, expectedRevision: opened.baseRevision, operationId: 'no-op' });
  expect(noOp.status).toBe('written'); expect(await fs.readFile(file)).toEqual(original);
  // Preserve the real editor range. A whole-buffer replacement intentionally owns every delimiter.
  const edit = f.registry.applyEdits(f.resource, { expectedLocalEditRevision: opened.localEditRevision,
    edits: [{ from: opened.buffer.indexOf('final'), to: opened.buffer.length, insert: 'edited' }], origin: 'native-test' });
  expect(edit.status).toBe('applied');
  const consumer = { kind: 'thread' as const, threadId: 'encoding-thread', branchId: 'main' };
  const context = await f.registry.captureAgentInputContext(consumer, f.resource.workspaceId);
  expect(context.source).toBe('surface');
  const drafts = await readSourceDrafts({ documents: f.documents, consumer, context, workspaceId: f.resource.workspaceId });
  expect(drafts.editorDrafts[0]?.content).toEqual(Buffer.concat([gbkChinese, Buffer.from('\r\na\nb\redited')]));
  f.registry.setFormat(f.resource, { lineEnding: 'crlf' });
  const normalized = await f.registry.captureAgentInputContext(consumer, f.resource.workspaceId);
  await f.registry.save(f.resource);
  expect(await fs.readFile(file)).toEqual(Buffer.concat([gbkChinese, Buffer.from('\r\na\r\nb\r\nedited')]));
  const frozen = await readSourceDrafts({ documents: f.documents, consumer, context, workspaceId: f.resource.workspaceId });
  expect(frozen.editorDrafts[0]?.content).toEqual(drafts.editorDrafts[0]?.content);
  const converted = await readSourceDrafts({ documents: f.documents, consumer, context: normalized, workspaceId: f.resource.workspaceId });
  expect(converted.editorDrafts[0]?.content).toEqual(Buffer.concat([gbkChinese, Buffer.from('\r\na\r\nb\r\nedited')]));
});

it('journals unrepresentable Unicode, leaves GBK bytes intact, and recovers a conversion receipt without rewriting', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  await fs.writeFile(file, gbkChinese);
  f.setOverride('gbk');
  await f.registry.open(f.resource);
  f.registry.applyTransaction(f.resource, '中文🙂', { origin: 'native-test' });
  await expect(f.registry.save(f.resource)).rejects.toMatchObject({ reason: 'unrepresentable' });
  await f.registry.flushRecoveryJournals();
  expect(await fs.readFile(file)).toEqual(gbkChinese);
  const [summary] = await f.api.listRecoveryJournals({ workspaceId: f.resource.workspaceId });
  expect(await f.api.readRecoveryJournal(summary!.journalId)).toMatchObject({ status: 'ready', content: '中文🙂', encoding: 'gbk' });
  f.registry.setFormat(f.resource, { encoding: 'utf-8' });
  f.failRemember(true);
  await expect(f.registry.save(f.resource)).rejects.toMatchObject({ reason: 'reconciliation-pending' });
  const converted = await fs.readFile(file); expect(converted.toString('utf8')).toBe('中文🙂');
  const modified = (await fs.stat(file)).mtimeMs;
  f.failRemember(false);
  expect(await f.registry.save(f.resource)).toMatchObject({ dirty: false, encoding: 'utf-8' });
  expect(f.override()).toBe('utf-8'); expect((await fs.stat(file)).mtimeMs).toBe(modified);

});

it('reconciles a persisted conversion after a browser restart without overwriting a newer interpretation', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  await fs.writeFile(file, Buffer.from('plain')); f.setOverride('gbk');
  await f.registry.open(f.resource);
  f.registry.setFormat(f.resource, { encoding: 'utf-8' }); f.failRemember(true);
  await expect(f.registry.save(f.resource)).rejects.toMatchObject({ reason: 'reconciliation-pending' });
  await f.registry.dispose(); f.failRemember(false);
  const modified = (await fs.stat(file)).mtimeMs;
  const reopened = new DocumentRegistry({ documents: f.api, getGeneration: () => 1, recoverySessionId: 'encoding-native' });
  close.push(() => reopened.dispose());
  expect(await reopened.open(f.resource)).toMatchObject({ buffer: 'plain', dirty: false, encoding: 'utf-8' });
  expect((await fs.stat(file)).mtimeMs).toBe(modified);
  expect(f.override()).toBe('utf-8');
  await f.api.read(f.resource, { encoding: 'gbk', rememberEncoding: true });
  expect(f.override()).toBe('gbk');
  await f.api.read(f.resource); expect(f.override()).toBe('gbk');
});

it('does not reconcile an old conversion over a newer external raw revision', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  await fs.writeFile(file, gbkChinese); f.setOverride('gbk');
  await f.registry.open(f.resource); f.registry.setFormat(f.resource, { encoding: 'utf-8' });
  f.failRemember(true);
  await expect(f.registry.save(f.resource)).rejects.toMatchObject({ reason: 'reconciliation-pending' });
  await fs.writeFile(file, Buffer.from('external replacement')); f.failRemember(false);
  expect(await f.api.read(f.resource)).toMatchObject({ status: 'ready', content: 'external replacement', encoding: 'gbk' });
  expect(f.override()).toBe('gbk');
  expect(await f.registry.save(f.resource)).toMatchObject({ status: 'conflict', dirty: true });
  expect(await fs.readFile(file)).toEqual(Buffer.from('external replacement'));
  expect(f.override()).toBe('gbk');
});

it('preserves untouched mixed-EOL ranges through the real Documents write contract', async () => {
  const f = await fixture(); const file = path.join(f.directory, f.resource.resourceId);
  await fs.writeFile(file, Buffer.from('old\r\nkeep\nlast\r'));
  const opened = await f.api.read(f.resource);
  if (opened.status !== 'ready') throw new Error(opened.status);
  expect(await f.api.write({ resource: f.resource, token: f.token,
    content: 'NEW\nkeep\nLAST\n', encoding: opened.encoding, bom: opened.bom,
    sourceFormat: opened.format, expectedRevision: opened.revision, operationId: 'two-exact-edits',
    edits: [{ start: 0, end: 3, text: 'NEW' }, { start: 9, end: 13, text: 'LAST' }],
  })).toMatchObject({ status: 'written' });
  expect(await fs.readFile(file)).toEqual(Buffer.from('NEW\r\nkeep\nLAST\r'));
});

it('uses the native codec for GBK three-way merge and streams text bodies larger than one transport frame', async () => {
  const f = await fixture();
  const bytes = [Buffer.concat([gbkChinese, Buffer.from('\na\nb')]), Buffer.concat([gbkChinese, Buffer.from('\nparent\nb')]), Buffer.concat([gbkChinese, Buffer.from('\na\nchild')])];
  const state = (index: number) => ({ kind: 'regular-file' as const, objectHash: `fixture-${index}`, byteLength: bytes[index]!.length });
  const merge = await planThreeWayPath({ path: 'legacy.txt', baseState: state(0), parentState: state(1), childState: state(2),
    readContent: async value => value.kind === 'regular-file' ? bytes[Number(value.objectHash.slice(-1))]! : null });
  expect(merge).toMatchObject({ decision: 'merge-clean', mergedText: '中文\nparent\nchild', textFormat: { encoding: 'gbk' } });
  bytes[2] = Buffer.from('中文\na\nchild', 'utf8');
  const convertedChild = await planThreeWayPath({ path: 'legacy.txt', baseState: state(0), parentState: state(1), childState: state(2),
    interpretations: { base: { encoding: 'gbk' }, parent: { encoding: 'gbk' }, child: { encoding: 'utf-8' } },
    readContent: async value => value.kind === 'regular-file' ? bytes[Number(value.objectHash.slice(-1))]! : null });
  expect(convertedChild).toMatchObject({ decision: 'merge-clean', mergedText: '中文\nparent\nchild', textFormat: { encoding: 'gbk' } });
  const content = 'a'.repeat(17 * 1024 * 1024) + '中文';
  const encoded = await f.native.client.textSerialize({ content, targetFormat: { encoding: 'utf-8', bom: false } });
  if (encoded.kind !== 'serialized') throw new Error(encoded.message);
  const decoded = await f.native.client.textDecode({ bytesBase64: encoded.bytesBase64 });
  expect(decoded.kind).toBe('text'); if (decoded.kind === 'text') expect(decoded.content).toBe(content);
});
