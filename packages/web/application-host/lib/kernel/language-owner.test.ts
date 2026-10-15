import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from '../lsp/supervisor.js';
import type { SourceQueryAccess } from './source-query.js';
import { createLanguageOwner } from './language-owner.js';
import { createControlledLanguagePeer, deferred, testRange } from './language.test-helper.js';

type Query = Parameters<ReturnType<typeof createLanguageOwner>>[0];
type Prepare = NonNullable<Parameters<typeof createLanguageSupervisor>[0]['prepareProvider']>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const zeroOmissions = { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 };

async function fixture(options: { capabilities?: Record<string, unknown>; prepare?: Prepare; provider?: boolean; afterRead?: () => Promise<void> } = {}) {
  const documents = await createDocumentAuthorityHarness();
  const peer = createControlledLanguagePeer(options.capabilities);
  const spawn = vi.fn((_command?: string) => peer.child);
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn, spawnAdmitted: async (admit, command, _args, options) => { await admit(options.signal ?? new AbortController().signal); return spawn(command); },
    ...(options.prepare ? { prepareProvider: options.prepare } : {}) });
  cleanups.push(async () => { await supervisor.dispose(); await documents.cleanup(); });
  if (options.provider !== false) supervisor.registerProvider({ providerId: 'test-language',
    command: 'controlled-test-peer', languageIds: ['typescript'], source: 'builtin' });
  await fs.writeFile(path.join(documents.workspaceRoot, 'main.ts'), 'const value = 1;\n');
  const validateSource = vi.fn(async (_query?: Pick<SourceQueryAccess, 'grantId'>) => {});
  const owner = createLanguageOwner({ documents: documents.authority, supervisor, sources: {
    validateLanguage: validateSource,
    prepareLanguageView: async query => ({ root: query.physicalRoot!.canonicalRoot, check: async () => {}, release: async () => {} }),
    dispose: async () => {},
    read: async (query, resourceId, signal) => {
      const snapshot = await documents.authority.readSnapshot({ workspaceId: query.source.workspace_id, resourceId }, { signal });
      await options.afterRead?.();
      return snapshot.status === 'ready' ? { status: 'ready', content: snapshot.content, revision: snapshot.revision, source: 'disk' }
        : { status: 'unavailable', message: snapshot.status };
    },
    processAdmission: query => async signal => { signal.throwIfAborted(); await validateSource(); return {
      workspaceId: query.source.workspace_id, executionWorkspaceId: query.source.execution_workspace_id, canonicalRoot: query.physicalRoot!.canonicalRoot }; },
  } });
  const liveRoot = { hostId: '11111111-1111-4111-8111-111111111111', canonicalRoot: documents.workspaceRoot, rootId: 'live-test-root' };
  const query = (overrides: Partial<Query> = {}): Query => ({ runId: 'run-a', threadId: 'thread-a',
    grantId: 'grant-a', source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: documents.identity.workspaceId, execution_workspace_id: documents.identity.workspaceId, branch_id: null, revision: null, live_root: liveRoot }, physicalRoot: liveRoot,
    method: 'definition', path: 'main.ts',
    ...(!overrides.method || ['definition', 'references', 'hover', 'call_hierarchy'].includes(overrides.method) ? { line: 0, character: 6 } : {}), ...overrides });
  const invoke = (overrides: Partial<Query> = {}, signal = new AbortController().signal) => owner(query(overrides), signal);
  const uri = (file: string) => pathToFileURL(path.join(documents.workspaceRoot, file)).href;
  return { documents, peer, spawn, supervisor, owner, validateSource, query, invoke, uri };
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
      source: { resourceId: 'main.ts', view: expect.stringMatching(/^agent:source:/), dependencies: { source: 'live', external: 'provider_environment' } },
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
    expect(result.source).toMatchObject({ resourceId: 'main.ts', dependencies: { source: 'live', external: 'provider_environment' } });
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
    expect(f.supervisor.inspectViews()).toEqual(expect.arrayContaining([expect.objectContaining({ view: expect.stringMatching(/^agent:source:/), status: 'ready' })]));
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

