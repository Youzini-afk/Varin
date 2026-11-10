import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
const endpoint = vi.hoisted(() => ({ url: 'https://host-a', key: 'local', generation: 1, before: new Set<() => void>(), after: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeApiBaseUrl: () => endpoint.url, getRuntimeKey: () => endpoint.key,
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => { endpoint.before.add(listener); return () => endpoint.before.delete(listener); },
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.after.add(listener); return () => endpoint.after.delete(listener); },
}));
import { bindThreadStore, threadHostKey, threadIdentityKey, threadComposerKey, useThreadStore } from './useThreadStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from './useThreadDraftStore';
import { selectThreadFiles } from '@/lib/agent-runtime/fileAttachments';
import { sendThreadDraft } from '@/lib/agent-runtime/sendThreadDraft';
import { insertDraftMarker, referenceMarkerObject, freezeDraftContentReferences } from '@/lib/agent-editor/contentReferences';
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread-a', branchId: 'main-a' };
const summary = (patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  thread_id: identity.threadId, main_branch_id: identity.branchId, title: 'A', revision: 1, created_at_ms: 1, updated_at_ms: 1,
  pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 4, read_cursor: 0, unread: true,
  bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: null, active_run_id: null, latest_run: null }], ...patch,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let cleanup: (() => void) | undefined;
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
function apiFixture() {
  const listeners: Array<Parameters<ThreadsAPI['observe']>[1]> = [];
  const list = vi.fn(async () => [summary()]);
  const api = { list, create: vi.fn(async () => identity), update: vi.fn(async () => summary({ revision: 2, title: 'Renamed' })),
    delete: vi.fn(async () => summary({ deleted_at_ms: 10 })), markRead: vi.fn(async () => summary({ read_cursor: 4, unread: false })),
    observe: vi.fn(async (_cursor: number, listener: Parameters<ThreadsAPI['observe']>[1], { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => { listeners.push(listener); signal.addEventListener('abort', () => resolve(), { once: true }); })),
  } as unknown as ThreadsAPI;
  return { api, list, listeners };
}
beforeEach(() => { endpoint.url = 'https://host-a'; endpoint.generation += 1; useThreadDraftStore.setState({ drafts: {} }); });
afterEach(() => { cleanup?.(); cleanup = undefined; });
it('opens the canonical branch from native catalog and keeps pin/archive/read writes with their authoritative revision', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  expect(f.list).toHaveBeenCalledWith({ archived: 'include' });
  await useThreadStore.getState().selectThread({ threadId: identity.threadId });
  expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
  await useThreadStore.getState().updateThread(identity.threadId, { title: 'Renamed' });
  expect(f.api.update).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'agent', threadId: identity.threadId, expectedRevision: 1, title: 'Renamed' }));
  await useThreadStore.getState().markRead(identity.threadId, 4);
  expect(useThreadStore.getState().threads[0].unread).toBe(false);
});
it('invalidates catalog on original events and never turns a failed refresh into an empty success', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  f.list.mockRejectedValueOnce(new Error('catalog offline'));
  f.listeners[0]({ cursor: 5, subject: identity.threadId, revision: 2, kind: 'thread.updated', data: {} });
  await settle();
  expect(useThreadStore.getState().threads[0].title).toBe('A');
  expect(useThreadStore.getState().catalogError).toBe('catalog offline');
});
it('fences old Host reads even when Host labels and thread IDs collide', async () => {
  const f = apiFixture(); const pending = deferred<ThreadSummary[]>(); f.list.mockImplementationOnce(() => pending.promise);
  cleanup = bindThreadStore(f.api);
  for (const listener of endpoint.before) listener(); endpoint.url = 'https://host-b'; endpoint.generation += 1;
  f.list.mockResolvedValue([summary({ title: 'B' })]); for (const listener of endpoint.after) listener();
  await settle(); pending.resolve([summary({ title: 'stale A' })]); await settle();
  expect(useThreadStore.getState().hostKey).toBe(threadHostKey());
  expect(useThreadStore.getState().threads[0].title).toBe('B');
});
it('does not select a late first-send creation over a newer local draft', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const first = useThreadStore.getState().openDraft();
  const pending = deferred<ThreadIdentity>(); vi.mocked(f.api.create).mockImplementationOnce(() => pending.promise);
  const creating = useThreadStore.getState().materializeDraft(first);
  const next = useThreadStore.getState().openDraft();
  const created = { runtime: 'agent' as const, threadId: 'new-thread', branchId: 'new-branch' };
  pending.resolve(created); await creating;
  expect(useThreadStore.getState().selectedIdentity).toBeNull();
  expect(useThreadStore.getState().selectedDraftKey).toBe(next);
  expect(useThreadDraftStore.getState().drafts[first].identity).toEqual(created);
  expect(f.api.create).toHaveBeenCalledTimes(1);
});
it('retains text, images, source and unconfirmed request per real Host and branch without projecting execution', () => {
  const a = threadIdentityKey(threadHostKey(), identity);
  const image = { id: 'image', mimeType: 'image/png', data: 'bytes' } as never;
  const pendingInput = { kind: 'enqueue' as const, fingerprint: 'original', editorText: 'original', status: 'unknown' as const, input: { ...identity, key: 'original-key', text: 'original', images: [image], mode: 'boundary' as const } };
  useThreadDraftStore.getState().patch(a, { text: 'draft A', images: [image], pendingInput });
  const branch = threadIdentityKey(threadHostKey(), { ...identity, branchId: 'fork' });
  expect(useThreadDraftStore.getState().drafts[branch] ?? EMPTY_THREAD_DRAFT).toBe(EMPTY_THREAD_DRAFT);
  endpoint.url = 'https://host-b'; const b = threadIdentityKey(threadHostKey(), identity);
  expect(useThreadDraftStore.getState().drafts[b]).toBeUndefined();
  endpoint.url = 'https://host-a';
  expect(useThreadDraftStore.getState().drafts[threadIdentityKey(threadHostKey(), identity)]).toMatchObject({ text: 'draft A', images: [image], pendingInput });
});
it('keeps a newer activity/read position when an old idempotent metadata receipt returns', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const receipt = deferred<ThreadSummary>(); vi.mocked(f.api.update).mockImplementationOnce(() => receipt.promise);
  const update = useThreadStore.getState().updateThread(identity.threadId, { title: 'Renamed' });
  f.list.mockResolvedValue([summary({ title: 'Newer', revision: 3, activity_cursor: 12, read_cursor: 10, updated_at_ms: 100 })]);
  f.listeners[0]({ cursor: 12, subject: identity.threadId, revision: 3, kind: 'thread.updated', data: {} }); await settle();
  receipt.resolve(summary({ title: 'Renamed', revision: 2, activity_cursor: 5, read_cursor: 4 })); await update;
  expect(useThreadStore.getState().threads[0]).toMatchObject({ title: 'Newer', revision: 3, activity_cursor: 12, read_cursor: 10, unread: true, updated_at_ms: 100 });
});
it('remembers an explicitly selected real branch when navigating away and back', async () => {
  const f = apiFixture(); f.list.mockResolvedValue([summary({ branches: [...summary().branches, { branch_id: 'fork-a', head: null, active_run_id: null, latest_run: null }] })]);
  cleanup = bindThreadStore(f.api); await settle();
  await useThreadStore.getState().selectThread({ threadId: identity.threadId, branchId: 'fork-a' });
  useThreadStore.setState({ selectedIdentity: null });
  await useThreadStore.getState().selectThread({ threadId: identity.threadId });
  expect(useThreadStore.getState().selectedIdentity?.branchId).toBe('fork-a');
});
it('keeps new conversations local, then retains their composer through creation and a lost response', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const key = useThreadStore.getState().openDraft({ workspacePath: '/repo' });
  useThreadDraftStore.getState().patch(key, { text: 'Explain this project', model: { providerId: 'account', modelId: 'model' } });
  expect(f.api.create).not.toHaveBeenCalled();
  expect(useThreadStore.getState().selectedIdentity).toBeNull();
  expect(useThreadStore.getState().threads).toHaveLength(1);
  vi.mocked(f.api.create).mockRejectedValueOnce(new Error('lost response'));
  await expect(useThreadStore.getState().materializeDraft(key)).rejects.toThrow('lost response');
  await useThreadStore.getState().materializeDraft(key);
  expect(vi.mocked(f.api.create).mock.calls.map(call => call[0])).toEqual([key, key]);
  expect(threadComposerKey(threadHostKey(), identity)).toBe(key);
  expect(useThreadDraftStore.getState().drafts[key]).toMatchObject({ text: 'Explain this project', workspacePath: '/repo', identity });
  expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
});
it('sends a first input only once, preserves later typing, and retries unknown admission in the same Thread', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const key = useThreadStore.getState().openDraft();
  useThreadDraftStore.getState().patch(key, { text: 'Original question' });
  const submit = vi.fn().mockRejectedValueOnce(new Error('response lost'));
  f.api.submit = submit;
  const files = selectThreadFiles(key, [new File([new Uint8Array([0, 255, 9])], 'first.bin')]);
  const upload = vi.fn<ThreadsAPI['attachments']['upload']>().mockResolvedValue({ ref: 'attachment:first-file', filename: 'first.bin', mimeType: 'application/octet-stream', byteLength: 3 });
  f.api.attachments = { upload, read: vi.fn() };
  const request = { key: 'first-message', text: 'Original question', editorText: 'Original question', images: [], files,
    model: { providerId: 'account', modelId: 'model' }, editorContext: [], inlineContext: [], status: 'sending' as const };
  await expect(sendThreadDraft(f.api, key, request)).rejects.toThrow('response lost');
  expect(useThreadDraftStore.getState().drafts[key].pendingInput?.status).toBe('unknown');
  useThreadDraftStore.getState().patch(key, { text: 'Follow-up being typed' });
  const accepted = deferred<{ run_id: string; input_id: string }>(); submit.mockImplementationOnce(() => accepted.promise);
  const retry = sendThreadDraft(f.api, key, useThreadDraftStore.getState().drafts[key].firstSend!);
  const duplicate = sendThreadDraft(f.api, key, request);
  expect(duplicate).toBe(retry);
  accepted.resolve({ run_id: 'run', input_id: 'input' }); await retry;
  expect(f.api.create).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledExactlyOnceWith(identity, expect.objectContaining({ data: files[0]!.data, key: files[0]!.id }), undefined);
  expect(submit.mock.calls.every(([input]) => JSON.stringify(input.attachments) === JSON.stringify([{ ref: 'attachment:first-file' }]))).toBe(true);
  expect(useThreadDraftStore.getState().drafts[key].files).toEqual([]);
  expect(submit.mock.calls.map(call => call[0])).toEqual([expect.objectContaining({ ...identity, key: 'first-message', text: 'Original question' }),
    expect.objectContaining({ ...identity, key: 'first-message', text: 'Original question' })]);
  expect(useThreadDraftStore.getState().drafts[key]).toMatchObject({ text: 'Follow-up being typed', firstSend: undefined, pendingInput: undefined });
});

