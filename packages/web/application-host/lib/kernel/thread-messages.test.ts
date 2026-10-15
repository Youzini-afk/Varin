import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI } from '@varin/application-client';
import type { ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import type { MessageReceipt, MessageView } from './protocol.generated.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:caller', branchId: 'branch:caller' };
const target = { targetThreadId: 'thread:sibling', targetBranchId: 'branch:sibling' };
/** Actual API, authenticated route, adapter and runtime client. RPC facts are fixtures; family
 * message origin, peer authorization, content IO and durable delivery are tested by the Rust owner. */
function fixture() {
  const facts = { reply: {} as unknown, fail: false, block: false };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (method === 'runtime.thread.inspect') return { thread_id: params.threadId, observer_project_ids: [],
      branches: [{ branch_id: identity.branchId, active_run_id: null, head: null, latest_run: null }] };
    if (method === 'runtime.observations.reconcile') return facts.reply;
    if (method.startsWith('runtime.messages.')) {
      if (facts.fail) throw new KernelClientError({ code: 'operation-error', message: 'operation error: conflict: private upstream detail' });
      if (facts.block) return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return facts.reply;
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime, models, vi.fn(), vi.fn());
  const routes = new Map<string, RequestHandler[]>();
  registerThreadRoutes({ post: (path: string, ...chain: RequestHandler[]) => routes.set(path, chain), get() {} } as unknown as Express,
    adapter, (req, res, next) => { if (req.headers.authorization !== 'host-session') res.status(401).end(); else next(); });
  const request = async (path: string, body: unknown, authenticated = true, signal?: AbortSignal) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; } });
    const closed = () => response.emit('close');
    signal?.addEventListener('abort', closed, { once: true });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    try {
      await new Promise<void>((resolve, reject) => {
        let index = 0;
        const next = (error?: unknown) => {
          if (error) { reject(error); return; }
          const handler = routes.get(path)![index++]; if (!handler) { resolve(); return; }
          Promise.resolve(handler(input, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
        }; next();
      });
      signal?.throwIfAborted();
      return Response.json(output ?? {}, { status });
    } finally { signal?.removeEventListener('abort', closed); }
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body)), true, init.signal ?? undefined));
  return { facts, runtime, requests, request, models, api: createThreadsHttpAPI().messages! };
}
afterEach(() => vi.unstubAllGlobals());

it.each(['inform', 'request'] as const)('carries exact User %s acceptance through public consumers without making Host the activation owner', async kind => {
  const f = fixture();
  const request = { key: 'stable-user-intent', ...target, kind, text: '路径 C:\\work\\原文\nunchanged' };
  const accepted: MessageReceipt = { messageId: 'message:original', senderThreadId: identity.threadId, senderBranchId: identity.branchId,
    ...target, actor: { kind: 'user' }, kind, replyTo: null, acceptedCursor: 41, acceptedAtMs: 1000 };
  f.facts.reply = accepted;
  expect(await f.api.send(identity, request)).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.messages.send', { ...request, senderThreadId: identity.threadId, senderBranchId: identity.branchId }]);
  await f.api.send(identity, { key: 'reply-key', kind: 'inform', text: 'reply without a guessed target', replyTo: 'received-message' });
  expect(f.requests.mock.calls.at(-1)![1]).toEqual({ key: 'reply-key', kind: 'inform', text: 'reply without a guessed target', replyTo: 'received-message', senderThreadId: identity.threadId, senderBranchId: identity.branchId });
  f.facts.reply = { messages: [], nextCursor: 'fixed-received-cursor' };
  expect(await f.api.list(identity, { direction: 'incoming', cursor: 'fixed-received-cursor', limit: 2 })).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.messages.list', { direction: 'incoming', cursor: 'fixed-received-cursor', limit: 2, threadId: identity.threadId, branchId: identity.branchId }]);
  const original: MessageView = { ...accepted, messageId: 'received-message', senderThreadId: target.targetThreadId, senderBranchId: target.targetBranchId,
    targetThreadId: identity.threadId, targetBranchId: identity.branchId,
    actor: { kind: 'agent', runId: 'sender-run', operationId: 'sender-operation', origin: { kind: 'policy_action', action_id: 'sender-action', node_id: 'sender-node' } },
    state: 'queued', activation: kind === 'inform' ? { state: 'passive' } : { state: 'pending', executionId: null, holdReason: 'preparing' },
    deliveredRunId: null, deliveredCursor: null, text: 'original received body',
    replyWait: { waitId: 'reply-wait:sender-operation', operationId: 'sender-operation', runId: 'sender-run', deadlineAtMs: 2000,
      state: 'expired', replyMessageId: null, delivered: false } };
  f.facts.reply = original;
  expect(await f.api.get(identity, 'received-message')).toEqual(f.facts.reply);
  expect(f.requests.mock.calls.at(-1)!.slice(0, 2)).toEqual(['runtime.messages.get', { threadId: identity.threadId, branchId: identity.branchId, messageId: 'received-message' }]);
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect' || method.startsWith('runtime.messages.'))).toBe(true);
  expect(f.models.resolveModel).not.toHaveBeenCalled(); expect(f.models.rebindModel).not.toHaveBeenCalled();
});

