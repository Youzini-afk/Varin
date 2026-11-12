/** Request authority is ephemeral; ownership comes only from the Rust Catalog. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, RequestHandler } from 'express';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ownershipResolver, type OwnershipResolver, type OwnershipSelection } from './ownership-resolver.js';
interface RequestAuthority { principalId: string | null; hostOwner?: boolean; ownership?: OwnershipResolver }
const requests = new AsyncLocalStorage<RequestAuthority>();
export const currentRequestPrincipal = (): string | null | undefined => requests.getStore()?.principalId;
export const withRequestPrincipal = <T>(principalId: string | null, work: () => T): T => requests.run({ principalId }, work);
export function assertPrincipalOwnership(owner: unknown, principalId = currentRequestPrincipal()): void {
  if (principalId !== undefined && owner !== null && owner !== principalId) throw Object.assign(new Error('Execution belongs to another user'), { code: 'forbidden' });
}
export function assertAccess(owner: string | null, mode: 'read' | 'write', authority = requests.getStore()): void {
  assertPrincipalOwnership(owner, authority?.principalId);
  if (mode === 'write' && owner === null && authority?.principalId && !authority.hostOwner) {
    throw Object.assign(new Error('Public execution changes require the Host owner'), { code: 'forbidden' });
  }
}
/** Route handlers pass the exact identifiers they consume, never scan user content. */
export async function assertRequestAccess(selection: OwnershipSelection, mode: 'read' | 'write'): Promise<void> {
  const authority = requests.getStore();
  if (!authority?.ownership) return; // Trusted in-process calls have no HTTP authority.
  for (const owner of await authority.ownership.owners(selection)) assertAccess(owner, mode, authority);
}
export function createThreadPrincipalMiddleware(runtime: AgentRuntimeClient,
  resolve: (request: Request, response: Response) => Promise<unknown>,
  isHostOwner?: (principalId: string) => Promise<boolean>): RequestHandler {
  const ownership = ownershipResolver(runtime);
  return async (request, response, next) => {
    try {
      const auth = await resolve(request, response) as { principalId?: unknown } | null;
      const principalId = typeof auth?.principalId === 'string' && auth.principalId ? auth.principalId : null;
      const hostOwner = principalId ? await isHostOwner?.(principalId) ?? false : false;
      if (principalId && !hostOwner && request.originalUrl.startsWith('/api/threads/') && request.body?.source != null) {
        response.status(403).json({ code: 'host-owner-required', error: 'Host resource sources require the Host owner' }); return;
      }
      requests.run({ principalId, hostOwner, ownership }, next);
    } catch (error) {
      if (response.headersSent) { next(error); return; }
      response.status(403).json({ code: 'forbidden', error: 'Conversation access denied' });
    }
  };
}