it('retains one source server across Runs and waits for actual exit after the final source reference leaves', async () => {
  const f = await fixture();
  const first = await f.invoke();
  expect(first.status).toBe('ready');
  expect(await f.invoke({ runId: 'run-b', grantId: 'grant-b' })).toMatchObject({ status: 'ready', source: { view: first.source!.view } });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await f.owner.releaseSource!({ grantId: 'grant-a' });
  expect(f.peer.child.killed).toBe(false);
  expect(await f.invoke({ runId: 'run-b', grantId: 'grant-b' })).toMatchObject({ status: 'ready' });
  const requested = deferred<void>();
  Object.assign(f.peer.child, { requestTermination: vi.fn(async () => { requested.resolve(); }) });
  let finished = false;
  const release = f.owner.releaseSource!({ runId: 'run-b' }).then(() => { finished = true; });
  await requested.promise;
  let previousRunSettled = false;
  const previousRun = f.owner.releaseSource!({ runId: 'run-a' }).then(() => { previousRunSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(previousRunSettled).toBe(false);
  expect(finished).toBe(false);
  expect(f.supervisor.inspectViews()).toEqual([expect.objectContaining({ status: 'degraded', view: first.source!.view })]);
  const cancelled = new AbortController();
  const next = f.invoke({ runId: 'run-c', grantId: 'grant-c' }, cancelled.signal);
  const stopped = expect(next).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  cancelled.abort(); await stopped;
  f.peer.child.kill(); await Promise.all([release, previousRun]);
  expect(previousRunSettled).toBe(true);
  expect(finished).toBe(true);
  expect(f.supervisor.inspectViews()).toEqual([]);
});

it('revalidates the original source after provider preparation before spawning', async () => {
  const prepared = deferred<void>(), release = deferred<void>();
  const f = await fixture({ prepare: async () => { prepared.resolve(); await release.promise; return null; } });
  const query = f.invoke();
  await prepared.promise;
  f.validateSource.mockRejectedValue(new Error('Original source authority withdrawn'));
  release.resolve();
  expect(await query).toMatchObject({ status: 'unavailable', message: expect.stringMatching(/authority withdrawn/) });
  expect(f.spawn).not.toHaveBeenCalled();
});

it('keeps explicitly retained native source views out of the legacy idle reaper', async () => {
  const documents = await createDocumentAuthorityHarness();
  const peer = createControlledLanguagePeer();
  let at = 0;
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn: () => peer.child,
    spawnAdmitted: async (admit, _command, _args, options) => { await admit(options.signal!); return peer.child; }, now: () => at, hostViewIdleMs: 10 });
  cleanups.push(async () => { await supervisor.dispose(); await documents.cleanup(); });
  supervisor.registerProvider({ providerId: 'retained', command: 'test', languageIds: ['typescript'] });
  const workspaceId = documents.identity.workspaceId, view = 'agent:source:explicit' as const;
  await supervisor.retainSourceView({ workspaceId, view, root: documents.workspaceRoot, runId: 'run', grantId: 'grant',
    admitProcess: async () => ({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: documents.workspaceRoot }),
    read: async () => ({ status: 'ready', content: 'const x = 1;', revision: 'revision' }) }, new AbortController().signal);
  expect(await supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'a.ts' }, languageId: 'typescript', content: 'const x = 1;', contentRevision: 'revision' })).toMatchObject({ status: 'synced' });
  at = 1_000_000;
  await supervisor.releaseIdleHostViews();
  expect(peer.child.killed).toBe(false);
  await supervisor.releaseSourceViews({ runId: 'run' });
  expect(peer.child.killed).toBe(true);
});


