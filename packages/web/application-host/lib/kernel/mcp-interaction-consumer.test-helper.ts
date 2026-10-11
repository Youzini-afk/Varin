/** Actual authenticated Threads client/route/Adapter over the test-only Rust rendezvous.
 * Only fetch delivery is in memory. All identity, storage and execution decisions use product code. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Express, Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from 'express';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import type { McpElicitationResponse } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

export function createInteractionConsumer(runtime: AgentRuntimeClient) {
  const unexpected = async (): Promise<never> => { throw new Error('MCP user response must not launch a Run or acquire a model/source'); };
  const adapter = new ThreadAdapter(runtime, { resolveModel: unexpected, rebindModel: unexpected }, unexpected, unexpected);
  const routes = new Map<string, RequestHandler[]>();
  const app = { post(path: string, ...handlers: RequestHandler[]) { routes.set(path, handlers); }, get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'fixture-original-host-session') { response.status(401).end(); return; }
    next();
  });
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'https://application.invalid');
    const handlers = routes.get(url.pathname); assert(handlers, `Unexpected application consumer route ${url.pathname}`);
    let status = 200, output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; },
    });
    const request = { body: JSON.parse(String(init?.body)), headers: { authorization: 'fixture-original-host-session' } } as ExpressRequest;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request, response as unknown as ExpressResponse, next))
          .then(() => { if (response.writableEnded) resolve(); }, reject);
      };
      next();
    });
    return Response.json(output ?? {}, { status });
  }) as typeof globalThis.fetch;
  const api = createThreadsHttpAPI();
  return {
    async perform(frame: Record<string, unknown>) {
      const identity: ThreadIdentity = { runtime: 'agent', threadId: String(frame.threadId), branchId: String(frame.branchId) };
      if (frame.action === 'list') return api.listMcpInteractions(identity);
      const target = { ...identity, operationId: String(frame.operationId), interactionId: String(frame.interactionId) };
      if (frame.action === 'read') return api.readMcpInteraction(target);
      assert.equal(frame.action, 'respond');
      return api.respondMcpInteraction({ ...target, expectedRevision: Number(frame.expectedRevision), response: frame.response as McpElicitationResponse });
    },
    close() { globalThis.fetch = actualFetch; },
  };
}
