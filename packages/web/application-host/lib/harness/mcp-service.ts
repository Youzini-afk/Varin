/** Authenticated Pi adapter for the shared Application Host MCP owner. */
import { randomUUID } from 'node:crypto';
import { McpAuthority, McpAuthorityError, type McpAuthorityScope } from '@varin/pi-host/mcp-authority';
import type { McpOwnerAuthState, McpOwnerRequest, McpOwnerResponse } from '@varin/protocol';
import type { HarnessService, HarnessServiceContext } from './router.js';
import { HarnessServiceError } from './service-error.js';

interface OwnedScope { owner: string; sessionId: string }
interface AuthFlow {
  scope: string;
  state: McpOwnerAuthState;
  revision: number;
  observed: number;
  notify: Set<() => void>;
  reply: ((redirect: string | undefined) => void) | undefined;
  pendingReply: { value: string | undefined } | undefined;
  cancelled: boolean;
}
const ownerKey = (ctx: HarnessServiceContext) => JSON.stringify([ctx.actor.authorityInstanceId, ctx.actor.sessionId, ctx.actor.workerId, ctx.actor.workerGeneration]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function invalid(): never { throw new HarnessServiceError('invalid-params', 'Invalid MCP owner request'); }
function validate(value: unknown): asserts value is McpOwnerRequest {
  if (!object(value) || typeof value.operation !== 'string') invalid();
  if (value.operation === 'open') return;
  if (typeof value.scope !== 'string' || !value.scope) invalid();
  if (value.operation === 'close') return;
  if (value.operation === 'connect') {
    if (!object(value.entry) || typeof value.entry.name !== 'string' || !value.entry.name || typeof value.entry.source !== 'string' || !object(value.entry.config)
      || (value.entry.scope !== undefined && !['global', 'project', 'extension'].includes(String(value.entry.scope)))) invalid();
    return;
  }
  if (value.operation === 'updateConfig') {
    if (typeof value.name !== 'string' || typeof value.projectOverride !== 'boolean' || !object(value.patch)) invalid(); return;
  }
  if (['authPoll', 'authReply', 'authCancel'].includes(value.operation)) {
    if (typeof value.flow !== 'string' || !value.flow || (value.redirectUrl !== undefined && typeof value.redirectUrl !== 'string')) invalid(); return;
  }
  if (typeof value.handle !== 'string' || !value.handle) invalid();
  if (value.operation === 'callTool') {
    if (typeof value.tool !== 'string' || !value.tool || typeof value.schemaVersion !== 'string' || !object(value.arguments)) invalid(); return;
  }
  if (value.operation === 'readResource') { if (typeof value.uri !== 'string' || !value.uri) invalid(); return; }
  if (['resourcesPage', 'resourceTemplatesPage'].includes(value.operation)) { if (value.cursor !== undefined && typeof value.cursor !== 'string') invalid(); return; }
  if (!['snapshot', 'reconnect', 'signOut', 'release', 'allResources', 'allResourceTemplates', 'authStart'].includes(value.operation)) invalid();
}
export interface McpHarnessServices {
  services: { 'mcp.owner': HarnessService<'mcp.owner'> };
  disposeSession(sessionId: string): void;
  dispose(): void;
}
export function createMcpHarnessServices(authority: McpAuthority, resolveScope: (ctx: HarnessServiceContext) => McpAuthorityScope | Promise<McpAuthorityScope>): McpHarnessServices {
  const scopes = new Map<string, OwnedScope>();
  const flows = new Map<string, AuthFlow>();
  const changed = (flow: AuthFlow) => { flow.revision++; for (const notify of flow.notify) notify(); flow.notify.clear(); };
  const cancelFlow = (flow: AuthFlow) => { flow.cancelled = true; flow.reply?.(undefined); flow.pendingReply = { value: undefined }; changed(flow); };
  const closeScope = (scope: string) => {
    for (const [id, flow] of flows) if (flow.scope === scope) { cancelFlow(flow); flows.delete(id); }
    authority.closeScope(scope); scopes.delete(scope);
  };
  const service: HarnessService<'mcp.owner'> = {
    async handle(request, ctx): Promise<McpOwnerResponse> {
      validate(request);
      if (ctx.signal.aborted) throw new HarnessServiceError('failed', 'MCP request cancelled');
      if (request.operation === 'open') {
        const scope = await resolveScope(ctx);
        // Identity is pinned by the broker; callers cannot select a credential directory or cwd.
        if (scope.sessionId !== ctx.sessionId) throw new HarnessServiceError('forbidden', 'MCP scope identity mismatch');
        const opened = authority.open(scope);
        scopes.set(opened.scope, { owner: ownerKey(ctx), sessionId: ctx.sessionId });
        return opened;
      }
      const scope = scopes.get(request.scope);
      if (!scope || scope.owner !== ownerKey(ctx)) throw new HarnessServiceError('forbidden', 'MCP scope is not owned by this worker');
      try {
        switch (request.operation) {
          case 'close': closeScope(request.scope); return {};
          case 'connect': return { connection: await authority.connect(request.scope, request.entry) };
          case 'snapshot': return { connection: authority.snapshot(request.scope, request.handle) };
          case 'reconnect': return { connection: await authority.reconnect(request.scope, request.handle) };
          case 'release': authority.releaseConnection(request.scope, request.handle); return {};
          case 'updateConfig': await authority.updateConfig(request.scope, request.name, request.patch, request.projectOverride); return {};
          case 'signOut': return { value: await authority.signOut(request.scope, request.handle) };
          case 'callTool': return { value: await authority.callTool(request.scope, request.handle, request.tool, request.schemaVersion, request.arguments, ctx.signal) };
          case 'readResource': return { value: await authority.resources(request.scope, request.handle, request.operation, request.uri, ctx.signal) };
          case 'resourcesPage': case 'resourceTemplatesPage': return { value: await authority.resources(request.scope, request.handle, request.operation, request.cursor, ctx.signal) };
          case 'allResources': case 'allResourceTemplates': return { value: await authority.resources(request.scope, request.handle, request.operation, undefined, ctx.signal) };
          case 'authStart': {
            // Validate ownership before creating a callback flow; credentials never cross the channel.
            authority.snapshot(request.scope, request.handle);
            const id = randomUUID();
            const flow: AuthFlow = { scope: request.scope, state: { flow: id, state: 'pending' }, revision: 0, observed: 0, notify: new Set(), reply: undefined, pendingReply: undefined, cancelled: false };
            flows.set(id, flow);
            void authority.signIn(request.scope, request.handle, {
              showAuthorizationUrl: url => { if (!flow.cancelled) { flow.state.authorizationUrl = url.href; changed(flow); } },
              promptForRedirectUrl: signal => new Promise(resolve => {
                if (flow.cancelled || signal.aborted) { resolve(undefined); return; }
                if (flow.pendingReply) { resolve(flow.pendingReply.value); flow.pendingReply = undefined; return; }
                const finish = (value: string | undefined) => { signal.removeEventListener('abort', onAbort); flow.reply = undefined; resolve(value); };
                const onAbort = () => finish(undefined); flow.reply = finish; signal.addEventListener('abort', onAbort, { once: true });
              }),
            }).then(() => { flow.state = { flow: id, state: 'succeeded' }; changed(flow); }, () => {
              flow.state = { flow: id, state: 'failed', error: flow.cancelled ? 'MCP sign-in cancelled' : 'MCP sign-in failed' }; changed(flow);
            });
            return { auth: { ...flow.state } };
          }
          case 'authReply': case 'authPoll': case 'authCancel': {
            const flow = flows.get(request.flow);
            if (!flow || flow.scope !== request.scope) throw new HarnessServiceError('forbidden', 'MCP sign-in is not owned by this scope');
            if (request.operation === 'authCancel') { cancelFlow(flow); flows.delete(request.flow); return {}; }
            if (request.operation === 'authReply') {
              if (flow.reply) flow.reply(request.redirectUrl); else flow.pendingReply = { value: request.redirectUrl };
              return {};
            }
            if (flow.state.state === 'pending' && flow.revision === flow.observed) await new Promise<void>((resolve, reject) => {
              const finish = () => { ctx.signal.removeEventListener('abort', abort); flow.notify.delete(finish); resolve(); };
              const abort = () => { flow.notify.delete(finish); reject(new HarnessServiceError('failed', 'MCP sign-in observation cancelled')); };
              flow.notify.add(finish); ctx.signal.addEventListener('abort', abort, { once: true }); if (ctx.signal.aborted) abort();
            });
            flow.observed = flow.revision;
            const auth = { ...flow.state }; if (auth.state !== 'pending') flows.delete(request.flow);
            return { auth };
          }
        }
      } catch (error) {
        if (error instanceof HarnessServiceError) throw error;
        throw new HarnessServiceError('failed', error instanceof McpAuthorityError ? error.code : 'MCP owner operation failed');
      }
    },
  };
  return {
    services: { 'mcp.owner': service },
    disposeSession(sessionId) { for (const [id, scope] of scopes) if (scope.sessionId === sessionId) closeScope(id); authority.disposeSession(sessionId); },
    dispose() { for (const scope of [...scopes.keys()]) closeScope(scope); },
  };
}
