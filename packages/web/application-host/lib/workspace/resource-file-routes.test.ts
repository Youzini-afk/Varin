import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { registerResourceFileRoutes } from './resource-file-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const owner = { kind: 'managed_host', connectionId: 'files-device', hostId: 'files-owner', endpointIdentity: 'original-endpoint' } as const;
async function server(remote: unknown, local: unknown = {}) {
  const app = express(); registerCommonRequestMiddleware(app, { express });
  const select = vi.fn(async selected => { expect(selected).toEqual(owner); return remote; });
  const requireAuth: RequestHandler = (_request, _response, next) => next();
  registerResourceFileRoutes(app, { local, remote: select, runtime: { coordinatorHostId: 'agent-host' }, attachments: {}, requireAuth } as unknown as Parameters<typeof registerResourceFileRoutes>[1]);
  const instance = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  servers.push(instance);
  return { base: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, select };
}

it('routes file views and original document watches to their explicit resource owner', async () => {
  const workspace = vi.fn(async () => ({ kind: 'list', page: { entries: [], nextCursor: null, path: '' } }));
  const documents = vi.fn(async () => new Response('data: {"kind":"changed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const local = { request: vi.fn() };
  const f = await server({ workspace, documents }, local);
  const response = await fetch(`${f.base}/api/resource-files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceOwner: owner, root: '/srv/work', workspaceId: 'original-workspace', command: { kind: 'list', path: '' } }) });
  expect(response.status).toBe(200);
  expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ coordinatorHostId: 'agent-host', root: '/srv/work', workspaceId: 'original-workspace' }), undefined);
  expect(local.request).not.toHaveBeenCalled();
  const watch = await fetch(`${f.base}/api/resource-documents/watch?workspaceId=original-workspace&resourceOwner=${encodeURIComponent(JSON.stringify(owner))}`);
  expect(watch.headers.get('content-type')).toContain('text/event-stream');
  expect(await watch.text()).toContain('data:');
  expect(documents).toHaveBeenCalledWith('watch?workspaceId=original-workspace', 'GET', undefined, expect.any(AbortSignal));
});

it('reads an Office document through the production JSON middleware and its original remote owner', async () => {
  const result = { kind: 'document', content: 'Original target Office content' };
  const workspaceAsset = vi.fn(async () => Response.json(result));
  const local = { asset: vi.fn() };
  const f = await server({ workspaceAsset }, local);
  const input = { resourceOwner: owner, root: '/srv/work', workspaceId: 'original-workspace', path: 'design.docx',
    asset: { kind: 'office-read', input: { view: 'content' } } };
  const response = await fetch(`${f.base}/api/resource-office`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(workspaceAsset).toHaveBeenCalledWith({ ...input, coordinatorHostId: 'agent-host' }, expect.any(AbortSignal));
  expect(local.asset).not.toHaveBeenCalled();
});

it('reports a copied destination and preserves a changed source when a cross-device move cannot finish', async () => {
  const bytes = Buffer.from('the selected content');
  const sourceRequest = vi.fn(async commandInput => {
    const command = commandInput.command;
    if (command.kind === 'list') return { kind: 'list', page: { entries: [{ name: 'note.txt', path: 'note.txt', kind: 'file', size: bytes.length, modifiedAt: '' }], nextCursor: null, path: '' } };
    if (command.kind === 'bytes') return { kind: 'bytes', bytesBase64: bytes.toString('base64'), nextOffset: bytes.length, eof: true, byteLength: bytes.length, version: 'original-version' };
    if (command.kind === 'remove') throw new Error('The source changed after it was copied; it was not removed');
    throw new Error('Unexpected operation');
  });
  let written = Buffer.alloc(0);
  const workspaceUpload = vi.fn(async (_input, body: AsyncIterable<Uint8Array>) => { for await (const chunk of body) written = Buffer.concat([written, chunk]); return { kind: 'done' }; });
  const f = await server({ workspaceUpload }, { request: sourceRequest });
  const response = await fetch(`${f.base}/api/resource-files/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    source: { resourceOwner: { kind: 'local' }, root: '/source', workspaceId: 'source' }, path: 'note.txt',
    destination: { resourceOwner: owner, root: '/destination', workspaceId: 'target' }, destinationPath: 'received.txt', move: true, key: 'move-original',
  }) });
  expect(await response.json()).toMatchObject({ copied: 1, removed: 0, error: expect.stringContaining('source changed') });
  expect(written).toEqual(bytes);
  expect(sourceRequest).toHaveBeenLastCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: 'remove', path: 'note.txt', expectedHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/) }) }));
});

it('propagates a cancelled recursive search to its original target owner', async () => {
  let started!: () => void, cancelled!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const workspace = vi.fn(async (_input, signal: AbortSignal) => {
    started();
    await new Promise<void>(resolve => {signal.addEventListener('abort', () => {cancelled();resolve();}, {once:true});});
    return {kind:'content-search',result:{status:'cancelled',generation:0}};
  });
  const f = await server({workspace});
  const controller = new AbortController();
  const request = fetch(`${f.base}/api/resource-files`, {method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
    body:JSON.stringify({resourceOwner:owner,root:'/target',workspaceId:'view',command:{kind:'content-search',path:'',query:'needle'}})}).catch(() => undefined);
  await entered;controller.abort();await stopped;await request;
  expect(workspace.mock.calls[0]?.[1].aborted).toBe(true);
});