it('does not retire a retained Run source when its only cold-start query is cancelled', async () => {
  const preparing = deferred<void>(), release = deferred<void>();
  let startup: AbortSignal | undefined;
  const f = await fixture({ prepare: async (_provider, _root, signal) => {
    startup = signal; preparing.resolve(); await release.promise; return null;
  } });
  const caller = new AbortController();
  const pending = f.invoke({}, caller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await preparing.promise;
  caller.abort(); await cancelled;
  expect(startup?.aborted).toBe(false);
  const next = f.invoke();
  release.resolve();
  expect(await next).toMatchObject({ status: 'ready' });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await f.owner.releaseSource!({ runId: 'run-a' });
  expect(f.peer.child.killed).toBe(true);
});

it('drains a superseded cold provider startup before the same source can launch its replacement', async () => {
  const preparing = deferred<void>(), release = deferred<void>();
  let count = 0;
  let oldSignal: AbortSignal | undefined;
  const f = await fixture({ prepare: async (_provider, _root, signal) => {
    if (++count === 1) { oldSignal = signal; preparing.resolve(); await release.promise; }
    return null;
  } });
  const old = f.invoke();
  await preparing.promise;
  f.supervisor.registerProvider({ providerId: 'test-language', command: 'replacement-test-peer', languageIds: ['typescript'], source: 'builtin' });
  expect(oldSignal?.aborted).toBe(true);
  const replacement = f.invoke({ runId: 'run-b', grantId: 'grant-b' });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.spawn).not.toHaveBeenCalled();
  release.resolve();
  expect(await old).toMatchObject({ status: 'unavailable' });
  const result = await replacement;
  expect(result.status).toBe('ready');
  expect(result.source!.generation).toBeGreaterThan(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(count).toBe(2);
});


it('rebuilds the same source watcher after failed startup and invalidates changed dependency diagnostics', async () => {
  let root = '', moved = '', move = true;
  const f = await fixture({ capabilities: { diagnosticProvider: undefined }, afterRead: async () => {
    if (move) { move = false; await fs.rename(root, moved); }
  } });
  root = f.documents.workspaceRoot; moved = `${root}-temporarily-moved`;
  f.validateSource.mockImplementation(async () => { await fs.stat(root); });
  await fs.writeFile(path.join(root, 'dep.ts'), 'export const value = 1;\n');
  try {
    expect(await f.invoke()).toMatchObject({ status: 'unavailable' });
    await fs.rename(moved, root);
    const main = await f.invoke();
    expect(main.status).toBe('ready');
    const dependency = await f.invoke({ path: 'dep.ts' });
    expect(dependency).toMatchObject({ status: 'ready' });
    f.peer.notify('textDocument/publishDiagnostics', { uri: f.uri('main.ts'), version: main.source!.documentVersion,
      diagnostics: [{ range: testRange(0, 6, 11), message: 'old dependency diagnostic' }] });
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'ready' });
    await fs.writeFile(path.join(root, 'dep.ts'), 'export const value = "changed";\n');
    await vi.waitFor(() => expect(f.peer.notifications('textDocument/didClose'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ params: { textDocument: { uri: f.uri('dep.ts') } } })])));
    expect(f.peer.notifications('textDocument/didChange')).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: {
        textDocument: { uri: f.uri('dep.ts'), version: dependency.source!.documentVersion + 1 },
        contentChanges: [{ text: 'export const value = "changed";\n' }],
      } }),
    ]));
    expect(f.peer.frames.filter(frame => (frame.params?.textDocument as { uri?: string } | undefined)?.uri === f.uri('dep.ts'))
      .map(frame => frame.method).slice(-2)).toEqual(['textDocument/didChange', 'textDocument/didClose']);
    expect(await f.invoke({ method: 'diagnostics' })).toMatchObject({ status: 'pending', items: [] });
    expect(f.spawn).toHaveBeenCalledTimes(1);
  } finally { if (await fs.stat(moved).then(() => true, () => false)) await fs.rename(moved, root); }
});

