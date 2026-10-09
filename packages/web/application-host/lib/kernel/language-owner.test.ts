import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from '../lsp/supervisor.js';
import { createLanguageOwner } from './language-owner.js';
import { createControlledLanguagePeer, deferred, testRange } from './language.test-helper.js';

type Query = Parameters<ReturnType<typeof createLanguageOwner>>[0];
type Prepare = NonNullable<Parameters<typeof createLanguageSupervisor>[0]['prepareProvider']>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const zeroOmissions = { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 };

async function fixture(options: { capabilities?: Record<string, unknown>; prepare?: Prepare; provider?: boolean } = {}) {
  const documents = await createDocumentAuthorityHarness();
  const peer = createControlledLanguagePeer(options.capabilities);
  const spawn = vi.fn(() => peer.child);
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn,
    ...(options.prepare ? { prepareProvider: options.prepare } : {}) });
  cleanups.push(async () => { await supervisor.dispose(); await documents.cleanup(); });
  if (options.provider !== false) supervisor.registerProvider({ providerId: 'test-language',
    command: 'controlled-test-peer', languageIds: ['typescript'], source: 'builtin' });
  await fs.writeFile(path.join(documents.workspaceRoot, 'main.ts'), 'const value = 1;\n');
  const validateSource = vi.fn(async () => {});
  const owner = createLanguageOwner({ documents: documents.authority, supervisor, validateSource });
  const query = (overrides: Partial<Query> = {}): Query => ({ runId: 'run-a', threadId: 'thread-a',
    workspaceId: documents.identity.workspaceId, executionWorkspaceId: documents.identity.workspaceId,
    liveRoot: { hostId: '11111111-1111-4111-8111-111111111111', canonicalRoot: documents.workspaceRoot, rootId: 'live-test-root' },
    method: 'definition', path: 'main.ts', line: 0, character: 6, ...overrides });
  const invoke = (overrides: Partial<Query> = {}, signal = new AbortController().signal) => owner(query(overrides), signal);
  const uri = (file: string) => pathToFileURL(path.join(documents.workspaceRoot, file)).href;
  return { documents, peer, spawn, supervisor, validateSource, query, invoke, uri };
}

