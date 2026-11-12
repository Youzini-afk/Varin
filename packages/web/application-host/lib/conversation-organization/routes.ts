import type { Express, Request, Response, RequestHandler } from 'express';
import { ConversationOrganizationError, parseConversationOrganizationQuery, type ConversationOrganizationCommand, type ConversationOrganizationMetadataItem } from '@varin/application-client';
import { withRequestPrincipal } from '../kernel/request-principal.js';
import { KernelClientError } from '../kernel/kernel-error.js';
import type { ConversationOrganizationService } from './service.js';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConversationOrganizationError('invalid_request', 'Expected an object');
  return value as Record<string, unknown>;
};
const fields = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ConversationOrganizationError('invalid_request', 'Unexpected organization request field');
};
const text = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) throw new ConversationOrganizationError('invalid_request', 'A non-empty identity is required'); return value; };
export function registerConversationOrganizationRoutes(app: Express, service: ConversationOrganizationService, requireAuth: RequestHandler,
  resolveAuth: (request: Request, response: Response) => Promise<unknown>) {
  for (const method of ['read', 'entry', 'command', 'metadata', 'project'] as const) app.post(`/api/conversation-organization/${method}`, requireAuth, async (req, res) => {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', close);
    try {
      const auth = await resolveAuth(req, res) as { principalId?: unknown } | null;
      const principalId = typeof auth?.principalId === 'string' && auth.principalId ? auth.principalId : null;
      const body = object(req.body);
      const result = await withRequestPrincipal(principalId, async () => {
        if (method === 'entry') {
          fields(body, ['conversation']); const ref = object(body.conversation); fields(ref, ['kind', 'id']); text(ref.id);
          if (ref.kind !== 'native' && ref.kind !== 'external') throw new ConversationOrganizationError('invalid_request', 'Unknown conversation kind');
          return service.entry(principalId, { kind: ref.kind, id: String(ref.id) }, controller.signal);
        }
        if (method === 'read') {
          return service.read(principalId, parseConversationOrganizationQuery(body), controller.signal);
        }
        if (method === 'project') { fields(body, ['projectId', 'command']); text(body.projectId); const command = object(body.command); fields(command, ['key', 'operation']); text(command.key); object(command.operation); return service.project(principalId, String(body.projectId), command as unknown as ConversationOrganizationCommand, controller.signal); }
        fields(body, method === 'command' ? ['key', 'operation'] : ['key', 'items']); text(body.key);
        if (method === 'command') { object(body.operation); return service.command(principalId, body as unknown as ConversationOrganizationCommand, controller.signal); }
        if (!Array.isArray(body.items)) throw new ConversationOrganizationError('invalid_request', 'Metadata requires a fixed conversation selection');
        const seen = new Set<string>();
        for (const raw of body.items) {
          const item = object(raw); fields(item, ['conversation', 'expectedRevision', 'patch']);
          const ref = object(item.conversation); fields(ref, ['kind', 'id']); text(ref.id);
          if (ref.kind !== 'native' && ref.kind !== 'external') throw new ConversationOrganizationError('invalid_request', 'Unknown conversation kind');
          const identity = JSON.stringify([ref.kind, ref.id]); if (seen.has(identity)) throw new ConversationOrganizationError('invalid_request', 'Duplicate selected conversation'); seen.add(identity);
          if (!Number.isSafeInteger(item.expectedRevision) || Number(item.expectedRevision) < 0) throw new ConversationOrganizationError('invalid_request', 'A valid revision is required');
          const patch = object(item.patch); fields(patch, ['title', 'pinned', 'archived', 'deleted']);
          if (patch.title !== undefined) text(patch.title);
          for (const key of ['pinned', 'archived', 'deleted']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new ConversationOrganizationError('invalid_request', 'Invalid metadata patch');
          if (patch.deleted && Object.keys(patch).length !== 1) throw new ConversationOrganizationError('invalid_request', 'Deletion must be a separate metadata action');
        }
        return service.metadata(principalId, String(body.key), body.items as ConversationOrganizationMetadataItem[], controller.signal);
      });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      const conflict = error instanceof KernelClientError && (error.code === 'conflict' || /^(?:operation error: )?conflict:/.test(message));
      const code = error instanceof ConversationOrganizationError ? error.code : conflict ? 'conflict' : error instanceof KernelClientError && ['not_found', 'not-found'].includes(error.code) ? 'not_found' : error instanceof KernelClientError && ['protocol', 'protocol-error'].includes(error.code) ? 'invalid_request' : 'unavailable';
      res.status(error instanceof ConversationOrganizationError ? error.status : conflict ? 409 : code === 'not_found' ? 404 : code === 'invalid_request' ? 400 : 503).json({ code, error: message,
        ...(error instanceof KernelClientError && error.details !== undefined ? { details: error.details } : {}) });
    } finally { res.off('close', close); }
  });
}