it('does not make one source retirement wait for an unrelated draining view and preserves exact retries', async () => {
  const documents = await createDocumentAuthorityHarness();
  const a = createControlledLanguagePeer(), b = createControlledLanguagePeer();
  const rootA = path.join(documents.workspaceRoot, 'a'), rootB = path.join(documents.workspaceRoot, 'b');
  await fs.mkdir(rootA); await fs.mkdir(rootB);
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn: () => a.child,
    spawnAdmitted: async (admit, _command, _args, options) => { await admit(options.signal!); return options.cwd === rootA ? a.child : b.child; } });
  cleanups.push(async () => { a.child.kill(); await supervisor.dispose(); await documents.cleanup(); });
  supervisor.registerProvider({ providerId: 'independent', command: 'test', languageIds: ['typescript'] });
  const workspaceId = documents.identity.workspaceId;
  for (const [id, root] of [['a', rootA], ['b', rootB]]) {
    const view = `agent:source:${id}` as const;
    await supervisor.retainSourceView({ workspaceId, view, root: root!, runId: `run-${id}`, grantId: `grant-${id}`,
      admitProcess: async () => ({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: root! }),
      read: async () => ({ status: 'ready', content: 'const x = 1;', revision: 'revision' }) }, new AbortController().signal);
    expect(await supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'main.ts' }, languageId: 'typescript',
      content: 'const x = 1;', contentRevision: 'revision' })).toMatchObject({ status: 'synced' });
  }
  const requested = deferred<void>();
  Object.assign(a.child, { requestTermination: async () => { requested.resolve(); } });
  let aDone = false, retryDone = false;
  const releasingA = supervisor.releaseSourceViews({ runId: 'run-a' }).then(() => { aDone = true; });
  await requested.promise;
  const retryA = supervisor.releaseSourceViews({ grantId: 'grant-a' }).then(() => { retryDone = true; });
  await supervisor.releaseSourceViews({ runId: 'run-b' });
  expect(b.child.killed).toBe(true);
  expect(aDone).toBe(false); expect(retryDone).toBe(false);
  await supervisor.releaseSourceViews({ runId: 'run-b' });
  expect(aDone).toBe(false);
  a.child.kill(); await Promise.all([releasingA, retryA]);
  expect(aDone).toBe(true); expect(retryDone).toBe(true);
});

it('keeps the shared source watcher when cancelling a different language provider startup', async () => {
  const documents = await createDocumentAuthorityHarness();
  const root = documents.workspaceRoot, workspaceId = documents.identity.workspaceId;
  await fs.writeFile(path.join(root, 'main.py'), 'from dep import value\nvalue\n');
  await fs.writeFile(path.join(root, 'dep.py'), 'value = 1\n');
  const read = async (resourceId: string) => {
    const bytes = await fs.readFile(path.join(root, resourceId));
    return { status: 'ready', content: bytes.toString(), revision: `d1_${createHash('sha256').update(bytes).digest('base64url')}` };
  };
  const py = createControlledLanguagePeer(), ts = createControlledLanguagePeer();
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn: () => py.child,
    spawnAdmitted: async (admit, command, _args, options) => { await admit(options.signal!); return command === 'python-peer' ? py.child : ts.child; } });
  cleanups.push(async () => { await supervisor.dispose(); await documents.cleanup(); });
  supervisor.registerProvider({ providerId: 'python-provider', command: 'python-peer', languageIds: ['python'] });
  supervisor.registerProvider({ providerId: 'ts-provider', command: 'ts-peer', languageIds: ['typescript'] });
  const held = deferred<void>();
  let holdNext = false;
  const view = 'agent:source:shared-root' as const;
  await supervisor.retainSourceView({ workspaceId, view, root, runId: 'run', grantId: 'grant', read,
    admitProcess: async signal => {
      if (holdNext) {
        holdNext = false; held.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      signal.throwIfAborted();
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: root };
    } }, new AbortController().signal);
  const main = await read('main.py'), dep = await read('dep.py');
  const bound = await supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'main.py' }, languageId: 'python',
    content: main.content, contentRevision: main.revision });
  if (!('viewRevision' in bound)) throw new Error('Python source binding did not complete');
  await supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'dep.py' }, languageId: 'python', content: dep.content, contentRevision: dep.revision });
  const answer = deferred<unknown>();
  py.handlers.set('textDocument/definition', () => answer.promise);
  const querying = supervisor.definition({ view, resource: { workspaceId, resourceId: 'main.py' }, languageId: 'python',
    expectedRevision: main.revision, expectedViewRevision: bound.viewRevision, generation: bound.generation,
    documentVersion: bound.documentVersion, position: { line: 1, character: 0 } });
  await vi.waitFor(() => expect(py.requests('textDocument/definition')).toHaveLength(1));
  holdNext = true;
  const starting = supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'main.ts' }, languageId: 'typescript', content: 'const x = 1;', contentRevision: 'r' });
  const cancelled = expect(starting).rejects.toBeDefined();
  await held.promise;
  supervisor.registerProvider({ providerId: 'ts-provider', command: 'ts-peer-updated', languageIds: ['typescript'] });
  await cancelled;
  await fs.writeFile(path.join(root, 'dep.py'), 'value = "changed dependency"\n');
  await vi.waitFor(() => expect(py.notifications('textDocument/didClose')).toHaveLength(1));
  answer.resolve([{ uri: pathToFileURL(path.join(root, 'dep.py')).href, range: testRange(0, 0, 5) }]);
  expect(await querying).toMatchObject({ status: 'stale' });
});