describe('live language owner', () => {
  it('remains lazy and reports a missing provider without manufacturing a successful zero', async () => {
    const f = await fixture({ provider: false });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.validateSource).not.toHaveBeenCalled();
    const result = await f.invoke();
    expect(result.status).not.toBe('ready');
    expect(result.items).toEqual([]);
    expect(f.validateSource).toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('uses saved CRLF text with zero-based UTF-16 positions and rejects out-of-bounds input', async () => {
    const f = await fixture();
    const first = 'const emoji = "😀"; const value = 1;';
    const second = 'console.log(value);';
    await fs.writeFile(path.join(f.documents.workspaceRoot, 'main.ts'), `${first}\r\n${second}\r\n`);
    const range = testRange(0, first.indexOf('value'), first.indexOf('value') + 5);
    f.peer.handlers.set('textDocument/definition', () => [{ uri: f.uri('main.ts'), range }]);
    const result = await f.invoke({ line: 1, character: second.indexOf('value') });
    expect(result).toMatchObject({ status: 'ready', omissions: zeroOmissions,
      source: { resourceId: 'main.ts', view: 'agent', dependencies: 'live' },
      items: [{ resource: f.documents.resource('main.ts'), targetSelectionRange: range }] });
    const sent = f.peer.requests('textDocument/definition')[0]!;
    expect(sent.params).toMatchObject({ position: { line: 1, character: second.indexOf('value') } });
    expect(f.peer.notifications('textDocument/didOpen')[0]!.params).toMatchObject({
      textDocument: { text: `${first}\r\n${second}\r\n` },
    });
    for (const position of [{ line: 99, character: 0 }, { line: 0, character: first.length + 1 },
      { line: -1, character: 0 }, { line: 0, character: 1.5 }]) {
      const invalid = await f.invoke(position);
      expect(invalid.status).not.toBe('ready');
      expect(invalid.items).toEqual([]);
    }
    expect(f.peer.requests('textDocument/definition')).toHaveLength(1);
  });

  it.each(['utf8-bom', 'utf16le', 'utf16be'] as const)('preserves the Documents encoding and raw-byte evidence contract for %s', async encoding => {
    const f = await fixture();
    const content = 'const emoji = "😀"; const value = 1;\r\n';
    const bytes = encoding === 'utf8-bom'
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)])
      : encoding === 'utf16le'
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
        : Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(content, 'utf16le').swap16()]);
    await fs.writeFile(path.join(f.documents.workspaceRoot, 'main.ts'), bytes);
    const revision = `d1_${createHash('sha256').update(bytes).digest('base64url')}`;
    if (encoding !== 'utf8-bom') {
      expect(await f.documents.authority.readSnapshot(f.documents.resource('main.ts'))).toMatchObject({ status: 'unsupported-encoding', revision });
      expect(await f.invoke({ character: content.indexOf('value') })).toMatchObject({ status: 'unavailable', items: [] });
      expect(f.spawn).not.toHaveBeenCalled();
      return;
    }
    const range = testRange(0, content.indexOf('value'), content.indexOf('value') + 5);
    f.peer.handlers.set('textDocument/definition', () => [{ uri: f.uri('main.ts'), range }]);
    expect(await f.invoke({ character: content.indexOf('value') })).toMatchObject({ status: 'ready',
      source: { revision }, items: [{ targetSelectionRange: range }] });
    expect(f.peer.notifications('textDocument/didOpen')[0]!.params).toMatchObject({ textDocument: { text: content } });
    expect(revision).not.toBe(`d1_${createHash('sha256').update(content).digest('base64url')}`);
  });

  it('distinguishes genuine zero from discarded locations and leaves ordinary supervisor output unchanged', async () => {
    const f = await fixture();
    const range = testRange(0, 6, 11);
    f.peer.handlers.set('textDocument/definition', () => []);
    expect(await f.invoke()).toMatchObject({ status: 'ready', items: [], omissions: zeroOmissions });
    f.peer.handlers.set('textDocument/definition', () => null);
    expect(await f.invoke()).toMatchObject({ status: 'ready', items: [], omissions: zeroOmissions });
    for (const invalid of [undefined, false, 0, '', 'not a location']) {
      f.peer.handlers.set('textDocument/definition', () => invalid);
      expect(await f.invoke()).toMatchObject({ status: 'partial', items: [],
        omissions: { ...zeroOmissions, unmappable: 1 } });
      f.peer.handlers.set('textDocument/references', () => invalid);
      expect(await f.invoke({ method: 'references' })).toMatchObject({ status: 'partial', items: [],
        omissions: { ...zeroOmissions, unmappable: 1 } });
    }
    const raw = [
      { uri: pathToFileURL(path.join(f.documents.root, 'external.ts')).href, range },
      { uri: 'https://example.invalid/main.ts', range },
      { uri: `${f.uri('main.ts')}?untrusted=1`, range },
      { uri: `${f.uri('main.ts')}#fragment`, range },
      { uri: `${f.uri('main.ts')}/%2foutside.ts`, range },
      { uri: f.uri('main.ts'), range: { start: { line: 0, character: 11 }, end: { line: 0, character: 6 } } },
      { uri: f.uri('main.ts'), range: { start: { line: 0, character: -1 }, end: { line: 0, character: 6 } } },
      {},
    ];
    f.peer.handlers.set('textDocument/definition', () => raw);
    const omitted = await f.invoke();
    expect(omitted.items).toEqual([]);
    expect(omitted.omissions.outOfScope + omitted.omissions.unmappable).toBe(raw.length);
    expect(omitted.omissions.outOfScope).toBeGreaterThan(0);
    expect(omitted.omissions.unmappable).toBeGreaterThan(0);
    expect(omitted.status).not.toBe('ready');
    const ordinary = await f.supervisor.definition({ resource: f.documents.resource('main.ts'),
      languageId: 'typescript', view: 'agent', position: { line: 0, character: 6 } });
    expect(ordinary).toHaveProperty('status', 'ready');
    expect(ordinary).not.toHaveProperty('omissions');
    expect(ordinary).not.toHaveProperty('mappingEvidence');
    // The strict path does not silently rewrite the existing permissive Pi mapping contract.
    expect(ordinary).toHaveProperty('value', expect.arrayContaining([
      expect.objectContaining({ resource: f.documents.resource('main.ts') }),
    ]));
  });

  it('preserves cross-file ranges without stamping them with the queried file revision', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.documents.workspaceRoot, 'target.ts'), 'export const target = 1;\n');
    const range = testRange(0, 13, 19);
    f.peer.handlers.set('textDocument/references', () => [{ uri: f.uri('target.ts'), range }]);
    const result = await f.invoke({ method: 'references' });
    expect(result).toMatchObject({ status: 'ready', omissions: zeroOmissions,
      items: [{ resource: f.documents.resource('target.ts'), range }] });
    expect(result.source).toMatchObject({ resourceId: 'main.ts', dependencies: 'live' });
    expect(result.items[0]).not.toHaveProperty('rangeRevision', result.source?.revision);
    expect(result.items[0]).not.toHaveProperty('revision', result.source?.revision);
  });

  it('rejects an input revision that changed while its server request was pending', async () => {
    const f = await fixture();
    f.peer.heldMethods.add('textDocument/definition');
    const pending = f.invoke();
    await vi.waitFor(() => expect(f.peer.requests('textDocument/definition')).toHaveLength(1));
    await fs.writeFile(path.join(f.documents.workspaceRoot, 'main.ts'), 'const changed = 2;\n');
    f.peer.reply(f.peer.requests('textDocument/definition')[0]!, [{ uri: f.uri('main.ts'), range: testRange(0, 6, 11) }]);
    const result = await pending;
    expect(result.status).toBe('stale');
    expect(result.items).toEqual([]);
  });

  it('shares preparation while cancellation releases only one waiting caller', async () => {
    const preparing = deferred<void>();
    const release = deferred<void>();
    let preparationSignal: AbortSignal | undefined;
    const prepare = vi.fn<Prepare>(async (_provider, _root, signal) => {
      preparationSignal = signal;
      preparing.resolve();
      await release.promise;
      return { command: 'controlled-test-peer', args: [] };
    });
    const f = await fixture({ prepare });
    const synchronization = vi.spyOn(f.supervisor, 'syncDocument');
    const cancelled = new AbortController();
    const one = f.invoke({}, cancelled.signal);
    const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    await preparing.promise;
    const two = f.invoke({ runId: 'run-b' });
    // Both document reads have joined the shared startup before the first waiter leaves.
    await vi.waitFor(() => expect(synchronization).toHaveBeenCalledTimes(2));
    cancelled.abort();
    release.resolve();
    await rejected;
    expect(await two).toMatchObject({ status: 'ready', items: [], omissions: zeroOmissions });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(preparationSignal?.aborted).toBe(false);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled feature request, ignores its late response, and retains the shared server', async () => {
    const f = await fixture();
    f.peer.heldMethods.add('textDocument/definition');
    const cancelled = new AbortController();
    const pending = f.invoke({}, cancelled.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.peer.requests('textDocument/definition')).toHaveLength(1));
    const first = f.peer.requests('textDocument/definition')[0]!;
    expect(await f.invoke({ method: 'references', runId: 'run-b' })).toMatchObject({ status: 'ready', items: [] });
    cancelled.abort();
    await rejected;
    expect(f.peer.notifications('$/cancelRequest')).toEqual([
      expect.objectContaining({ params: { id: first.id } }),
    ]);
    f.peer.reply(first, [{ uri: f.uri('main.ts'), range: testRange(0, 6, 11) }]);
    f.peer.heldMethods.delete('textDocument/definition');
    expect(await f.invoke()).toMatchObject({ status: 'ready', items: [], omissions: zeroOmissions });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.supervisor.getStatus(f.documents.identity.workspaceId, 'typescript', 'agent').status).toBe('ready');
  });

  it('keeps unversioned and stale push diagnostics pending until a current publication arrives', async () => {
    const f = await fixture({ capabilities: { diagnosticProvider: undefined } });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', items: [] });
    const open = f.peer.notifications('textDocument/didOpen')[0]!.params!.textDocument as { version: number };
    const diagnostic = { range: testRange(0, 6, 11), message: 'fixture type mismatch', severity: 1, code: 2322 };
    f.peer.notify('textDocument/publishDiagnostics', { uri: f.uri('main.ts'), diagnostics: [diagnostic] });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', diagnosticVerification: 'unversioned',
      items: [expect.objectContaining({ message: diagnostic.message, range: diagnostic.range, documentVersion: null })] });
    f.peer.notify('textDocument/publishDiagnostics', { uri: f.uri('main.ts'), version: open.version - 1, diagnostics: [] });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', diagnosticVerification: 'unversioned',
      items: [expect.objectContaining({ message: diagnostic.message })] });
    f.peer.notify('textDocument/publishDiagnostics', { uri: f.uri('main.ts'), version: open.version, diagnostics: [diagnostic] });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'ready',
      items: [expect.objectContaining({ message: 'fixture type mismatch', range: diagnostic.range })], omissions: zeroOmissions });
    f.peer.notify('textDocument/publishDiagnostics', { uri: f.uri('main.ts'), diagnostics: [] });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', diagnosticVerification: 'unversioned', items: [] });
  });

  it('distinguishes an empty current pull report from unchanged and malformed diagnostic results', async () => {
    const f = await fixture();
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'ready', items: [], omissions: zeroOmissions });
    f.peer.handlers.set('textDocument/diagnostic', () => ({ kind: 'unchanged', resultId: 'unknown-previous-result' }));
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', items: [] });
    f.peer.handlers.set('textDocument/diagnostic', () => ({ kind: 'full', items: [
      {}, { range: testRange(0, 6, 11) },
      { message: 'bad range', range: { start: { line: 0, character: 9 }, end: { line: 0, character: 2 } } },
    ] }));
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'partial', items: [],
      omissions: { ...zeroOmissions, unmappable: 3 } });
  });
});
