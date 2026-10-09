import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import type { NativeLanguageQuery } from './protocol.generated.js';
import type { NativeLanguageResult } from './native-language-owner.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH;
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function complete(response: ServerResponse, output: unknown[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
}
function answer(response: ServerResponse) { complete(response, [{ id: 'answer', type: 'message', content: [{ type: 'output_text', text: 'complete' }] }]); }
function call(response: ServerResponse, name: string, args: Record<string, unknown>, serial: number) {
  complete(response, [{ id: `item-${serial}`, type: 'function_call', call_id: `call-${serial}`, name, arguments: JSON.stringify(args) }]);
}
function output(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
  return item ? JSON.parse(String(item.output)) as Record<string, unknown> : undefined;
}
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void) {
  if (!kernelPath) throw new Error('Independent language acceptance requires explicit VARIN_TEST_KERNEL_PATH');
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-language-review-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const kernel = createKernelClient({ hostId: 'language-review', storageRoot: path.join(root, 'storage'), buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  await kernel.start();
  const runtime = new NativeRuntimeClient(kernel);
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', bytes => chunks.push(Buffer.from(bytes)));
    request.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests.push(body); reply(body, response); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback fixture address missing');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const configuration = { providerFamily: 'openai-responses', model: 'local-language-fixture', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 };
  async function admit(id: string, tools: string[], scopes = [''], capabilities = ['storage.read', 'storage.write']) {
    const threadId = `${id}-thread`, branchId = `${id}-branch`;
    await runtime.createThread(threadId, branchId);
    const receipt = await runtime.submit({ key: `${id}-input`, threadId, branchId, expectedHead: null, input: { text: id }, configuration });
    const grant = await kernel.issueGrant({ grantId: `${id}-grant`, threadId, runId: receipt.run_id, owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities, pathScopes: scopes });
    const registered = await kernel.scoped(grant).fileRootRegister({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: workspace });
    const binding = { grantId: grant.grantId, runId: receipt.run_id, threadId, workspaceId: 'workspace', executionWorkspaceId: 'workspace', rootId: registered.rootId, sourceMode: 'live_root', liveRoot: { hostId: 'language-review', canonicalRoot: registered.canonicalRoot, rootId: registered.rootId }, enabledTools: tools };
    return { receipt, grant, binding, branchId, start: () => runtime.startRun(receipt.run_id, undefined, binding) };
  }
  return { root, workspace, kernel, runtime, requests, admit };
}

it('selected language capability with no Host owner reports unavailable, never a successful empty result', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  await fs.writeFile(path.join(f.workspace, 'source.ts'), 'const source = 1;\n');
  const run = await f.admit('unavailable-owner', ['language_definition']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[0]!.tools)).toContain('native_language_definition');
  expect(JSON.stringify(output(f.requests[1]!))).toMatch(/unavailable/);
  expect(output(f.requests[1]!)).not.toMatchObject({ content: { status: 'ready', locations: [] } });
  expect((await f.runtime.history(run.branchId)).some(item => item.source === 'tool')).toBe(true);
}, 20_000);

it.each(['fixed_branch', 'materialized'] as const)('refuses %s language source without pretending the dependency closure is pinned', async mode => {
  const f = await fixture((_body, response) => answer(response));
  await fs.writeFile(path.join(f.workspace, 'source.ts'), 'const source = 1;\n');
  const run = await f.admit(`source-${mode}`, ['language_definition']);
  const actor = f.kernel.scoped(run.grant);
  const bytes = Buffer.from('const source = 1;\n');
  const blob = await actor.putBlob(bytes, 'language-fixed-source');
  await actor.createBranch({ operationId: 'source-create', branchId: 'language-source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'source.ts', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const source = await actor.readBranch({ branchId: 'language-source' });
  const published = await actor.publishBranch({ operationId: 'source-publish', branchId: 'language-source', expectedRoot: source.root, expectedWriteRevision: source.writeRevision });
  const lineage = { branchId: 'language-source', revision: Number(published.revision) };
  const binding = { ...run.binding, sourceMode: mode, liveRoot: undefined, ...(mode === 'fixed_branch' ? { rootId: undefined, fileSource: lineage } : { materializedSource: lineage }) };
  await expect(f.runtime.startRun(run.receipt.run_id, undefined, binding)).rejects.toThrow(/language|live_root|dependency/i);
  expect(f.requests).toHaveLength(0);
  await f.runtime.cancelRun(run.receipt.run_id);
}, 20_000);

const revision = (text: string | Buffer) => `d1_${createHash('sha256').update(text).digest('base64url')}`;
const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });
const boundSource = (query: NativeLanguageQuery, value: string): NonNullable<NativeLanguageResult['source']> => ({ mode: 'live_root', workspaceId: query.workspaceId, executionWorkspaceId: query.executionWorkspaceId, liveRoot: query.liveRoot, resourceId: query.path, revision: value, view: 'agent', documentVersion: 1, generation: 1, dependencies: 'live' });
const omissions = () => ({ outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 });
const location = (resourceId: string, selectedRange = range(0, 0, 5)) => ({ resource: { workspaceId: 'workspace', resourceId }, range: selectedRange });

