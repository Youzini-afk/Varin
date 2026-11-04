import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { registerInteractiveUiRoutes } from './routes.js';
import type { InteractiveUiRuntime } from './runtime.js';

it('passes the parsed conversation identity and content through the production middleware to source and view owners', async () => {
  const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
  const source = { ref: 'ui:work@1', contents: { 'index.html': '<h1>已保存的报告</h1>' } };
  const target = vi.fn(async () => 'family');
  const read = vi.fn(async () => source);
  const attach = vi.fn(async () => ({ viewRef: 'ui-view:view', token: 'view-token', state: null }));
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerInteractiveUiRoutes(app, { target, store: { source: read }, attach } as unknown as InteractiveUiRuntime, (_req, _res, next) => next());
  await request(app).post('/api/interactive-ui/source').send({ ...identity, ref: source.ref }).expect(200, source);
  expect(target).toHaveBeenCalledWith(expect.objectContaining(identity));
  expect(read).toHaveBeenCalledWith('family', source.ref);
  const preview = { preview: { callId: 'call', sequence: 2, contents: { 'index.html': '<h1>正在生成' }, entry: 'index.html', title: '报告' } };
  await request(app).post('/api/interactive-ui/view/attach').send({ ...identity, source: preview, viewRef: 'ui-view:view', clientId: 'client' }).expect(200);
  expect(attach).toHaveBeenCalledWith('family', preview, 'ui-view:view', 'client', expect.any(AbortSignal), { threadId: 'thread', branchId: 'branch' });
});

it('rejects cross-conversation preview provenance before attaching or saving a selection', async () => {
  const app = express(); registerCommonRequestMiddleware(app, { express });
  const attach = vi.fn(), select = vi.fn();
  registerInteractiveUiRoutes(app, { target: async () => 'family', attach, store: { select } } as unknown as InteractiveUiRuntime, (_req, _res, next) => next());
  const identity = { runtime: 'agent', threadId: 'thread', branchId: 'branch' };
  const source = { preview: { callId: 'preview', sequence: 0, title: 'Choice', entry: '', contents: {},
    messageFragment: { threadId: 'other-thread', branchId: 'branch', messageId: 'message', fragmentKey: 'offset:0', contentVersion: '' } } };
  await request(app).post('/api/interactive-ui/view/attach').send({ ...identity, source, clientId: 'client' }).expect(403);
  await request(app).post('/api/interactive-ui/select').send({ ...identity, observation: source, selection: { text: 'choice' } }).expect(403);
  expect(attach).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