it('freezes native first-send quote relations and original image numbers while preserving later occurrences on receipt', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const key = useThreadStore.getState().openDraft();
  useThreadDraftStore.getState().patch(key, { text: 'Discuss ' });
  const source = { kind: 'chat' as const, thread: identity, itemId: 'quoted-entry', passages: [{ entryId: 'quoted-entry', start: 6, text: 'Original passage' }] };
  const quote = referenceMarkerObject({ ref: 'fixed-text', title: 'Varin', text: 'Original passage', source });
  await insertDraftMarker(key, quote);
  selectThreadFiles(key, [new File(['original file pixels'], 'source.png', { type: 'image/png' })]);
  const image = referenceMarkerObject({ ref: 'fixed-image', title: 'Image', image: { data: 'YQ==', mimeType: 'image/png' }, source });
  if (image.payload.kind !== 'image') throw new Error('Expected image');
  // A cleared annotation document restores its source, not the previously
  // exported thumbnail. Exercise the actual export cache without a canvas mock.
  image.payload.image.annotation = { source: { data: 'Yg==', mimeType: 'image/png' }, width: 1, height: 1, marks: [], past: [], future: [] };
  await insertDraftMarker(key, image);
  const draft = useThreadDraftStore.getState().drafts[key];
  const frozen = freezeDraftContentReferences(draft);
  const accepted = deferred<Awaited<ReturnType<ThreadsAPI['submit']>>>();
  const submit = vi.fn<ThreadsAPI['submit']>(() => accepted.promise); f.api.submit = submit;
  f.api.attachments = { read: vi.fn(), upload: vi.fn(async (_identity, file) => ({ ref: 'attachment:original-pixels', filename: file.filename, mimeType: file.mimeType, byteLength: file.data.size })) };
  const request = { key: 'first-quoted-input', text: draft.text, editorText: draft.text, images: draft.images, files: draft.files!, ...frozen,
    markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.map(occurrence => occurrence.id),
    model: { providerId: 'account', modelId: 'model' }, editorContext: [], inlineContext: [], status: 'sending' as const };
  const sending = sendThreadDraft(f.api, key, request);
  await settle();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ ...frozen, text: draft.text,
    images: [expect.objectContaining({ reference: 2, data: 'Yg==' })], attachmentImageReferences: { 'attachment:original-pixels': 1 } }));
  useThreadDraftStore.getState().patch(key, current => ({ text: `${current.text} Later: ` }));
  await insertDraftMarker(key, quote);
  const later = useThreadDraftStore.getState().drafts[key].references!.at(-1)!;
  accepted.resolve({ run_id: 'run', input_id: 'accepted-quoted-input', thread_id: identity.threadId, branch_id: identity.branchId, cursor: 1 }); await sending;
  const remainder = useThreadDraftStore.getState().drafts[key];
  expect(remainder.references?.map(reference => reference.id)).toEqual([later.id]);
  expect(remainder.text).toBe(`Discuss  Later: ${later.text}`);
  expect(remainder.images).toEqual([]); expect(remainder.files).toEqual([]);
  expect(remainder.firstMessageReceipt).toMatchObject({ editorText: draft.text, ...frozen, images: [expect.objectContaining({ reference: 2, data: 'Yg==' })],
    files: [expect.objectContaining({ imageReference: 1, attachment: expect.objectContaining({ ref: 'attachment:original-pixels' }) })] });
  expect(submit).toHaveBeenCalledOnce();
});


