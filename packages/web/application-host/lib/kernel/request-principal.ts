/** Request authority is ephemeral; all ownership comes from the original Rust Catalog. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, RequestHandler } from 'express';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
const requests = new AsyncLocalStorage<{ principalId: string | null }>();
export const currentRequestPrincipal = (): string | null | undefined => requests.getStore()?.principalId;
export const withRequestPrincipal = <T>(principalId: string | null, work: () => T): T => requests.run({ principalId }, work);
export function assertPrincipalOwnership(owner: unknown, principalId = currentRequestPrincipal()): void {
  if (principalId !== undefined && owner !== null && owner !== principalId) throw Object.assign(new Error('Execution belongs to another user'), { code: 'forbidden' });
}
export function createThreadPrincipalMiddleware(runtime: AgentRuntimeClient,
  resolve: (request: Request, response: Response) => Promise<unknown>,
  isHostOwner?: (principalId: string) => Promise<boolean>): RequestHandler {
  return async (request, response, next) => {
    try {
      const auth = await resolve(request, response) as { principalId?: unknown } | null;
      const principalId = typeof auth?.principalId === 'string' && auth.principalId ? auth.principalId : null;
      const isOwner = principalId ? await isHostOwner?.(principalId) : false;
      if (principalId && !isOwner && request.body?.source != null) {
        response.status(403).json({ code: 'host-owner-required', error: 'Host resource sources require the Host owner' }); return;
      }
      const path = new URL(request.originalUrl || request.url, 'http://localhost').pathname.replace(/^\/api\/threads\//, '');
      const publicRead = request.method === 'GET' || /^(?:snapshot|run|operation(?:\/(?:calls|retrieval-trace))?|usage|tree(?:\/preview)?|history\/(?:page|runs|usage|run-preview)|context\/(?:inspect|history)|plan\/read|materials\/(?:read|collection)|media\/read|family\/(?:list|read|runs|item)|messages\/(?:list|feed|exchange|get)|child\/(?:list|page|executions|execution\/report|report)|followup\/(?:jobs|occurrence|occurrences|get|list|event-sources|source-routes|arrangements|registrations\/pending)|goal\/list|tools\/inspect|policy\/inspect|mcp\/interactions\/(?:list|read))$/.test(path);
      const assertAccess = (owner: string | null | undefined) => {
        assertPrincipalOwnership(owner, principalId);
        if (principalId && !isOwner && owner === null && !publicRead) throw Object.assign(new Error('Public execution changes require the Host owner'), { code: 'forbidden' });
      };
      const ids = new Map<string, Set<string>>();
      const collect = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          const kind = /^(?:threadId|thread_id|targetThreadId|senderThreadId|parentThreadId|childThreadId|callerThreadId|sourceAgent)$/.test(key) ? 'thread'
            : /^(?:runId|run_id|sourceRunId|previousRunId|expectedRunId)$/.test(key) ? 'run'
              : /^(?:operationId|operation_id|childOperationId)$/.test(key) ? 'operation'
                : key === 'inputId' ? 'input' : null;
          if (kind && typeof item === 'string' && item) { if (!ids.has(kind)) ids.set(kind, new Set()); ids.get(kind)!.add(item); }
          else if (item && typeof item === 'object') collect(item);
        }
      };
      collect(request.body); collect(request.query);
      const checkThread = async (id: string) => {
        const thread = await runtime.thread(id);
        assertAccess(thread.principal_id);
      };
      for (const id of ids.get('thread') ?? []) await checkThread(id);
      for (const id of ids.get('run') ?? []) { const run = await runtime.run(id); assertAccess(run.principal_id); }
      for (const id of ids.get('input') ?? []) await checkThread((await runtime.input(id)).thread_id);
      for (const id of ids.get('operation') ?? []) {
        const run = await runtime.run((await runtime.operation(id)).run_id);
        assertAccess(run.principal_id);
      }
      requests.run({ principalId }, next);
    } catch (error) {
      if (response.headersSent) { next(error); return; }
      response.status(403).json({ code: 'forbidden', error: 'Conversation access denied' });
    }
  };
}
