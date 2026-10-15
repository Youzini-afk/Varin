import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity, type ThreadMaterialsAPI, type ThreadResearchSelection } from '@varin/application-client';
import type { FetchResult } from '@varin/protocol';
import type { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:reader', branchId: 'branch:original' };
const selection: ThreadResearchSelection = { ...identity, sourceRunId: 'run:retained-source' };
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
  const readArtifact = vi.fn<ThreadMaterialsAPI['readArtifact']>(async (work, request, signal) => {
    beforeRead?.(signal); signal?.throwIfAborted();
    if (work.threadId !== identity.threadId || work.branchId !== identity.branchId || work.sourceRunId !== selection.sourceRunId) {
      throw Object.assign(new Error('Original research source missing'), { code: 'not-found' });
    }
    if ('path' in request || 'grant' in request || 'snapshotId' in request) throw Object.assign(new Error('Invalid artifact selector'), { code: 'material-request-invalid' });
    return result;
  });
  const readSource = vi.fn<ThreadMaterialsAPI['readSource']>(async (work, request, signal) => {
    beforeRead?.(signal); signal?.throwIfAborted();
    if (work.threadId !== identity.threadId || work.branchId !== identity.branchId || work.sourceRunId !== selection.sourceRunId) throw Object.assign(new Error('Original source missing'), { code: 'not-found' });
    if ('artifact' in request || 'snapshotId' in request || 'grant' in request) throw Object.assign(new Error('Invalid source selector'), { code: 'material-request-invalid' });
    return result;
  });
  const routes = new Map<string, RequestHandler[]>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers), get() {} } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'fixture-session') { response.status(401).end(); return; } next();
  };
  registerThreadRoutes(app, {} as ThreadAdapter, requireAuth, undefined, undefined, { read, readArtifact, readSource, upload: vi.fn(async () => result) });
  const request = async (body: unknown, authenticated = true, onResponse?: (response: EventEmitter) => void, path = '/api/threads/materials/read') => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    onResponse?.(response);
    const input = { body, headers: authenticated ? { authorization: 'fixture-session' } : {} } as Request;
    const handlers = routes.get(path)!;
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
    const path = new URL(url, 'https://fixture.test').pathname;
    expect(['/api/threads/materials/read', '/api/threads/materials/read-artifact', '/api/threads/materials/read-source']).toContain(path);
    return request(JSON.parse(String(init.body)), true, undefined, path);
  });
  return { api: createThreadsHttpAPI(), read, readArtifact, readSource, request, before: (hook: typeof beforeRead) => { beforeRead = hook; } };
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


it('carries the explicit research source and artifact request through the authenticated material route', async () => {
  const f = fixture();
  const request = { artifact: { attemptId: 'attempt:original', artifactId: 'artifact:original' }, view: 'overview' as const,
    parser: 'native' as const, pages: [1], ocr: false };
  expect(await f.api.materials.readArtifact(selection, request)).toEqual(result);
  expect(f.readArtifact).toHaveBeenCalledWith(selection, request, expect.any(AbortSignal));
  expect(f.read).not.toHaveBeenCalled();
  const calls = f.readArtifact.mock.calls.length;
  const route = (body: unknown, auth = true) => f.request(body, auth, undefined, '/api/threads/materials/read-artifact');
  expect((await route({ ...selection, request }, false)).status).toBe(401);
  for (const body of [
    { ...selection, request, workspaceId: 'forged' }, { ...selection, request, grant: 'forged' },
    { ...selection, runtime: 'pi', request }, { ...selection, sourceRunId: '', request },
    { ...identity, request }, { ...selection, request: [] }, { ...selection, request: null },
  ]) expect((await route(body)).status).toBe(400);
  expect(f.readArtifact).toHaveBeenCalledTimes(calls);
  for (const changed of [{ branchId: 'foreign' }, { threadId: 'foreign' }, { sourceRunId: 'foreign' }]) {
    await expect(f.api.materials.readArtifact({ ...selection, ...changed }, request)).rejects.toMatchObject({ status: 404, code: 'not-found' });
  }
  // The route forwards nested selectors to the sole domain decoder, including invalid fields.
  expect((await route({ ...selection, request: { ...request, snapshotId: 'mixed' } })).status).toBe(400);
  expect(f.readArtifact.mock.calls.at(-1)?.[1]).toMatchObject({ snapshotId: 'mixed' });
});

it('cancels only the artifact observation on close and refuses its late client response', async () => {
  const f = fixture(); let response!: EventEmitter; let observed: AbortSignal | undefined;
  const request = { artifact: { attemptId: 'attempt:original', artifactId: 'artifact:original' }, view: 'overview' as const };
  f.before(signal => { observed = signal; response.emit('close'); });
  await f.request({ ...selection, request }, true, value => { response = value; }, '/api/threads/materials/read-artifact');
  expect(observed?.aborted).toBe(true);
  const controller = new AbortController(); f.before(() => controller.abort());
  await expect(f.api.materials.readArtifact(selection, request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('retains explicit source Run identity for local PDF reading across the authenticated HTTP boundary', async () => {
  const f = fixture(), request = { path: 'papers/original.pdf', view: 'overview' as const, pages: [3] };
  expect(await f.api.materials.readSource(selection, request)).toEqual(result);
  expect(f.readSource).toHaveBeenCalledWith(selection, request, expect.any(AbortSignal));
  await expect(f.api.materials.readSource({ ...selection, sourceRunId: 'foreign' }, request)).rejects.toMatchObject({ status: 404 });
  expect((await f.request({ ...selection, request }, false, undefined, '/api/threads/materials/read-source')).status).toBe(401);
  expect((await f.request({ ...selection, request, workspaceId: 'forged' }, true, undefined, '/api/threads/materials/read-source')).status).toBe(400);
});