it('revalidates every returned resource under the Run grant and records each target revision without claiming a cross-file range revision', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_references', { path: 'allowed/source.ts', line: 0, character: 0 }, calls); else answer(response); });
  await fs.mkdir(path.join(f.workspace, 'allowed'));
  const sourceText = 'const source = 1;\r\n';
  const targetText = 'const target = "😀";\r\n';
  await fs.writeFile(path.join(f.workspace, 'allowed/source.ts'), sourceText);
  await fs.writeFile(path.join(f.workspace, 'allowed/target.ts'), targetText);
  await fs.writeFile(path.join(f.workspace, 'private.ts'), 'PRIVATE_UNAUTHORIZED_MARKER');
  const outside = path.join(f.root, 'outside.ts'); await fs.writeFile(outside, 'OUTSIDE_SYMLINK_MARKER');
  await fs.symlink(outside, path.join(f.workspace, 'allowed/escape.ts'));
  const outsideDirectory = path.join(f.root, 'outside-directory'); await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, 'private.ts'), 'OUTSIDE_PARENT_SYMLINK_MARKER');
  await fs.symlink(outsideDirectory, path.join(f.workspace, 'allowed/escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  let queries = 0;
  f.kernel.setNativeLanguageOwner(async query => {
    queries++;
    expect(query).toMatchObject({ method: 'references', path: 'allowed/source.ts', workspaceId: 'workspace' });
    return { status: 'ready', source: boundSource(query, revision(sourceText)), omissions: omissions(), items: [
      location('allowed/source.ts'), location('allowed/target.ts'), location('private.ts'),
      location('allowed/escape.ts'), location('allowed/escape-dir/private.ts'), location('../outside.ts'), location('allowed/missing.ts'),
      { ...location('allowed/source.ts'), resource: { workspaceId: 'another-workspace', resourceId: 'allowed/source.ts' } },
      location('allowed/target.ts', range(0, 0, 900)),
      location('allowed/target.ts', range(0, 7, 2)),
    ] };
  });
  const run = await f.admit('target-authority', ['language_references'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  expect(queries).toBe(1);
  const result = output(f.requests[1]!)!;
  expect(result).toMatchObject({ outcome: 'succeeded', content: { status: 'partial', omissions: { outOfScope: 4, stale: 2, unavailable: 2 } } });
  const content = result.content as { items: Array<Record<string, unknown>> };
  expect(content.items).toHaveLength(2);
  expect(content.items[0]).toMatchObject({ observedRevision: revision(sourceText), rangeRevision: revision(sourceText) });
  expect(content.items[1]).toMatchObject({ observedRevision: revision(targetText), rangeRevision: null });
  expect(revision(targetText)).not.toBe(revision(sourceText));
  expect(JSON.stringify(result)).not.toContain('PRIVATE_UNAUTHORIZED_MARKER');
  expect(JSON.stringify(result)).not.toContain('OUTSIDE_SYMLINK_MARKER');
  expect(JSON.stringify(result)).not.toContain('OUTSIDE_PARENT_SYMLINK_MARKER');
  // A symlink leaf is admitted but never opened as a language file (unavailable);
  // a symlink parent escaping the selected root is denied (outOfScope).
  const page = await f.runtime.historyPage({ branchId: run.branchId, limit: 20 });
  const durableTool = page.items.find(item => item.source === 'tool');
  expect(durableTool).toBeDefined();
  const restored = await f.runtime.historyItem(durableTool!);
  expect(restored.content).toMatchObject({ content: { kind: 'tool_result', result: { completion: { content: result.content } } } });
}, 20_000);

it('denies the queried input before dispatching to the Host language owner', async () => {
  let calls = 0, queries = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'private.ts', line: 0, character: 0 }, calls); else answer(response); });
  await fs.mkdir(path.join(f.workspace, 'allowed'));
  await fs.writeFile(path.join(f.workspace, 'private.ts'), 'const privateValue = 1;');
  f.kernel.setNativeLanguageOwner(async () => { queries++; return { status: 'ready', items: [], omissions: omissions() }; });
  const run = await f.admit('denied-input', ['language_definition'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  expect(queries).toBe(0);
  expect(output(f.requests[1]!)).not.toMatchObject({ outcome: 'succeeded' });
}, 20_000);

