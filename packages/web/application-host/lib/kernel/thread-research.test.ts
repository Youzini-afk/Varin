import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadResearchAPI, type ThreadResearchSelection } from '@varin/application-client';
import type { ExperimentAttemptView } from '@varin/protocol';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const selection: ThreadResearchSelection = { runtime: 'agent', threadId: 'thread:research', branchId: 'branch:research', sourceRunId: 'run:finished' };
const attempt: ExperimentAttemptView = { attemptId: 'attempt:accepted', specId: null, cancelRequested: false,
  backend: 'unresolved', state: 'submitted', collection: 'none', createdAt: 1 };

/** Public client, registered routes and auth chain are real. The research facade is controlled here;
 * its Catalog family/source/Job contracts are exercised by their owning tests, not this HTTP fixture. */
function fixture() {
  const research = {
    scopes: vi.fn(async () => [{ sourceRunId: selection.sourceRunId, workspaceId: 'workspace:original', executionWorkspaceId: 'workspace:private', canSubmit: true,
      source: { workspace_id: 'workspace:original', execution_workspace_id: 'workspace:private', branch_id: 'source:original', revision: 2,
        mode: 'materialized' as const, live_root: null } }]),
    submit: vi.fn(async (_selection, request) => ({ attempt: { ...attempt, requestId: request.requestId }, spec: null, text: 'accepted' })),
    list: vi.fn(async () => ({ attempts: [attempt], text: '' })), get: vi.fn(async () => ({ attempt, artifacts: [] })),
    logs: vi.fn(async (_selection, request, signal) => {
      signal?.throwIfAborted();
      return { attemptId: request.attemptId, stream: request.stream ?? 'stdout', offset: request.offset ?? 0,
        nextOffset: (request.offset ?? 0) + 5, eof: false, text: 'hello', origin: 'live' as const };
    }),
    artifact: vi.fn(), cancel: vi.fn(async () => ({ attempt: { ...attempt, cancelRequested: true } })), collect: vi.fn(),
    resources: vi.fn(async () => ({ machines: [], generatedAt: 1, text: '' })), sources: vi.fn(async () => ({ sources: [], text: '' })),
  } satisfies ThreadResearchAPI;
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'host-session') { response.status(401).end(); return; }
    next();
  };
  registerThreadRoutes(app, {} as ThreadAdapter, requireAuth, research);
  const request = async (path: string, body: unknown, authenticated = true, onResponse?: (response: EventEmitter) => void) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    onResponse?.(response);
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    const handlers = routes.get(path); if (!handlers) throw new Error(`Unknown route ${path}`);
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  return { research, request, api: createThreadsHttpAPI().research! };
}
afterEach(() => vi.unstubAllGlobals());

it('carries exact historical source selection and original User admission keys through authenticated routes', async () => {
  const f = fixture();
  const identity = { runtime: selection.runtime, threadId: selection.threadId, branchId: selection.branchId };
  expect((await f.api.scopes(identity))[0]?.sourceRunId).toBe(selection.sourceRunId);
  const intent = { requestId: 'user-command:original', specId: 'spec:original', retryOfAttemptId: 'attempt:previous' };
  expect((await f.api.submit(selection, intent)).attempt.specId).toBeNull();
  await f.api.submit(selection, intent);
  expect(f.research.submit.mock.calls).toEqual([[selection, intent], [selection, intent]]);
  expect(await f.api.logs(selection, { attemptId: attempt.attemptId, stream: 'stderr', offset: 17 })).toMatchObject({ stream: 'stderr', offset: 17 });
  expect(f.research.logs.mock.calls[0]?.[0]).toEqual(selection);
  expect((await f.request('/api/threads/research/submit', { ...selection, request: intent }, false)).status).toBe(401);
  expect((await f.request('/api/threads/research/submit', { ...selection, workspaceId: 'forged', request: intent })).status).toBe(400);
  expect((await f.request('/api/threads/research/submit', { ...selection, request: { ...intent, caller: { kind: 'maintenance' } } })).status).toBe(400);
  expect((await f.request('/api/threads/research/submit', { ...selection, request: { specId: intent.specId } })).status).toBe(400);
  expect(f.research.submit).toHaveBeenCalledTimes(2);
  f.research.get.mockRejectedValueOnce(new HarnessServiceError('denied', 'private source details'));
  await expect(f.api.get(selection, attempt.attemptId)).rejects.toMatchObject({ status: 403, code: 'denied' });
});

it('aborts a closed observation without issuing a job cancel and leaves accepted commands independent of response lifetime', async () => {
  const f = fixture();
  let response!: EventEmitter;
  f.research.logs.mockImplementationOnce(async (_selection, _request, signal) => {
    response.emit('close');
    expect(signal?.aborted).toBe(true);
    throw new Error('reader closed');
  });
  await f.request('/api/threads/research/logs', { ...selection, request: { attemptId: attempt.attemptId } }, true, value => { response = value; });
  expect(f.research.cancel).not.toHaveBeenCalled();
  f.research.submit.mockImplementationOnce(async (_selection, request) => {
    response.emit('close');
    return { attempt: { ...attempt, requestId: request.requestId }, spec: null, text: 'accepted independently' };
  });
  const result = await f.request('/api/threads/research/submit', { ...selection, request: { requestId: 'accepted-on-close', command: 'fixture' } }, true,
    value => { response = value; });
  expect(result.status).toBe(200);
  expect(f.research.cancel).not.toHaveBeenCalled();
  await f.api.cancel(selection, attempt.attemptId);
  expect(f.research.cancel.mock.calls).toEqual([[selection, attempt.attemptId]]);
});
