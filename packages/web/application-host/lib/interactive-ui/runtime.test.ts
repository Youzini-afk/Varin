import { beforeEach, expect, it, vi } from 'vitest';
import { createInteractiveUiRuntime } from './runtime.js';

const store = vi.hoisted(() => ({ render: vi.fn(), source: vi.fn(), resolve: vi.fn(), view: vi.fn(), saveView: vi.fn(), captureBranch: vi.fn(), branchSeed: vi.fn(), operationReceipt: vi.fn(), collect: vi.fn(), cleanup: vi.fn() }));
vi.mock('./store.js', async importOriginal => ({ ...await importOriginal<typeof import('./store.js')>(), createUiContentStore: () => store }));
const definition = { type: 'choice', label: '发型', options: ['短发', '长发'] };
const text = '正文\n```varin-ui\n' + JSON.stringify(definition) + '\n```\n';
const reference = { id: 'message', source: 'assistant', content_ref: 'hash' };
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
function fixture() {
  const runtime = {
    findOperation: vi.fn(),
    thread: vi.fn(async () => ({ branches: [{ branch_id: 'branch' }, { branch_id: 'fork' }] })),
    familyList: vi.fn(async () => ({ rootThreadId: 'family' })),
    historyPage: vi.fn(async () => ({ head: 'message', items: [reference], previous: null as string | null, boundary_reset: false })),
    historyItem: vi.fn(async (_reference: { id: string }) => ({ id: 'message', source: 'assistant', content: { content: { kind: 'text', text } } })),
  };
  return { runtime, ui: createInteractiveUiRuntime({ kernel: {} as never, runtime: runtime as never, media: {} as never }) };
}
beforeEach(() => { vi.clearAllMocks(); store.cleanup.mockResolvedValue({ pending: false, failures: [] }); store.branchSeed.mockResolvedValue(null); store.view.mockResolvedValue(null); store.render.mockResolvedValue({ ref: 'ui:registered@1' }); store.source.mockResolvedValue({ ref: 'ui:registered@1' }); });
it('derives registration only from the original assistant text and canonicalizes equivalent source coordinates', async () => {
  const { runtime, ui } = fixture();
  await ui.registerFragment(identity, { messageId: 'message', fragmentKey: 'offset:3' });
  expect(runtime.historyItem).toHaveBeenCalledWith(reference, undefined);
  expect(store.render).toHaveBeenCalledWith('family', { content: definition, title: '发型' }, expect.stringContaining('fragment:'), undefined,
    expect.objectContaining({ threadId: identity.threadId, branchId: identity.branchId, messageId: 'message', fragmentKey: 'offset:3' }));
});
it('rejects user, unreachable, quoted, stale and wrong-branch sources before any storage write', async () => {
  for (const invalid of ['user', 'unreachable', 'quoted', 'stale', 'branch'] as const) {
    const { runtime, ui } = fixture();
    if (invalid === 'user') runtime.historyPage.mockResolvedValue({ head: 'message', items: [{ ...reference, source: 'user' }], previous: null, boundary_reset: false });
    if (invalid === 'unreachable') runtime.historyPage.mockResolvedValue({ head: 'other', items: [], previous: null, boundary_reset: false });
    if (invalid === 'quoted') runtime.historyItem.mockResolvedValue({ id: 'message', source: 'assistant', content: { content: { kind: 'text', text: '````markdown\n' + text + '\n````' } } });
    await expect(ui.registerFragment({ ...identity, branchId: invalid === 'branch' ? 'unavailable' : 'branch' }, { messageId: 'message', fragmentKey: 'offset:3', ...(invalid === 'stale' ? { contentVersion: 'forged' } : {}) })).rejects.toThrow();
  }
  expect(store.render).not.toHaveBeenCalled();
});
it('pins ancestry pagination and separates branch origins without rewriting history', async () => {
  const { runtime, ui } = fixture();
  runtime.historyPage.mockResolvedValueOnce({ head: 'latest', items: [], previous: 'older', boundary_reset: false })
    .mockResolvedValueOnce({ head: 'latest', items: [reference], previous: null, boundary_reset: false });
  await ui.registerFragment(identity, { messageId: 'message', fragmentKey: 'offset:3' });
  expect(runtime.historyPage.mock.calls[1]).toEqual([{ branchId: 'branch', headId: 'latest', beforeId: 'older', limit: 100 }, undefined]);
  const mainOrigin = store.render.mock.calls[0]![2];
  await ui.registerFragment({ ...identity, branchId: 'fork' }, { messageId: 'message', fragmentKey: 'offset:3', contentIndex: 0 });
  expect(store.render.mock.calls[1]![2]).not.toEqual(mainOrigin);
  const forkOrigin = store.render.mock.calls[1]![2];
  await ui.registerFragment({ ...identity, branchId: 'fork' }, { messageId: 'message', fragmentKey: 'offset:3' });
  expect(store.render.mock.calls[2]![2]).toEqual(forkOrigin);
});

