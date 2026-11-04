import { beforeEach, expect, it, vi } from 'vitest';
import { createInteractiveUiRuntime } from './runtime.js';

const store = vi.hoisted(() => ({ render: vi.fn(), source: vi.fn(), resolve: vi.fn(), view: vi.fn(), saveView: vi.fn(), captureBranch: vi.fn(), branchSeed: vi.fn() }));
vi.mock('./store.js', async importOriginal => ({ ...await importOriginal<typeof import('./store.js')>(), createUiContentStore: () => store }));
const definition = { type: 'choice', label: '发型', options: ['短发', '长发'] };
const text = '正文\n```varin-ui\n' + JSON.stringify(definition) + '\n```\n';
const reference = { id: 'message', source: 'assistant', content_ref: 'hash' };
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
function fixture() {
  const runtime = {
    thread: vi.fn(async () => ({ branches: [{ branch_id: 'branch' }, { branch_id: 'fork' }] })),
    familyList: vi.fn(async () => ({ rootThreadId: 'family' })),
    historyPage: vi.fn(async () => ({ head: 'message', items: [reference], previous: null as string | null, boundary_reset: false })),
    historyItem: vi.fn(async () => ({ id: 'message', source: 'assistant', content: { content: { kind: 'text', text } } })),
  };
  return { runtime, ui: createInteractiveUiRuntime({ kernel: {} as never, runtime: runtime as never, media: {} as never }) };
}
beforeEach(() => { vi.clearAllMocks(); store.branchSeed.mockResolvedValue(null); store.view.mockResolvedValue(null); store.render.mockResolvedValue({ ref: 'ui:registered@1' }); store.source.mockResolvedValue({ ref: 'ui:registered@1' }); });
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
