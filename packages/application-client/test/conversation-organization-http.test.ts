import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createConversationOrganizationHttpAPI } from '../src/conversation-organization-http.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';
it('does not publish an organization command result decoded after switching Hosts', async () => {
  const original = globalThis.fetch;
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { if (!String(_url).includes('/api/conversation-organization/')) return new Response(null, {status:404}); signal = init?.signal; return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response; };
  try {
    const request = createConversationOrganizationHttpAPI().command({ key: 'same-intent', operation: { action: 'dissolve', id: 'group', expectedRevision: 2, parents: [] } });
    await new Promise(resolve => setImmediate(resolve));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://next-organization-host.test', runtimeKey: 'next-organization-host' });
    finish({ key: 'same-intent', revision: 9, cursor: 10, containers: [], positions: [], removed: ['group'] });
    await assert.rejects(request, /Application Host changed|abort/i);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: '' }); }
});
it('cancels the original HTTP request and rejects a late snapshot', async () => {
  const original = globalThis.fetch; let finish!: (value: unknown) => void;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  try {
    const controller = new AbortController(); const pending = createConversationOrganizationHttpAPI().read({}, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); finish({ initialized: true });
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
it('rejects a malformed snapshot rather than publishing a fabricated empty directory', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ initialized: true, revision: 3, rootRevision: 2, cursor: 1, containers: [], conversations: [{ conversation: {kind:'native',id:'x'} }], nextCursor: null });
  try { await assert.rejects(createConversationOrganizationHttpAPI().read(), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'invalid_response'); }
  finally { globalThis.fetch = original; }
});

it('validates mixed page items separately from container ancestor context and preserves legacy snapshots', async () => {
  const { parseConversationOrganizationSnapshot } = await import('../src/conversation-organization.js');
  const container = (id: string, parentId: string | null) => ({ id, parentId, kind: 'group', order: 0, revision: 1, childrenRevision: 1, name: id, icon: null, color: null, projectId: null });
  const legacy = { initialized: true, revision: 1, rootRevision: 1, cursor: 1, containers: [container('ancestor', null), container('child', 'ancestor')], conversations: [], nextCursor: null };
  assert.equal(parseConversationOrganizationSnapshot(legacy), legacy);
  const page = { ...legacy, items: [{ kind: 'container', id: 'child' }], nextCursor: 'next-page' };
  assert.equal(parseConversationOrganizationSnapshot(page), page);
  assert.equal(page.items.length, 1); // Ancestor metadata does not consume a row or limit slot.
  const ref = { kind: 'native', id: 'thread' };
  const conversation = { conversation: ref, title: 'Thread', archived: false, pinned: false, revision: 1, updatedAtMs: 100,
    position: { conversation: ref, containerId: 'ancestor', order: 1, revision: 1, explicit: true, inheritedFrom: null },
    origin: { botId: null, directBotId: null, conversation: null }, path: ['ancestor'] };
  const mixed = { ...page, conversations: [conversation], items: [...page.items, ref] };
  assert.equal(parseConversationOrganizationSnapshot(mixed), mixed);
  assert.throws(() => parseConversationOrganizationSnapshot({ ...mixed, conversations: [{ ...conversation, updatedAtMs: -1 }] }), { code: 'invalid_response' });
  assert.throws(() => parseConversationOrganizationSnapshot({ ...mixed, items: page.items }), { code: 'invalid_response' });
  for (const items of [null, [{ kind: 'container', id: 'missing' }], [...page.items, ...page.items], [{ kind: 'container', id: 'child', principalId: 'other' }], [{ kind: 'group', id: 'child' }]]) {
    assert.throws(() => parseConversationOrganizationSnapshot({ ...page, items }), { code: 'invalid_response' });
  }
});

it('forwards mixed pagination without reducing limits and rejects invalid or unknown query fields before fetch', async () => {
  const original = globalThis.fetch;
  const queries: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    queries.push(JSON.parse(String(init?.body)));
    return Response.json({ initialized: true, revision: 1, rootRevision: 1, cursor: 1, containers: [], conversations: [], items: [], nextCursor: null });
  };
  try {
    const api = createConversationOrganizationHttpAPI();
    const query = { pageNodes: true, kind: 'conversations' as const, sort: 'recent' as const, excludeBotConversations: true, conversationTree: { parent: { kind: 'native' as const, id: 'parent' } }, recursive: true, limit: 100000, cursor: 'original-cursor' };
    assert.deepEqual((await api.read(query)).items, []);
    assert.deepEqual(queries, [query]);
    for (const bad of [{ pageNodes: 'true' }, { pageNodes: null }, { page_nodes: true }, { principalId: 'other' }, { projectNames: { fake: 'Injected' } }, { limit: 0 }, { recursive: 1 }, { kind: 'unknown' }, { sort: 'unknown' }, { kind: ['containers'] }, { sort: ['recent'] }]) {
      await assert.rejects(api.read(bad as never), { code: 'invalid_request' });
    }
    assert.equal(queries.length, 1);
  } finally { globalThis.fetch = original; }
});

it('does not silently interpret a legacy response as a requested mixed page', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ initialized: true, revision: 1, rootRevision: 1, cursor: 1, containers: [], conversations: [], nextCursor: null });
  try { await assert.rejects(createConversationOrganizationHttpAPI().read({ pageNodes: true }), { code: 'invalid_response' }); }
  finally { globalThis.fetch = original; }
});

it('shares the Thread observation connection and forwards scoped organization changes and resync', async () => {
  const { createThreadsHttpAPI } = await import('../src/threads-http.js');
  const { getThreadObservationBus } = await import('../src/thread-observation.js');
  const threads = createThreadsHttpAPI(), original = threads.observe;
  let listener!: Parameters<typeof threads.observe>[1]; let connections = 0;
  threads.observe = (_cursor, receive, options) => new Promise<void>(resolve => {
    connections++; listener = receive;
    options?.onReady?.();
    options?.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  const controller = new AbortController();
  const seen: import('../src/conversation-organization.js').ConversationOrganizationEvent[] = [];
  const stop = getThreadObservationBus(threads).subscribe({ kinds: ['thread.updated'] }, () => {});
  const observing = createConversationOrganizationHttpAPI().observe(0, event => seen.push(event), { signal: controller.signal });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connections, 1);
    assert.equal(seen[0] && 'stream' in seen[0] && seen[0].stream, 'resync');
    seen.length = 0;
    listener({ cursor: 1, subject: 'op', revision: 1, kind: 'operation.changed', data: {}, thread_id: 'a', branch_id: 'main' });
    assert.equal(seen.length, 0);
    listener({ cursor: 2, subject: 'navigation', revision: 2, kind: 'organization.changed', data: {}, thread_id: null, branch_id: null });
    assert.equal(seen.length, 1);
  } finally { controller.abort(); await observing; stop(); threads.observe = original; }
});