it('an input changed while answering is stale even when the Host mistakenly returns ready', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  const before = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'source.ts'), before);
  f.kernel.setNativeLanguageOwner(async query => {
    await fs.writeFile(path.join(f.workspace, 'source.ts'), 'const replacement = 2;');
    return { status: 'ready', source: boundSource(query, revision(before)), items: [location('source.ts')], omissions: omissions() };
  });
  const run = await f.admit('changed-input', ['language_definition']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  expect(output(f.requests[1]!)).toMatchObject({ content: { status: 'stale', items: [] } });
}, 20_000);

it('a ready reply missing the queried revision cannot manufacture verified ranges', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  await fs.writeFile(path.join(f.workspace, 'source.ts'), 'const source = 1;');
  f.kernel.setNativeLanguageOwner(async () => ({ status: 'ready', items: [location('source.ts')], omissions: omissions() }));
  const run = await f.admit('missing-revision', ['language_definition']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!)!;
  expect(result).not.toMatchObject({ content: { status: 'ready' } });
  expect(JSON.stringify(result)).not.toContain('rangeRevision');
}, 20_000);

it('a stalled language query leaves control, unrelated reads and another Run usable; cancel ignores its late reply', async () => {
  const f = await fixture((body, response) => {
    if (output(body)) { answer(response); return; }
    if (JSON.stringify(body.input).includes('slow-language')) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, 1);
    else call(response, 'native_file_read', { path: 'other.txt' }, 2);
  });
  const text = 'const source = 1;';
  await fs.writeFile(path.join(f.workspace, 'source.ts'), text);
  await fs.writeFile(path.join(f.workspace, 'other.txt'), 'UNRELATED_READ_FINISHED');
  let entered = false, cancelled = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.kernel.setNativeLanguageOwner(async (query, signal) => {
    entered = true;
    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    await gate;
    return { status: 'ready', source: boundSource(query, revision(text)), items: [location('source.ts')], omissions: omissions(), message: 'LATE_LANGUAGE_RESULT_MUST_NOT_COMMIT' };
  });
  const slow = await f.admit('slow-language', ['language_definition']); await slow.start();
  await expect.poll(() => entered).toBe(true);
  expect((await f.runtime.status()).epoch).toBeGreaterThan(0);
  expect((await f.runtime.run(slow.receipt.run_id)).state).not.toBe('completed');
  const fast = await f.admit('unrelated-read', ['file_read']); await fast.start();
  await expect.poll(async () => (await f.runtime.run(fast.receipt.run_id)).state, { timeout: 5000 }).toBe('completed');
  expect(JSON.stringify(f.requests)).toContain('UNRELATED_READ_FINISHED');
  await f.runtime.cancelRun(slow.receipt.run_id);
  await expect.poll(async () => (await f.runtime.run(slow.receipt.run_id)).state).toBe('cancelled');
  await expect.poll(() => cancelled).toBe(true);
  release();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(JSON.stringify(await f.runtime.history(slow.branchId))).not.toContain('LATE_LANGUAGE_RESULT_MUST_NOT_COMMIT');
  expect(JSON.stringify(f.requests)).not.toContain('LATE_LANGUAGE_RESULT_MUST_NOT_COMMIT');
  expect((await f.runtime.status()).epoch).toBeGreaterThan(0);
}, 20_000);

