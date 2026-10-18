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
  expect(attach).toHaveBeenCalledWith('family', preview, 'ui-view:view', 'client', expect.any(AbortSignal));
});
