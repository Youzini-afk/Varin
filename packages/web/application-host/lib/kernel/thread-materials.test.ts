import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity, type ThreadMaterialsAPI } from '@varin/application-client';
import type { FetchResult } from '@varin/protocol';
import type { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:reader', branchId: 'branch:original' };
const result: FetchResult = { status: 'failed', url: 'material:original', reason: 'Web reading disabled by the current user configuration' };

/** Real client/auth route; the domain port is controlled. Catalog/grant/Rust evidence is separate. */
function fixture() {
  let beforeRead: ((signal: AbortSignal | undefined) => void) | undefined;
  const read = vi.fn<ThreadMaterialsAPI['read']>(async (work, request, signal) => {
    beforeRead?.(signal); signal?.throwIfAborted();
    if (work.threadId !== identity.threadId || work.branchId !== identity.branchId) throw Object.assign(new Error('Original work missing'), { code: 'not-found' });
    if ('path' in request || 'grant' in request) throw Object.assign(new Error('Invalid material selector'), { code: 'material-request-invalid' });
    return result;
  });
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'fixture-session') { response.status(401).end(); return; } next();
  };
  registerThreadRoutes(app, {} as ThreadAdapter, requireAuth, undefined, undefined, { read });
  const request = async (body: unknown, authenticated = true, onResponse?: (response: EventEmitter) => void) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    onResponse?.(response);
    const input = { body, headers: authenticated ? { authorization: 'fixture-session' } : {} } as Request;
    const handlers = routes.get('/api/threads/materials/read')!;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    expect(new URL(url, 'https://fixture.test').pathname).toBe('/api/threads/materials/read');
    return request(JSON.parse(String(init.body)));
  });
  return { api: createThreadsHttpAPI(), read, request, before: (hook: typeof beforeRead) => { beforeRead = hook; } };
}
afterEach(() => vi.unstubAllGlobals());

it('passes the full fixed-material request and failures through client, authentication and domain port', async () => {
  const f = fixture();
  const request = { snapshotId: 'retained-original', view: 'structure' as const, pages: [2], parser: 'docling' as const, ocr: true };
  expect(await f.api.materials.read(identity, request)).toEqual(result);
  expect(f.read).toHaveBeenCalledWith(identity, request, expect.any(AbortSignal));
  const calls = f.read.mock.calls.length;
  expect((await f.request({ ...identity, request }, false)).status).toBe(401);
  for (const body of [{ ...identity, request, workspaceId: 'forged' }, { ...identity, runtime: 'pi', request }, { ...identity, request: [] }, { ...identity, request: null }]) expect((await f.request(body)).status).toBe(400);
  expect(f.read).toHaveBeenCalledTimes(calls);
  await expect(f.api.materials.read({ ...identity, branchId: 'foreign' }, request)).rejects.toMatchObject({ status: 404 });
  // Only the domain owner checks its nested request, avoiding a second route schema.
  expect((await f.request({ ...identity, request: { ...request, grant: 'forged' } })).status).toBe(400);
  expect(f.read.mock.calls.at(-1)?.[1]).toMatchObject({ grant: 'forged' });
});

it('aborts a closed observation and rejects a late client result without cancelling a Run', async () => {
  const f = fixture(); let response!: EventEmitter; let observed: AbortSignal | undefined;
  f.before(signal => { observed = signal; response.emit('close'); });
  await f.request({ ...identity, request: { snapshotId: 'original', view: 'overview' } }, true, value => { response = value; });
  expect(observed?.aborted).toBe(true);
  const controller = new AbortController(); f.before(() => controller.abort());
  await expect(f.api.materials.read(identity, { snapshotId: 'original', view: 'overview' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