it('selects the accepted creation immediately and does not replace a newer draft after the catalog loads', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const draft = useThreadStore.getState().openDraft();
  const catalog = deferred<ThreadSummary[]>();
  f.list.mockImplementationOnce(() => catalog.promise);
  let accepted: ThreadIdentity | undefined;
  const creating = useThreadStore.getState().materializeDraft(draft, { waitForCatalog: false }).then(value => { accepted = value; });
  try {
    await settle();
    expect(accepted).toEqual(identity);
    expect(useThreadDraftStore.getState().drafts[draft].identity).toEqual(identity);
    expect(useThreadStore.getState().selectedDraftKey).toBeNull();
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    expect(threadComposerKey(threadHostKey(), identity)).toBe(draft);
    const newer = useThreadStore.getState().openDraft();
    catalog.resolve([summary()]); await creating; await settle();
    expect(useThreadStore.getState().selectedDraftKey).toBe(newer);
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
  } finally { catalog.resolve([summary()]); await creating; }
});

it('ignores a pre-creation catalog absence but retains authoritative removal on a current read', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const draft = useThreadStore.getState().openDraft();
  const beforeCreation = deferred<ThreadSummary[]>();
  const afterCreation = deferred<ThreadSummary[]>();
  f.list.mockImplementationOnce(() => beforeCreation.promise).mockImplementationOnce(() => afterCreation.promise);
  const refreshing = useThreadStore.getState().loadCatalog();
  try {
    await useThreadStore.getState().materializeDraft(draft, { waitForCatalog: false });
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    beforeCreation.resolve([]); await settle();
    expect(useThreadStore.getState().threads).toEqual([]);
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    expect(useThreadStore.getState().selectedDraftKey).toBeNull();
    afterCreation.resolve([summary()]); await refreshing;
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    f.list.mockResolvedValueOnce([]);
    await useThreadStore.getState().loadCatalog();
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
  } finally { beforeCreation.resolve([]); afterCreation.resolve([summary()]); await refreshing; }
});

