import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { registerBotRoutes } from './bot-routes.js';
import type { BotService } from './bot-service.js';
import type { BotSummary } from '@varin/application-client';

const entry = { runtime: 'agent' as const, threadId: 'bot-thread', branchId: 'bot-branch' };
const bot: BotSummary = { id: 'bot', name: 'Bot', instructions: null, model: null, coordinatorHostId: 'host', homeDir: '/bots/bot', entry, archived: false, createdAt: '', updatedAt: '' };
function fixture() {
  const create = vi.fn(async () => bot); const update = vi.fn(async () => bot);
  const ensureEntry = vi.fn(async () => ({ bot, entry, model: null }));
  const listWork = vi.fn(async () => [{ runtime: 'agent', identity: entry, thread: { thread_id: entry.threadId, bot_id: bot.id, branches: [], parent_thread_id: null, observer_project_ids: [null] }, activeRun: null, purpose: 'work' }]);
  const session = { identity: { runtime: 'agent' as const, threadId: 'bot-thread-2', branchId: 'bot-branch-2' }, primary: false,
    thread: { thread_id: 'bot-thread-2', main_branch_id: 'bot-branch-2', bot_id: bot.id, branches: [] } };
  const listSessions = vi.fn(async () => [{ identity: entry, primary: true, thread: { thread_id: entry.threadId, main_branch_id: entry.branchId, bot_id: bot.id, branches: [] } }, session]);
  const createSession = vi.fn(async () => session);
  const botActivity = vi.fn(async (input: { botId: string }) => ({ botId: input.botId, events: [], participants: [], before: null, eventCursor: 3 }));
  const botScope = vi.fn(async () => ({ botId: bot.id, sessions: [entry.threadId], runs: [], threads: [
    { thread_id: entry.threadId, title: '', parent_thread_id: null, deleted_at_ms: null, branches: [{ branch_id: entry.branchId, active_run_id: 'run', latest_run: { id: 'run', state: 'waiting', waiting_on: 'question:ask', cancel_requested: false } }] },
    { thread_id: 'child', title: 'Reviewer', parent_thread_id: entry.threadId, deleted_at_ms: null, branches: [{ branch_id: 'child-main', active_run_id: 'child-run', latest_run: { id: 'child-run', state: 'generating', waiting_on: null, cancel_requested: false } }] },
  ] }));
  const router = Router();
  const directRouter = router as unknown as { handle(request: Request, response: Response, next: NextFunction): void };
  registerBotRoutes(router as unknown as Express, { bots: { create, update, ensureEntry, get: async () => bot, listWork, listSessions, createSession } as unknown as BotService,
    work: { botActivity, botScope } as unknown as NonNullable<Parameters<typeof registerBotRoutes>[1]['work']> });
  const call = (method: string, url: string, body?: unknown) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const response = { setHeader() {}, status(value: number) { status = value; return this; }, json(value: unknown) { resolve({ status, body: value }); return this; } };
    directRouter.handle({ method, url, body, headers: {}, query: Object.fromEntries(new URL(url, 'http://host').searchParams) } as unknown as Request, response as unknown as Response, (error?: unknown) => error ? reject(error) : reject(new Error('No matching route')));
  });
  return { create, update, ensureEntry, listWork, listSessions, createSession, botActivity, botScope, session, call };
}
describe('Bot routes without a network listener', () => {
  it('creates native Bots without a runtime selector and returns the original tagged entry', async () => {
    const f = fixture();
    expect((await f.call('POST', '/api/harness/bots', { name: 'Bot' })).status).toBe(201);
    expect(f.create).toHaveBeenCalledWith({ name: 'Bot' });
    expect((await f.call('POST', '/api/harness/bots/bot/entry')).body).toEqual({ bot, entry, model: null });
    expect(f.ensureEntry).toHaveBeenCalledWith('bot');
    const work = await f.call('GET', '/api/harness/bots/bot/work');
    expect(work.status).toBe(200);
    expect(work.body).toMatchObject({ threads: [{ identity: entry, purpose: 'work', desktops: [], artifacts: [] }] });
  });
  it('lists the Bot conversations and starts another one through the service owner', async () => {
    const f = fixture();
    const listed = await f.call('GET', '/api/harness/bots/bot/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ sessions: [{ identity: entry, primary: true }, { identity: f.session.identity, primary: false }] });
    expect(f.listSessions).toHaveBeenCalledWith('bot');
    const created = await f.call('POST', '/api/harness/bots/bot/sessions');
    expect(created.body).toEqual({ session: f.session });
    expect(f.createSession).toHaveBeenCalledWith('bot');
  });
  it('keeps Bot conversations out of the delegated work list', async () => {
    const f = fixture();
    f.listWork.mockResolvedValueOnce([
      { runtime: 'agent', identity: f.session.identity, thread: { thread_id: f.session.identity.threadId, bot_id: bot.id, branches: [], parent_thread_id: null, observer_project_ids: [null] }, activeRun: null, purpose: 'session' },
      { runtime: 'agent', identity: entry, thread: { thread_id: entry.threadId, bot_id: bot.id, branches: [], parent_thread_id: null, observer_project_ids: [null] }, activeRun: null, purpose: 'work' },
    ]);
    const work = await f.call('GET', '/api/harness/bots/bot/work');
    expect(work.body).toMatchObject({ threads: [{ identity: entry, purpose: 'work' }] });
    expect((work.body as { threads: unknown[] }).threads).toHaveLength(1);
  });
  it('pages Bot activity through the runtime and rejects malformed cursors before reading', async () => {
    const f = fixture();
    const first = await f.call('GET', '/api/harness/bots/bot/activity');
    expect(first).toEqual({ status: 200, body: { botId: 'bot', events: [], participants: [], before: null, eventCursor: 3 } });
    expect(f.botActivity).toHaveBeenLastCalledWith({ botId: 'bot' });
    await f.call('GET', '/api/harness/bots/bot/activity?before=40&limit=10');
    expect(f.botActivity).toHaveBeenLastCalledWith({ botId: 'bot', before: 40, limit: 10 });
    for (const query of ['before=-1', 'before=abc', 'limit=0', 'limit=1.5']) {
      expect((await f.call('GET', `/api/harness/bots/bot/activity?${query}`)).status).toBe(400);
    }
    expect(f.botActivity).toHaveBeenCalledTimes(2);
  });
  it('projects presence from the Bot scope: a session question and running delegated work', async () => {
    const f = fixture();
    const read = await f.call('GET', '/api/harness/bots/bot/presence');
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ presence: {
      botId: 'bot', replying: [],
      needs: [{ identity: entry, name: 'Bot', avatar: null, kind: 'question', session: true }],
      working: [{ identity: { runtime: 'agent', threadId: 'child', branchId: 'child-main' }, name: 'Reviewer', avatar: null, sessionThreadId: entry.threadId }],
    } });
  });
  it('rejects runtime selectors and entry changes instead of silently accepting them', async () => {
    const f = fixture();
    await f.call('POST', '/api/harness/bots', { name: 'Native Bot' });
    expect(f.create).toHaveBeenCalledWith({ name: 'Native Bot' });
    for (const runtime of ['pi', 'agent', 'unknown']) expect((await f.call('POST', '/api/harness/bots', { runtime })).status).toBe(400);
    expect((await f.call('POST', '/api/harness/bots/bot/update', { runtime: 'agent' })).status).toBe(400);
    expect((await f.call('POST', '/api/harness/bots/bot/update', { entry })).status).toBe(400);
    expect(f.update).not.toHaveBeenCalled();
  });
});