it('requires Host authentication and preserves User ingress against forged actor, sender and unsupported Wait fields', async () => {
  const f = fixture(); const request = { key: 'k', ...target, kind: 'inform', text: 'body' };
  for (const method of ['send', 'list', 'get']) expect((await f.request(`/api/threads/messages/${method}`, identity, false)).status).toBe(401);
  expect(f.requests).not.toHaveBeenCalled();
  for (const extra of [{ actor: { kind: 'agent', runId: 'forged' } }, { senderThreadId: 'forged' }, { senderBranchId: 'forged' }, { kind: 'unknown' }, { wait: true }, { wait: {} }, { wait: { timeoutMs: 0 } }]) {
    expect((await f.request('/api/threads/messages/send', { ...identity, request: { ...request, ...extra } })).status).toBe(400);
  }
  expect((await f.request('/api/threads/messages/list', { ...identity, request: { direction: 'incoming', threadId: 'foreign' } })).status).toBe(400);
  expect((await f.request('/api/threads/messages/get', { ...identity, messageId: 'original', actor: 'user' })).status).toBe(400);
  expect(f.requests).not.toHaveBeenCalled();
  await expect(f.api.send({ ...identity, branchId: 'wrong-branch' }, request as Parameters<typeof f.api.send>[1])).rejects.toMatchObject({ status: 400 });
  expect(f.requests.mock.calls.every(([method]) => method === 'runtime.thread.inspect')).toBe(true);
  f.facts.fail = true;
  const response = await f.request('/api/threads/messages/send', { ...identity, request });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'thread-conflict', error: 'Thread request could not be completed' });
});

it('aborts only the original read when the view closes and preserves uncertain message keys on public retries', async () => {
  const f = fixture(); f.facts.block = true;
  const controller = new AbortController();
  const pending = f.api.get(identity, 'original-message', controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(f.requests.mock.calls.at(-1)![0]).toBe('runtime.messages.get'));
  const signal = f.requests.mock.calls.at(-1)![2]!; controller.abort(); await rejection;
  expect(signal.aborted).toBe(true);
  expect(f.requests.mock.calls.some(([method]) => method.includes('cancel'))).toBe(false);
  f.facts.block = false;
  const request = { key: 'same-original-key', ...target, kind: 'inform' as const, text: 'same-original-body' };
  await f.api.send(identity, request); await f.api.send(identity, request);
  const sends = f.requests.mock.calls.filter(([method]) => method === 'runtime.messages.send');
  expect(sends).toHaveLength(2); expect(sends[0]![1]).toEqual(sends[1]![1]);
  // Exactly-once acceptance is owned and tested by Rust, not simulated by this RPC fixture.
  f.facts.reply = ['original-waiter-run'];
  const observationSignal = new AbortController().signal;
  expect(await f.runtime.reconcileObservations(observationSignal)).toEqual(['original-waiter-run']);
  expect(f.requests.mock.calls.at(-1)).toEqual(['runtime.observations.reconcile', {}, observationSignal]);
});