it('does not supersede newer pending navigation when creation returns', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const draft = useThreadStore.getState().openDraft();
  const creation = deferred<ThreadIdentity>();
  vi.mocked(f.api.create).mockImplementationOnce(() => creation.promise);
  const creating = useThreadStore.getState().materializeDraft(draft, { waitForCatalog: false });
  const catalog = deferred<ThreadSummary[]>();
  const newerIdentity = { ...identity, threadId: 'thread-b', branchId: 'main-b' };
  const newerThread = summary({ thread_id: newerIdentity.threadId, main_branch_id: newerIdentity.branchId,
    branches: [{ branch_id: newerIdentity.branchId, head: null, active_run_id: null, latest_run: null }] });
  f.list.mockImplementationOnce(() => catalog.promise).mockResolvedValue([newerThread]);
  const selecting = useThreadStore.getState().selectThread(newerIdentity);
  try {
    creation.resolve(identity); await creating;
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
    catalog.resolve([newerThread]); await expect(selecting).resolves.toEqual(newerIdentity);
    expect(useThreadStore.getState().selectedIdentity).toEqual(newerIdentity);
  } finally { creation.resolve(identity); catalog.resolve([newerThread]); await creating; await selecting; }
});

it('does not restore the accepted creation after a Host switch during its catalog refresh', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const draft = useThreadStore.getState().openDraft();
  const catalog = deferred<ThreadSummary[]>();
  f.list.mockImplementationOnce(() => catalog.promise);
  try {
    await useThreadStore.getState().materializeDraft(draft, { waitForCatalog: false });
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    for (const listener of endpoint.before) listener();
    endpoint.url = 'https://host-after-creation'; endpoint.generation += 1;
    f.list.mockResolvedValue([]);
    for (const listener of endpoint.after) listener();
    const newer = useThreadStore.getState().openDraft();
    catalog.resolve([summary()]); await settle();
    expect(useThreadStore.getState().hostKey).toBe(threadHostKey());
    expect(useThreadStore.getState().selectedIdentity).toBeNull();
    expect(useThreadStore.getState().selectedDraftKey).toBe(newer);
    expect(useThreadDraftStore.getState().drafts[draft].identity).toEqual(identity);
  } finally { catalog.resolve([summary()]); await settle(); }
});