it('revoking the Run grant during a language wait prevents the answer from becoming file evidence', async () => {
  let calls = 0, entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  const text = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'source.ts'), text);
  f.kernel.setNativeLanguageOwner(async query => {
    entered = true; await gate;
    return { status: 'ready', source: boundSource(query, revision(text)), items: [location('source.ts')], omissions: omissions() };
  });
  const run = await f.admit('revoked-answer', ['language_definition']); await run.start();
  await expect.poll(() => entered).toBe(true);
  await f.kernel.revokeGrant(run.grant.grantId);
  release();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!)!;
  expect(result).toMatchObject({ outcome: 'failed' });
  expect(JSON.stringify(result)).not.toContain('observedRevision');
}, 20_000);

it.each(['utf8-bom', 'utf16le', 'utf16be', 'crlf'] as const)('checks raw %s bytes without granting unsupported encodings verified range evidence', async encoding => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_references', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  const text = 'const emoji = "😀";\r\n';
  let bytes = Buffer.from(text);
  if (encoding === 'utf8-bom') bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    const encoded = Buffer.from(text, 'utf16le');
    bytes = encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), encoded])
      : Buffer.concat([Buffer.from([0xfe, 0xff]), encoded.swap16()]);
  }
  await fs.writeFile(path.join(f.workspace, 'source.ts'), bytes);
  f.kernel.setNativeLanguageOwner(async query => ({ status: 'ready', source: boundSource(query, revision(bytes)), omissions: omissions(), items: [
    location('source.ts', range(0, 15, 17)),
    location('source.ts', range(0, 0, text.split('\r')[0]!.length + 1)),
  ] }));
  const run = await f.admit(`encoding-${encoding}`, ['language_references']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    // Even a faulty Host owner cannot turn a Documents-unsupported encoding into verified evidence.
    expect(output(f.requests[1]!)).toMatchObject({ outcome: 'failed', content: { status: 'unavailable' } });
    expect(JSON.stringify(output(f.requests[1]!))).not.toContain('observedRevision');
  } else {
    expect(output(f.requests[1]!)).toMatchObject({ outcome: 'succeeded', content: {
      status: 'partial', omissions: { stale: 1 },
      items: [{ range: range(0, 15, 17), observedRevision: revision(bytes), rangeRevision: revision(bytes) }],
    } });
  }
}, 20_000);

it.each(['pending', 'unavailable'] as const)('a %s Host reply cannot bypass resource admission with unverified items', async status => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_diagnostics', { path: 'source.ts' }, calls); else answer(response); });
  await fs.writeFile(path.join(f.workspace, 'source.ts'), 'const source = 1;');
  f.kernel.setNativeLanguageOwner(async () => ({ status, omissions: { ...omissions(), untrusted: { path: '../private.ts', secret: 'OMISSION_FIELD_MUST_NOT_ESCAPE' } }, items: [
    { ...location('../private.ts'), message: 'UNAUTHORIZED_ITEM_MUST_NOT_ESCAPE' },
  ] }));
  const run = await f.admit(`nonready-${status}`, ['language_diagnostics']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!)!;
  expect(JSON.stringify(result)).not.toContain('UNAUTHORIZED_ITEM_MUST_NOT_ESCAPE');
  expect(JSON.stringify(result)).not.toContain('OMISSION_FIELD_MUST_NOT_ESCAPE');
  expect(JSON.stringify(result)).not.toContain('../private.ts');
  expect(result).not.toMatchObject({ content: { status: 'ready' } });
}, 20_000);