it('shares fixed-tree preparation after one waiter cancels and releases its physical handle only after actual exit', async () => {
  const documents = await createDocumentAuthorityHarness();
  const workspaceId = documents.identity.workspaceId;
  const entered = deferred<void>(), ready = deferred<void>();
  const peers: ReturnType<typeof createControlledLanguagePeer>[] = [];
  const prepared: string[] = [], released: string[] = [];
  let sharedSignal: AbortSignal | undefined;
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn: () => { throw new Error('Unadmitted spawn'); },
    spawnAdmitted: async (admit, _command, _args, options) => {
      const identity = await admit(options.signal!);
      expect(identity.canonicalRoot).toBe(options.cwd);
      const peer = createControlledLanguagePeer(); peers.push(peer); return peer.child;
    } });
  cleanups.push(async () => { for (const peer of peers) peer.child.kill(); await supervisor.dispose(); await documents.cleanup(); });
  supervisor.registerProvider({ providerId: 'fixed-provider', command: 'fixture', languageIds: ['typescript'] });
  const retired = new Set<string>();
  const validate = async (query: Query, signal: AbortSignal) => { signal.throwIfAborted(); if (retired.has(query.runId)) throw new Error('Original Run retired'); };
  const owner = createLanguageOwner({ documents: documents.authority, supervisor, sources: {
    validateLanguage: validate, dispose: async () => {},
    read: async () => ({ status: 'ready', content: 'const fixed = 1;\n', revision: 'fixed-original-revision', source: 'working-branch' }),
    prepareLanguageView: async (query, viewId, signal) => {
      await validate(query as Query, signal); sharedSignal = signal; entered.resolve(); await ready.promise; signal.throwIfAborted();
      const root = path.join(documents.workspaceRoot, viewId); await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.ts'), 'const fixed = 1;\n');
      prepared.push(viewId);
      return { root, derivedView: { viewId, branchId: 'fixed', revision: 0, sourceRoot: 'root', canonicalRoot: root, kernelEpoch: 'fixture-epoch' },
        check: async () => { await fs.stat(root); },
        release: async () => { expect(peers.every(peer => peer.child.killed)).toBe(true); released.push(viewId); await fs.rm(root, { recursive: true }); } };
    },
    processAdmission: (query, view) => async signal => { await validate(query as Query, signal); await view!.check(signal);
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: view!.root }; },
  } });
  const query = (runId: string): Query => ({ runId, threadId: runId, grantId: `grant:${runId}`, source: {
    resource_owner: { kind: 'local' }, mode: 'fixed_branch', workspace_id: workspaceId, execution_workspace_id: workspaceId, branch_id: 'fixed', revision: 0, live_root: null },
    physicalRoot: null, method: 'definition', path: 'main.ts', line: 0, character: 6 });
  const cancelled = new AbortController();
  const a = owner(query('a'), cancelled.signal);
  const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' }); await entered.promise;
  const b = owner(query('b'), new AbortController().signal); cancelled.abort(); await rejected;
  expect(sharedSignal!.aborted).toBe(false); ready.resolve();
  const result = await b;
  expect(result).toMatchObject({ status: 'ready', source: { physicalRoot: null,
    dependencies: { source: 'fixed_branch', external: 'provider_environment' }, derivedView: { viewId: prepared[0] } } });
  expect(prepared).toHaveLength(1); expect(peers).toHaveLength(1);
  retired.add('a'); await owner.releaseSource!({ runId: 'a' }); expect(released).toEqual([]);
  const stopRequested = deferred<void>();
  Object.assign(peers[0]!.child, { requestTermination: async () => { stopRequested.resolve(); } });
  retired.add('b'); const draining = owner.releaseSource!({ runId: 'b' }); await stopRequested.promise;
  expect(released).toEqual([]); expect(await fs.stat(result.source!.derivedView!.canonicalRoot)).toBeDefined();
  peers[0]!.child.kill(); await draining;
  expect(released).toEqual(prepared);
  expect(await fs.stat(result.source!.derivedView!.canonicalRoot).then(() => true, () => false)).toBe(false);
  const reopened = await owner(query('c'), new AbortController().signal);
  expect(reopened.status).toBe('ready'); expect(prepared).toHaveLength(2);
  expect(reopened.source!.derivedView!.viewId).not.toBe(result.source!.derivedView!.viewId);
  await owner.releaseSource!({ runId: 'c' });
});