it('forks declarative edits once through original storage receipts and sends all subsequent writes to the branch work', async () => {
  const { ui } = fixture();
  store.source.mockResolvedValue({ ref: 'ui:original@3', workRef: 'ui:original', title: '发型', content: definition, definition,
    branchScope: { threadId: 'thread', branchId: 'main' } });
  store.render.mockResolvedValueOnce({ ref: 'ui:fork@1' }).mockResolvedValueOnce({ ref: 'ui:fork@2' });
  const changed = { ...definition, options: ['短发', '长发', '新发型'] };
  expect(await ui.renderForBranch('family', { ref: 'ui:original@3', content: changed }, 'operation', identity)).toEqual({ ref: 'ui:fork@2' });
  expect(store.render.mock.calls[0]).toEqual(['family', { content: definition, title: '发型' }, 'branch-fork:["thread","branch","ui:original"]', undefined, undefined, identity, 'ui:original@3']);
  expect(store.render.mock.calls[1]).toEqual(['family', { ref: 'ui:fork@1', content: changed }, 'operation', undefined, undefined, identity]);
  store.source.mockResolvedValue({ content: definition, branchScope: identity });
  await ui.renderForBranch('family', { ref: 'ui:fork@2', content: definition }, 'next', identity);
  expect(store.render.mock.calls[2]?.[1]).toEqual({ ref: 'ui:fork@2', content: definition });
});

it('allocates an independent view on branch change and denies state access to the old branch scope', async () => {
  const { ui } = fixture();
  const state = { data: { root: 'label:短发' }, controls: {}, scroll: { x: 0, y: 0 } };
  store.resolve.mockResolvedValue({ version: { ref: 'ui:work@1' } });
  store.view.mockResolvedValue({ branchScope: { threadId: 'thread', branchId: 'main' }, source: { ref: 'ui:work@1' }, state, lease: { clientId: 'client', token: 'old' } });
  store.saveView.mockImplementation(async (_root, _ref, patch) => patch);
  const attached = await ui.attach('family', { ref: 'ui:work@1' }, 'ui-view:old', 'client', undefined, identity);
  expect(attached.viewRef).not.toBe('ui-view:old'); expect(attached.state).toBeNull();
  expect(store.saveView.mock.calls[0]?.[2]).toMatchObject({ branchScope: identity, state: null });
  await expect(ui.validateViewScope('family', 'ui-view:old', identity)).rejects.toMatchObject({ status: 403 });
});

it('pages declarative source definitions at UTF-8 boundaries with continuation bound to the immutable revision', async () => {
  const { ui } = fixture();
  store.resolve.mockResolvedValue({ version: { ref: 'ui:work@2', title: '选择', entry: '', files: {}, revision: 2, content: definition, definition } });
  const signal = new AbortController().signal;
  const first = await ui.read('family', { kind: 'ui', ref: 'ui:work@2', view: 'source', limit: 1 }, signal);
  expect(first.next).toMatchObject({ kind: 'ui', ref: 'ui:work@2', view: 'source' });
  let output = first.contentText as string, next = first.next as { offset: number } | undefined;
  while (next) {
    const page = await ui.read('family', { kind: 'ui', ref: 'ui:work@2', view: 'source', limit: 7, offset: next.offset }, signal);
    output += page.contentText as string; next = page.next as { offset: number } | undefined;
  }
  expect(JSON.parse(output)).toEqual({ content: definition, definition });
});

