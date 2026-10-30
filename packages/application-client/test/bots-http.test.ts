import "./network-fixture.js";
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BotRequestError, createBotsHttpAPI } from '../src/bots-http.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';
const entry = { runtime: 'agent' as const, threadId: 'thread-original', branchId: 'branch-original' };
const bot = { id: 'bot', name: 'Bot', instructions: null, model: null, coordinatorHostId: 'host', homeDir: '/bot', entry, archived: false, createdAt: '', updatedAt: '' };
it('consumes tagged native entry and changed memory sources; refuses mismatched navigation identity', async () => {
  const original = globalThis.fetch; let mismatch = false;
  globalThis.fetch = async input => String(input).endsWith('/source')
    ? Response.json({ sources: [{ status: 'changed', span: { kind: 'history-item', threadId: entry.threadId, branchId: entry.branchId, headId: 'head', id: 'item', revision: 'original', start: 0, end: 3 } }] })
    : Response.json({ bot, model: null, entry: mismatch ? { ...entry, branchId: 'foreign' } : entry });
  try {
    const api = createBotsHttpAPI();
    assert.deepEqual((await api.entry(bot.id)).entry, entry);
    assert.equal((await api.memory.source(bot.id, 1))[0]?.status, 'changed');
    mismatch = true; await assert.rejects(api.entry(bot.id), error => error instanceof BotRequestError && error.code === 'invalid-response');
  } finally { globalThis.fetch = original; }
});
it('retains uncertain preview retry semantics and frozen source identity', async () => {
  const original = globalThis.fetch; let request: unknown;
  globalThis.fetch = async (_input, init) => { request = JSON.parse(String(init?.body)); return Response.json({ code: 'receipt-pending', error: 'Original inference receipt pending', retryDisposition: 'observe' }, { status: 409 }); };
  try {
    const selected = { ...entry, headId: 'head-original', requestKey: 'request-original', sources: [{ itemId: 'item-original', start: 5, text: 'selected' }] };
    await assert.rejects(createBotsHttpAPI().selection.preview(selected), error => error instanceof BotRequestError && error.retryDisposition === 'observe');
    assert.deepEqual(request, selected);
  } finally { globalThis.fetch = original; }
});
it('rejects cancelled and old-Host Bot response bodies', async () => {
  const original = globalThis.fetch; let release!: (value: unknown) => void;
  globalThis.fetch = async input => String(input).includes('/auth/') ? Response.json({ token: 'test', expiresAt: Date.now() + 60_000 })
    : { ok: true, json: () => new Promise(resolve => { release = resolve; }) } as Response;
  try {
    const api = createBotsHttpAPI(); const controller = new AbortController();
    const cancelled = api.list(controller.signal); await new Promise(resolve => setImmediate(resolve)); controller.abort(); release({ bots: [bot] });
    await assert.rejects(cancelled, { name: 'AbortError' });
    const stale = api.list(); await new Promise(resolve => setImmediate(resolve)); switchRuntimeEndpoint({ apiBaseUrl: 'http://next-host.test', runtimeKey: 'next-host' }); release({ bots: [bot] });
    await assert.rejects(stale, error => error instanceof BotRequestError && error.code === 'host-changed');
  } finally { globalThis.fetch = original; }
});

it('rejects a legacy Bot entry instead of constructing a native identity', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ bots: [{ ...bot, entry: { runtime: 'pi', sessionId: 'original' } }] });
  try {
    await assert.rejects(createBotsHttpAPI().list(), error => error instanceof BotRequestError && error.code === 'invalid-response');
  } finally { globalThis.fetch = original; }
});
it('decodes Bot conversations on their main branch and refuses foreign navigation identities', async () => {
  const original = globalThis.fetch; let foreign = false;
  const thread = { thread_id: 'thread-second', main_branch_id: 'branch-second', title: 'New thread', bot_id: bot.id,
    branches: [{ branch_id: 'branch-second', head: null, active_run_id: null, latest_run: null }] };
  const session = () => ({ identity: { runtime: 'agent', threadId: 'thread-second', branchId: foreign ? 'branch-other' : 'branch-second' }, thread, primary: false });
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return init?.method === 'POST' ? Response.json({ session: session() }) : Response.json({ sessions: [session()] });
  };
  try {
    const api = createBotsHttpAPI();
    assert.equal((await api.sessions.list(bot.id))[0]?.identity.threadId, 'thread-second');
    assert.equal((await api.sessions.create(bot.id)).primary, false);
    assert.deepEqual(requests.map(line => line.replace(/^(\w+) .*\/api/, '$1 /api')), ['GET /api/harness/bots/bot/sessions', 'POST /api/harness/bots/bot/sessions']);
    foreign = true;
    await assert.rejects(api.sessions.list(bot.id), error => error instanceof BotRequestError && error.code === 'invalid-response');
  } finally { globalThis.fetch = original; }
});
it('reads Bot activity pages and presence, and refuses another Bot or an unknown event kind', async () => {
  const original = globalThis.fetch; let kind = 'quiet'; let owner = bot.id;
  const requests: string[] = [];
  const presence = { botId: bot.id, replying: ['thread-original'], working: [{ identity: { runtime: 'agent', threadId: 'work', branchId: 'work-main' }, name: 'Reviewer', avatar: null, sessionThreadId: 'thread-original' }],
    needs: [{ identity: { runtime: 'agent', threadId: 'work', branchId: 'work-main' }, name: 'Reviewer', avatar: null, kind: 'permission', session: false }] };
  globalThis.fetch = async input => {
    requests.push(String(input).replace(/^.*\/api/, '/api'));
    if (String(input).includes('/presence')) return Response.json({ presence: { ...presence, botId: owner } });
    return Response.json({ botId: owner, before: 7, eventCursor: 12, participants: [{ threadId: 'work', name: 'Reviewer', agentId: 'agent', avatar: null }],
      events: [{ kind, cursor: 9, atMs: null, sessionThreadId: 'thread-original', sessionBranchId: 'branch-original', runId: 'run', inputs: [{ origin: 'message', threadId: 'work', branchId: 'work-main', change: null }] }] });
  };
  try {
    const api = createBotsHttpAPI();
    const page = await api.activity(bot.id, { before: 10, limit: 5 });
    assert.equal(page.events[0]?.kind, 'quiet');
    assert.equal(page.events[0]?.atMs, null);
    assert.equal(page.before, 7);
    assert.deepEqual(await api.presence(bot.id), presence);
    assert.deepEqual(requests, ['/api/harness/bots/bot/activity?before=10&limit=5', '/api/harness/bots/bot/presence']);
    kind = 'unexplained';
    await assert.rejects(api.activity(bot.id), error => error instanceof BotRequestError && error.code === 'invalid-response');
    kind = 'quiet'; owner = 'other';
    await assert.rejects(api.activity(bot.id), error => error instanceof BotRequestError && error.code === 'invalid-response');
    await assert.rejects(api.presence(bot.id), error => error instanceof BotRequestError && error.code === 'invalid-response');
  } finally { globalThis.fetch = original; }
});