it('merges a large refreshed catalog with linear identity lookups and preserves newer receipts', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const size = 1000;
  let inspected = 0;
  const previous = Array.from({ length: size }, (_, index) => ({ ...summary({ revision: 3, title: `Newer ${index}` }),
    get thread_id() { inspected += 1; return `thread-${index}`; } }));
  useThreadStore.setState({ threads: previous });
  f.list.mockResolvedValue(Array.from({ length: size }, (_, index) => summary({ thread_id: `thread-${index}`, revision: 2, title: 'older' })));
  await useThreadStore.getState().loadCatalog();
  expect(useThreadStore.getState().threads).toHaveLength(size);
  expect(useThreadStore.getState().threads.at(-1)?.title).toBe(`Newer ${size - 1}`);
  expect(inspected).toBeLessThan(size * 4);
});


it('submits the first message while the sidebar catalog is still loading', async () => {
  const f = apiFixture(); cleanup = bindThreadStore(f.api); await settle();
  const key = useThreadStore.getState().openDraft();
  useThreadDraftStore.getState().patch(key, { text: 'Send without waiting' });
  const catalog = deferred<ThreadSummary[]>();
  f.list.mockImplementationOnce(() => catalog.promise);
  const submit = vi.fn().mockResolvedValue({ run_id: 'accepted-run', input_id: 'accepted-input' });
  f.api.submit = submit;
  const request = { key: 'first-input-during-catalog', text: 'Send without waiting', editorText: 'Send without waiting', images: [], files: [],
    model: { providerId: 'account', modelId: 'model' }, editorContext: [], inlineContext: [], status: 'sending' as const };
  const sending = sendThreadDraft(f.api, key, request);
  try {
    await settle();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ ...identity, key: request.key, expectedHead: null, text: request.text }));
    expect(useThreadDraftStore.getState().drafts[key].firstMessageReceipt?.inputId).toBe('accepted-input');
    expect(useThreadStore.getState().selectedIdentity).toEqual(identity);
    expect(useThreadStore.getState().selectedDraftKey).toBeNull();
  } finally { catalog.resolve([summary()]); await sending; await settle(); }
});