it('binds local offsets to the exact original output part, never aggregate display offsets or neighboring non-text content', async () => {
  const { runtime, ui } = fixture();
  const second = { type: 'input', label: '预算', inputType: 'number' };
  runtime.historyItem.mockResolvedValue({ id: 'message', source: 'assistant', content: { content: { kind: 'output', output: { data: null, parts: [
    { kind: 'text', text }, { kind: 'media', media: {} }, { kind: 'text', text: '```varin-ui\n' + JSON.stringify(second) + '\n```\n' },
  ] } } } } as never);
  await ui.registerFragment(identity, { messageId: 'message', contentIndex: 2, fragmentKey: 'offset:0' });
  expect(store.render.mock.calls[0]?.[1]).toEqual({ content: second, title: '预算' });
  expect(store.render.mock.calls[0]?.[4]).toMatchObject({ contentIndex: 2, fragmentKey: 'offset:0' });
  await expect(ui.registerFragment(identity, { messageId: 'message', contentIndex: 2, fragmentKey: `offset:${text.length + 1}` })).rejects.toThrow();
  await expect(ui.registerFragment(identity, { messageId: 'message', contentIndex: 1, fragmentKey: 'offset:0' })).rejects.toThrow();
  await expect(ui.registerFragment(identity, { messageId: 'message', fragmentKey: 'offset:0' })).rejects.toThrow();
  runtime.historyItem.mockResolvedValue({ id: 'message', source: 'assistant', content: { content: { kind: 'text', text } } });
  await expect(ui.registerFragment(identity, { messageId: 'message', contentIndex: 2, fragmentKey: 'offset:3' })).rejects.toThrow();
});

it('captures only the fork ancestry and seeds new views from that immutable branch capture, never the current parent view', async () => {
  const { runtime, ui } = fixture();
  runtime.historyPage.mockResolvedValueOnce({ head: 'cut', items: [{ ...reference, id: 'cut' }], previous: 'older', boundary_reset: false })
    .mockResolvedValueOnce({ head: 'cut', items: [{ ...reference, id: 'ancestor' }], previous: null, boundary_reset: false });
  await ui.captureBranch(identity, 'child', 'cut');
  const args = store.captureBranch.mock.calls[0]!;
  expect(args.slice(0, 4)).toEqual(['family', { threadId: 'thread', branchId: 'branch' }, { threadId: 'thread', branchId: 'child' }, 'cut']);
  const contains = args[4] as (id: string) => boolean;
  expect(contains('ancestor')).toBe(true); expect(contains('future')).toBe(false);
  const state = { data: { root: 'label:短发' }, controls: {}, scroll: { x: 0, y: 0 } };
  store.branchSeed.mockResolvedValue(state); store.resolve.mockResolvedValue({ version: { ref: 'ui:child@1' } });
  store.saveView.mockImplementation(async (_root, _ref, patch) => patch);
  const child = { threadId: 'thread', branchId: 'child' };
  // HTTP routes must pass target admission before attach, so a failed native fork
  // cannot expose its prepared snapshot as an existing conversation.
  await expect(ui.target(child)).rejects.toMatchObject({ status: 404 });
  const attached = await ui.attach('family', { ref: 'ui:child@1' }, undefined, 'client', undefined, child);
  expect(attached.state).toEqual(state);
  expect(store.branchSeed).toHaveBeenCalledWith('family', child, { ref: 'ui:child@1' }, 'client');
});