it('retires a changed fixed dependency tree and creates a fresh generation only on a later query', async () => {
  const documents = await createDocumentAuthorityHarness(); const workspaceId = documents.identity.workspaceId;
  const peers: ReturnType<typeof createControlledLanguagePeer>[] = [];
  const releases: string[] = []; let preparations = 0;
  const supervisor = createLanguageSupervisor({ documents: documents.authority, spawn: () => { throw new Error('Unadmitted'); },
    spawnAdmitted: async (admit, _command, _args, options) => { await admit(options.signal!); const peer = createControlledLanguagePeer(); peers.push(peer); return peer.child; } });
  cleanups.push(async () => { await supervisor.dispose(); await documents.cleanup(); });
  supervisor.registerProvider({ providerId: 'fixed', command: 'fixture', languageIds: ['typescript'] });
  const view = 'agent:source:fixed-dependencies' as const;
  const binding = { view, workspaceId, root: '', runId: 'run', grantId: 'grant',
    read: async () => ({ status: 'ready', content: 'const x = 1;', revision: 'fixed-revision' }),
    prepare: async (viewId: string) => {
      preparations += 1; const root = path.join(documents.workspaceRoot, viewId); await fs.mkdir(root); await fs.writeFile(path.join(root, 'dep.ts'), 'export const x = 1;');
      return { root, derivedView: { viewId, branchId: 'fixed', revision: 0, sourceRoot: 'root', canonicalRoot: root, kernelEpoch: 'epoch' },
        check: async () => { await fs.stat(root); }, release: async () => { releases.push(viewId); await fs.rm(root, { recursive: true }); } };
    },
    admitProcess: async (_signal: AbortSignal, environment?: import('./source-query.js').PreparedLanguageSource) => ({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: environment!.root }),
  };
  const first = await supervisor.retainSourceView(binding, new AbortController().signal);
  expect(await supervisor.syncDocument({ view, resource: { workspaceId, resourceId: 'main.ts' }, languageId: 'typescript', content: 'const x = 1;', contentRevision: 'fixed-revision' })).toMatchObject({ status: 'synced' });
  await fs.writeFile(path.join(first.root, 'dep.ts'), 'export const x = 2;');
  await vi.waitFor(() => expect(releases).toEqual([first.derivedView!.viewId]));
  expect(peers[0]!.child.killed).toBe(true); expect(preparations).toBe(1);
  await expect(supervisor.checkSourceView(workspaceId, view, first, new AbortController().signal)).rejects.toThrow(/changed/);
  const second = await supervisor.retainSourceView(binding, new AbortController().signal);
  expect(second.derivedView!.viewId).not.toBe(first.derivedView!.viewId); expect(preparations).toBe(2);
  expect(await fs.readFile(path.join(second.root, 'dep.ts'), 'utf8')).toBe('export const x = 1;');
});