it('unversioned diagnostic observations stay pending while all locations still undergo Run authorization and range validation', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_diagnostics', { path: 'allowed/source.ts' }, calls); else answer(response); });
  await fs.mkdir(path.join(f.workspace, 'allowed'));
  const text = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'allowed/source.ts'), text);
  await fs.writeFile(path.join(f.workspace, 'private.ts'), 'const privateValue = 1;');
  f.kernel.setNativeLanguageOwner(async query => ({ status: 'pending', diagnosticVerification: 'unversioned',
    source: boundSource(query, revision(text)), omissions: omissions(), items: [
      { ...location('allowed/source.ts'), message: 'Observed unversioned type error' },
      { ...location('private.ts'), message: 'PRIVATE_OBSERVATION_MUST_NOT_ESCAPE' },
      { ...location('allowed/source.ts', range(99, 0, 5)), message: 'INVALID_RANGE_MUST_NOT_ESCAPE' },
    ] }));
  const run = await f.admit('unversioned-observation', ['language_diagnostics'], ['allowed']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!)!;
  expect(result).toMatchObject({ content: { status: 'pending', diagnosticVerification: 'unversioned',
    omissions: { outOfScope: 1, stale: 1 },
    items: [{ message: 'Observed unversioned type error', observedRevision: revision(text), rangeRevision: null }],
  } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_OBSERVATION_MUST_NOT_ESCAPE');
  expect(JSON.stringify(result)).not.toContain('INVALID_RANGE_MUST_NOT_ESCAPE');
}, 20_000);

it('an empty unversioned diagnostic publication never becomes a verified clean file', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_diagnostics', { path: 'source.ts' }, calls); else answer(response); });
  const text = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'source.ts'), text);
  f.kernel.setNativeLanguageOwner(async query => ({ status: 'pending', diagnosticVerification: 'unversioned',
    source: boundSource(query, revision(text)), omissions: omissions(), items: [] }));
  const run = await f.admit('unversioned-empty', ['language_diagnostics']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  expect(output(f.requests[1]!)).toMatchObject({ content: { status: 'pending', diagnosticVerification: 'unversioned', items: [] } });
}, 20_000);

it.each([
  { path: 'leaf.ts', expected: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 1 } },
  { path: 'directory/private.ts', expected: { outOfScope: 1, unmappable: 0, stale: 0, unavailable: 0 } },
])('classifies $path according to the actual no-follow resource owner', async ({ path: target, expected }) => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  const text = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'source.ts'), text);
  const externalDirectory = path.join(f.root, 'external'); await fs.mkdir(externalDirectory);
  const externalFile = path.join(externalDirectory, 'private.ts'); await fs.writeFile(externalFile, 'DO_NOT_READ_EXTERNAL_BYTES');
  await fs.symlink(externalFile, path.join(f.workspace, 'leaf.ts'));
  await fs.symlink(externalDirectory, path.join(f.workspace, 'directory'), process.platform === 'win32' ? 'junction' : 'dir');
  f.kernel.setNativeLanguageOwner(async query => ({ status: 'ready', source: boundSource(query, revision(text)), omissions: omissions(), items: [location(target)] }));
  const run = await f.admit('symlink-classification', ['language_definition']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!);
  expect(result).toMatchObject({ content: { status: 'partial', items: [], omissions: expected } });
  expect(JSON.stringify(result)).not.toContain('DO_NOT_READ_EXTERNAL_BYTES');
  expect(JSON.stringify(result)).not.toContain(externalFile);
}, 20_000);


it('rejects object-valued provider identity instead of persisting nested unadmitted resources', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => { if (++calls === 1) call(response, 'native_language_definition', { path: 'source.ts', line: 0, character: 0 }, calls); else answer(response); });
  const text = 'const source = 1;'; await fs.writeFile(path.join(f.workspace, 'source.ts'), text);
  f.kernel.setNativeLanguageOwner(async query => ({ status: 'ready', omissions: omissions(), items: [location('source.ts')],
    source: { ...boundSource(query, revision(text)), providerId: { resource: '../private.ts', secret: 'PROVIDER_OBJECT_MUST_NOT_ESCAPE' } },
  } as unknown as NativeLanguageResult));
  const run = await f.admit('invalid-provider-identity', ['language_definition']); await run.start();
  await expect.poll(async () => (await f.runtime.run(run.receipt.run_id)).state).toBe('completed');
  const result = output(f.requests[1]!);
  expect(result).toMatchObject({ outcome: 'failed', content: { error: 'language_result_invalid' } });
  expect(JSON.stringify(result)).not.toContain('PROVIDER_OBJECT_MUST_NOT_ESCAPE');
  expect(JSON.stringify(result)).not.toContain('../private.ts');
}, 20_000);