it('forks HTML revisions through the same writer while retaining already-owned media and leaving the parent work unchanged', async () => {
  const { ui } = fixture();
  const image = Buffer.from('original-image');
  store.source.mockResolvedValue({ ref: 'ui:html@2', workRef: 'ui:html', title: 'Chart', entry: 'index.html',
    contents: { 'index.html': '<img src="media:media-image">', 'style.css': 'body{color:red}' }, assets: { 'media:media-image': { mimeType: 'image/png', data: image.toString('base64') } },
    branchScope: { threadId: 'thread', branchId: 'main' } });
  store.render.mockResolvedValueOnce({ ref: 'ui:child@1' }).mockResolvedValueOnce({ ref: 'ui:child@2' });
  const changes = [{ op: 'write' as const, file: 'style.css', text: 'body{color:blue}' }];
  const readMedia = vi.fn();
  expect(await ui.renderForBranch('family', { ref: 'ui:html@2', changes }, 'html-edit', identity, readMedia)).toEqual({ ref: 'ui:child@2' });
  expect(store.render.mock.calls[0]?.[1]).toEqual({ title: 'Chart', entry: 'index.html', changes: [
    { op: 'write', file: 'index.html', text: '<img src="media:media-image">' }, { op: 'write', file: 'style.css', text: 'body{color:red}' },
  ] });
  const retain = store.render.mock.calls[0]?.[3] as (id: string) => Promise<unknown>;
  expect(await retain('media-image')).toEqual({ mimeType: 'image/png', bytes: image }); expect(readMedia).not.toHaveBeenCalled();
  expect(store.render.mock.calls[1]?.[1]).toEqual({ ref: 'ui:child@1', changes });
});

it('builds the fork revision allowlist only from proven tool receipts and resolved explicit embeds in the pinned ancestry', async () => {
  const { runtime, ui } = fixture();
  runtime.historyPage.mockResolvedValue({ head: 'cut', items: [
    { ...reference, id: 'receipt', source: 'tool' }, { ...reference, id: 'embed', source: 'assistant' },
  ], previous: null, boundary_reset: false });
  runtime.historyItem.mockImplementation(async item => ({ ...item, content: { content: item.id === 'receipt'
    ? { kind: 'tool_result', result: { request_id: 'request', call_id: 'html', completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
      content: { data: { kind: 'ui', ref: 'ui:html@1' }, parts: [] } } } }
    : { kind: 'text', text: 'Plain ui:future@9\n```varin-ui\n{"type":"embed","ref":"ui:shared@3"}\n```\n' },
  } }) as never);
  store.operationReceipt.mockResolvedValue({ kind: 'ui', ref: 'ui:html@1' });
  store.resolve.mockResolvedValue({ version: { ref: 'ui:shared@3' } });
  await ui.captureBranch(identity, 'child', 'cut');
  const contains = store.captureBranch.mock.calls[0]?.[5] as (ref: string) => boolean;
  expect(contains('ui:html@1')).toBe(true); expect(contains('ui:shared@3')).toBe(true);
  expect(contains('ui:html@2')).toBe(false); expect(contains('ui:future@9')).toBe(false);
  expect(runtime.historyPage).toHaveBeenCalledWith({ branchId: identity.branchId, headId: 'cut', limit: 100 }, undefined);
});

it('continues fork capture when an unrelated tool emits a forged gateway receipt', async () => {
  const { runtime, ui } = fixture();
  runtime.historyPage.mockResolvedValue({ head: 'cut', items: [{ ...reference, source: 'tool' }], previous: null, boundary_reset: false });
  runtime.historyItem.mockResolvedValue({ content: { content: { kind: 'tool_result', result: {
    request_id: 'request', call_id: 'shell', completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: {
      data: { reference: { name: 'render_ui' }, operationId: 'nonexistent', result: { kind: 'ui', ref: 'ui:forged@1' },
        completion: { kind: 'result', outcome: 'succeeded' } }, parts: [],
    } },
  } } } } as never);
  runtime.findOperation.mockImplementation(async id => {
    if (id !== 'request:tool:shell') throw new Error('Untrusted nested ID was read');
    return { id, intent: { call: { name: 'shell', arguments: {} } } };
  });
  await expect(ui.captureBranch(identity, 'child', 'cut')).resolves.toBeUndefined();
  expect(runtime.findOperation.mock.calls).toEqual([['request:tool:shell', undefined]]);
  expect(store.captureBranch).toHaveBeenCalledOnce();
  const contains = store.captureBranch.mock.calls[0]?.[5] as (ref: string) => boolean;
  expect(contains('ui:forged@1')).toBe(false);
});