describe('source-bound language navigation', () => {
  it('preserves hover markup and a genuinely absent range; null is empty and malformed is unavailable', async () => {
    const f = await fixture({ capabilities: { hoverProvider: true } });
    const contents = { kind: 'markdown', value: '```ts\nconst value: number\n```\n[documentation](file:///provider/environment.ts)' };
    f.peer.handlers.set('textDocument/hover', () => ({ contents }));
    expect(await f.invoke({ method: 'hover' })).toMatchObject({ status: 'ready', items: [{ contents: [contents], resource: f.documents.resource('main.ts') }] });
    expect((await f.invoke({ method: 'hover' })).items[0]).not.toHaveProperty('range');
    f.peer.handlers.set('textDocument/hover', () => null);
    expect(await f.invoke({ method: 'hover' })).toMatchObject({ status: 'ready', items: [] });
    f.peer.handlers.set('textDocument/hover', () => ({ contents: { value: 42 } }));
    expect(await f.invoke({ method: 'hover' })).toMatchObject({ status: 'unavailable', items: [] });
  });

  it('keeps document symbol children and never relabels an unmapped workspace URI as the input', async () => {
    const f = await fixture({ capabilities: { documentSymbolProvider: true, workspaceSymbolProvider: true } });
    await fs.writeFile(path.join(f.documents.workspaceRoot, '..inside.ts'), 'export const needle = 123;\n');
    const range = testRange(0, 6, 11);
    f.peer.handlers.set('textDocument/documentSymbol', () => [{ name: 'outer', kind: 12, range, selectionRange: range,
      children: [{ name: 'inner', kind: 13, range, selectionRange: range }] }]);
    const symbols = await f.invoke({ method: 'document_symbols' });
    expect(symbols).toMatchObject({ status: 'ready', items: [{ name: 'outer', resource: f.documents.resource('main.ts'),
      children: [{ name: 'inner', resource: f.documents.resource('main.ts') }] }] });
    f.peer.handlers.set('workspace/symbol', frame => {
      expect(frame.params).toEqual({ query: 'value' });
      return [{ name: 'value', kind: 13, location: { uri: f.uri('main.ts'), range } },
        { name: 'needle', kind: 13, location: { uri: f.uri('..inside.ts'), range } },
        { name: 'private', kind: 13, location: { uri: 'file:///not-this-source/secret.ts', range } },
        { name: 'missing', kind: 13, range }];
    });
    expect(await f.invoke({ method: 'workspace_symbols', query: 'value' })).toMatchObject({
      status: 'partial', items: [{ name: 'value', resource: f.documents.resource('main.ts') },
        { name: 'needle', resource: f.documents.resource('..inside.ts') }], omissions: { outOfScope: 1, unmappable: 1 },
    });
    expect(await f.invoke({ method: 'document_symbols', path: '..inside.ts' })).toMatchObject({ status: 'ready',
      items: [{ resource: f.documents.resource('..inside.ts'), children: [{ resource: f.documents.resource('..inside.ts') }] }] });
    f.peer.handlers.set('workspace/symbol', () => ({}));
    expect(await f.invoke({ method: 'workspace_symbols', query: '' })).toMatchObject({ status: 'unavailable', items: [] });
  });

  it('isolates concurrent call queries, preserves every opaque candidate and keeps the original token consumer alive', async () => {
    const f = await fixture({ capabilities: { callHierarchyProvider: true } });
    const range = testRange(0, 6, 11);
    const raw = (name: string) => ({ name, kind: 12, uri: f.uri(name === 'cross' ? 'other.ts' : 'main.ts'), range,
      selectionRange: range, data: { privateProviderItem: name, nested: ['opaque'] } });
    f.peer.handlers.set('textDocument/prepareCallHierarchy', () => [raw('value'), raw('cross')]);
    const gate = deferred<void>(); let started = 0;
    f.peer.handlers.set('callHierarchy/outgoingCalls', async frame => {
      const item = frame.params?.item as ReturnType<typeof raw>;
      expect(item).toEqual(raw(item.name));
      if (++started <= 2) await gate.promise;
      return [{ to: raw('target'), fromRanges: [range] }];
    });
    const first = f.invoke({ method: 'call_hierarchy', direction: 'outgoing' });
    await vi.waitFor(() => expect(started).toBe(1));
    const second = f.invoke({ method: 'call_hierarchy', direction: 'outgoing', runId: 'run-b', grantId: 'grant-b' });
    await vi.waitFor(() => expect(started).toBe(2));
    gate.resolve();
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ status: 'ready', items: [
        { from: { name: 'value', resource: f.documents.resource('main.ts') }, to: { name: 'target' }, fromRanges: [range] },
        { from: { name: 'cross', resource: f.documents.resource('other.ts') }, to: { name: 'target' }, fromRanges: [range] },
      ] });
      expect(JSON.stringify(result)).not.toContain('privateProviderItem');
    }
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.peer.requests('callHierarchy/outgoingCalls')).toHaveLength(4);
    const source = (await f.invoke()).source!;
    const request = { resource: f.documents.resource('main.ts'), languageId: 'typescript', view: source.view as `agent:${string}`,
      generation: source.generation, documentVersion: source.documentVersion, position: { line: 0, character: 6 } };
    const prepared = await f.supervisor.prepareCallHierarchy(request);
    const token = (prepared as { value: Array<{ itemToken: string }> }).value[0]!.itemToken;
    await f.invoke({ method: 'call_hierarchy', direction: 'outgoing' });
    expect(await f.supervisor.callHierarchyOutgoing({ ...request, itemToken: token })).toMatchObject({ status: 'ready' });
  });

  it('never sends a prepared opaque item to another provider with matching local generation numbers', async () => {
    const f = await fixture({ capabilities: { hoverProvider: true, callHierarchyProvider: true } });
    f.peer.handlers.set('textDocument/hover', () => ({ contents: 'original provider' }));
    const original = await f.invoke({ method: 'hover', runId: 'run-b', grantId: 'grant-b' });
    expect(original.status).toBe('ready');
    const candidate = createControlledLanguagePeer({ callHierarchyProvider: true });
    f.spawn.mockImplementation(command => command === 'candidate' ? candidate.child : f.peer.child);
    f.supervisor.registerProvider({ providerId: 'candidate-provider', command: 'candidate', languageIds: ['typescript'], source: 'extension' });
    candidate.heldMethods.add('textDocument/prepareCallHierarchy');
    const pending = f.invoke({ method: 'call_hierarchy', direction: 'outgoing' });
    await vi.waitFor(() => expect(candidate.requests('textDocument/prepareCallHierarchy')).toHaveLength(1));
    const range = testRange(0, 6, 11);
    candidate.reply(candidate.requests('textDocument/prepareCallHierarchy')[0]!, [
      { name: 'value', kind: 12, uri: f.uri('main.ts'), range, selectionRange: range, data: { belongsTo: 'candidate-provider' } },
    ]);
    let retired: Promise<unknown> | undefined;
    queueMicrotask(() => { retired = f.supervisor.unregisterProvider('candidate-provider'); });
    const result = await pending;
    await retired;
    expect(result.status).toBe('stale');
    expect(result.items).toEqual([]);
    expect(f.peer.requests('callHierarchy/outgoingCalls')).toHaveLength(0);
    expect(candidate.requests('callHierarchy/outgoingCalls')).toHaveLength(0);
  });

  it('rechecks the querying Run before follow-through even while another Run retains the shared view, and cancels only its RPC', async () => {
    const f = await fixture({ capabilities: { callHierarchyProvider: true } });
    const range = testRange(0, 6, 11);
    const item = { name: 'value', kind: 12, uri: f.uri('main.ts'), range, selectionRange: range, data: 'private' };
    let revoked = false;
    f.validateSource.mockImplementation(async query => { if (query?.grantId === 'grant-a' && revoked) throw new Error('Original Run grant withdrawn'); });
    expect(await f.invoke({ runId: 'run-b', grantId: 'grant-b' })).toMatchObject({ status: 'ready' });
    f.peer.handlers.set('textDocument/prepareCallHierarchy', () => { revoked = true; return [item]; });
    expect(await f.invoke({ method: 'call_hierarchy', direction: 'incoming' })).toMatchObject({ status: 'unavailable', items: [], message: 'Original Run grant withdrawn' });
    expect(f.peer.requests('callHierarchy/incomingCalls')).toHaveLength(0);
    expect(f.supervisor.inspectViews()).toEqual([expect.objectContaining({ status: 'ready' })]);
    f.peer.handlers.set('textDocument/prepareCallHierarchy', () => [item]);
    f.peer.heldMethods.add('callHierarchy/incomingCalls');
    const controller = new AbortController();
    const pending = f.invoke({ method: 'call_hierarchy', direction: 'incoming', runId: 'run-b', grantId: 'grant-b' }, controller.signal);
    await vi.waitFor(() => expect(f.peer.requests('callHierarchy/incomingCalls')).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.peer.notifications('$/cancelRequest')).toHaveLength(1);
    expect(f.peer.child.killed).toBe(false);
    f.peer.heldMethods.delete('callHierarchy/incomingCalls');
    f.peer.handlers.set('callHierarchy/incomingCalls', () => null);
    expect(await f.invoke({ method: 'call_hierarchy', direction: 'incoming', runId: 'run-b', grantId: 'grant-b' })).toMatchObject({ status: 'ready', items: [] });
  });
});
