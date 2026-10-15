import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { ContentCollectionReport } from './protocol.generated.js';
import { registerRuntimeMaintenanceRoutes } from './runtime-maintenance-routes.js';

function fixture(work: (signal?: AbortSignal) => Promise<ContentCollectionReport>) {
  const requests = vi.fn(async (method: string, params: unknown, signal?: AbortSignal) => {
    expect(method).toBe('runtime.content.collect'); expect(params).toEqual({});
    return work(signal);
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  let handlers: RequestHandler[] = [];
  const app = { post(path: string, ...chain: RequestHandler[]) {
    expect(path).toBe('/api/runtime/content/collect'); handlers = chain;
  } } as unknown as Express;
  const requireAuth: RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'approved-host-session') { response.status(401).end(); return; }
    next();
  };
  registerRuntimeMaintenanceRoutes(app, runtime, requireAuth);
  function request(body: unknown, authenticated = true) {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; },
    });
    const input = { body, headers: authenticated ? { authorization: 'approved-host-session' } : {} } as Request;
    const done = new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++];
        if (!handler) { resolve(); return; }
        Promise.resolve(handler(input, response as unknown as Response, next)).then(() => {
          if (response.writableEnded) resolve();
        }, reject);
      };
      next();
    });
    return { response, done, result: () => ({ status, output }) };
  }
  return { request, requests };
}

it('authenticated empty maintenance requests preserve the worker partial-failure report', async () => {
  const report: ContentCollectionReport = { status: 'failed', phase: 'sweep', removedObjects: 2,
    removedBytes: 1234, removedStagingFiles: 0, reason: 'object deletion failed' };
  const f = fixture(async () => report);
  const denied = f.request({}, false); await denied.done;
  expect(denied.result().status).toBe(401); expect(f.requests).not.toHaveBeenCalled();
  const arbitraryPath = f.request({ path: '/another-owner' }); await arbitraryPath.done;
  expect(arbitraryPath.result().status).toBe(400); expect(f.requests).not.toHaveBeenCalled();
  const accepted = f.request({}); await accepted.done;
  expect(accepted.result()).toEqual({ status: 200, output: report });
  expect(f.requests).toHaveBeenCalledOnce();
});

it('closing the caller cancels only its collection request and transport errors stay sanitized', async () => {
  let received: AbortSignal | undefined;
  const f = fixture(signal => new Promise((_resolve, reject) => {
    received = signal;
    signal!.addEventListener('abort', () => reject(new Error('private transport diagnostics')), { once: true });
  }));
  const pending = f.request({});
  expect(received?.aborted).toBe(false);
  pending.response.emit('close'); await pending.done;
  expect(received?.aborted).toBe(true);
  expect(f.requests).toHaveBeenCalledOnce();
  expect(pending.result()).toEqual({ status: 500, output: {
    code: 'content-collection-request-failed', error: 'Content collection could not be completed',
  } });
});