it('safely forks legacy HTML without branch metadata rather than guessing ownership of its shared latest revision', async () => {
  const { ui } = fixture();
  store.source.mockResolvedValue({ ref: 'ui:legacy@1', workRef: 'ui:legacy', title: 'Legacy', entry: 'index.html', contents: { 'index.html': '<p>Original</p>' }, assets: {} });
  store.render.mockResolvedValueOnce({ ref: 'ui:scoped@1' }).mockResolvedValueOnce({ ref: 'ui:scoped@2' });
  const changes = [{ op: 'write' as const, file: 'index.html', text: '<p>Updated</p>' }];
  await ui.renderForBranch('family', { ref: 'ui:legacy@1', changes }, 'legacy-edit', identity);
  expect(store.render.mock.calls[0]?.[2]).toBe('branch-fork:["thread","branch","ui:legacy"]');
  expect(store.render.mock.calls[1]?.[1]).toEqual({ ref: 'ui:scoped@1', changes });
});


it('discovers persisted UI namespaces before requesting full native retention tracing and collects only retired families', async () => {
  const threads = [{ threadId: 'thread', rootThreadId: 'family', release: true }];
  const base = { threads, sources: [], inheritances: [], attachments: [], attachmentPreparations: [], attachmentSources: [], uiReferences: null };
  const runtime = { materialRetention: vi.fn(async (_thread?: string, _signal?: AbortSignal, trace = false) => ({ ...base, uiReferences: trace ? ['ui:kept@1'] : null })) };
  const kernel = { issueGrant: vi.fn(async () => ({ grantId: 'discovery' })), revokeGrant: vi.fn(async () => {}),
    recordWorkspaces: vi.fn(async () => ({ workspaceIds: ['__varin_ui__:family', 'unrelated-workspace'] })) };
  const ui = createInteractiveUiRuntime({ kernel: kernel as never, runtime: runtime as never, media: {} as never });
  expect(await ui.releaseDeleted()).toEqual({ pending: false });
  expect(store.cleanup).toHaveBeenCalledWith('family', undefined);
  expect(runtime.materialRetention.mock.calls).toEqual([[undefined, undefined], [undefined, undefined, true]]);
  expect(store.collect).toHaveBeenCalledWith('family', { ...base, uiReferences: ['ui:kept@1'] }, undefined);
  expect(kernel.revokeGrant).toHaveBeenCalledWith('discovery');
  runtime.materialRetention.mockClear(); store.collect.mockClear();
  threads.push({ threadId: 'child', rootThreadId: 'family', release: false });
  await ui.releaseDeleted();
  expect(runtime.materialRetention.mock.calls).toEqual([[undefined, undefined]]);
  expect(store.collect).not.toHaveBeenCalled();
  kernel.recordWorkspaces.mockResolvedValue({ workspaceIds: [] }); runtime.materialRetention.mockClear();
  await ui.releaseDeleted(); expect(runtime.materialRetention).not.toHaveBeenCalled();
});

it('denies deleted conversation admission even while old branches still exist', async () => {
  const { ui, runtime } = fixture();
  runtime.thread.mockResolvedValue({ deleted_at_ms: 1, branches: [{ branch_id: 'branch' }] } as never);
  await expect(ui.target(identity)).rejects.toMatchObject({ status: 404 });
  await expect(ui.registerFragment(identity, { messageId: 'message', fragmentKey: 'offset:3' })).rejects.toMatchObject({ status: 404 });
  expect(store.render).not.toHaveBeenCalled();
});


it('reports pending physical cleanup even when its record was already released', async () => {
  const plan = { threads: [], uiReferences: null };
  const runtime = { materialRetention: vi.fn(async () => plan) };
  const kernel = { issueGrant: async () => ({ grantId: 'cleanup' }), revokeGrant: vi.fn(async () => {}),
    recordWorkspaces: async () => ({ workspaceIds: ['__varin_ui__:retired'] }) };
  const ui = createInteractiveUiRuntime({ kernel: kernel as never, runtime: runtime as never, media: {} as never });
  store.cleanup.mockResolvedValueOnce({ pending: true, failures: ['temporarily busy'] });
  expect(await ui.releaseDeleted()).toEqual({ pending: true });
  expect(store.collect).not.toHaveBeenCalled();
  expect(await ui.releaseDeleted()).toEqual({ pending: false });
  expect(store.cleanup).toHaveBeenCalledTimes(2);
  expect(kernel.revokeGrant).toHaveBeenCalledTimes(2);
});
