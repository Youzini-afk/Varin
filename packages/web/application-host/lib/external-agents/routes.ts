import type { Express, RequestHandler } from 'express';
import {
  ExternalAgentError,
  type ExternalAgentSettings,
  type ExternalInput,
} from '@varin/application-client';
import type { ExternalAgentsService } from './service.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ExternalAgentError('invalid_request', 'Expected an object');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new ExternalAgentError('invalid_request', 'A non-empty identity is required');
  return value;
};
const number = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ExternalAgentError('invalid_request', 'A valid revision is required');
  return Number(value);
};
export function registerExternalAgentRoutes(
  app: Express,
  service: ExternalAgentsService,
  requireAuth: RequestHandler,
) {
  const fields: Record<string, string[]> = {
    settings: [],
    configure: ['value', 'expectedRevision', 'key'],
    detect: ['id'],
    list: [],
    children: [],
    'child-presentation': ['operationId'],
    create: ['key', 'configurationId', 'cwd', 'title'],
    read: ['id', 'before'],
    connect: ['id'],
    send: ['id', 'key', 'input'],
    stop: ['id', 'turnId'],
    respond: ['id', 'requestId', 'response'],
    update: ['id', 'expectedRevision', 'patch'],
  };
  for (const [action, allowed] of Object.entries(fields))
    app.post(`/api/external-agents/${action}`, requireAuth, async (req, res) => {
      const controller = new AbortController();
      const close = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', close);
      try {
        const body = object(req.body);
        if (Object.keys(body).some((key) => !allowed.includes(key)))
          throw new ExternalAgentError('invalid_request', 'Unexpected external Agent request field');
        let result: unknown;
        switch (action) {
          case 'settings':
            result = await service.settings(controller.signal);
            break;
          case 'configure':
            result = await service.configure(
              object(body.value) as unknown as Omit<ExternalAgentSettings, 'revision'>,
              number(body.expectedRevision),
              string(body.key),
            );
            break;
          case 'detect':
            result = await service.detect(string(body.id), controller.signal);
            break;
          case 'list':
            result = await service.list(controller.signal);
            break;
          case 'children':
            result = (await service.children()).map((c) => ({
              operationId: c.operation_id,
              conversationId: c.conversation_id,
              parentThreadId: c.parent_thread_id,
              parentBranchId: c.parent_branch_id,
              messageKind: c.message_kind ?? undefined,
              name: c.name,
              avatar: c.avatar ?? undefined,
              harness: c.binding.harness,
              state: c.report && !c.resources_released ? 'settling' : c.state,
              turnId: c.turn_id ?? undefined,
              reportReady: Boolean(c.report) && c.receipt_published,
              acceptedAtMs: c.accepted_at_ms,
              finishedAtMs: c.finished_at_ms ?? undefined,
            }));
            break;
          case 'child-presentation':
            result = await service.childPresentation(string(body.operationId), controller.signal);
            break;
          case 'create':
            result = await service.create({
              key: string(body.key),
              configurationId: string(body.configurationId),
              ...(body.cwd === undefined ? {} : { cwd: string(body.cwd) }),
              ...(body.title === undefined ? {} : { title: string(body.title) }),
            });
            break;
          case 'read':
            result = await service.read(
              string(body.id),
              body.before === undefined ? undefined : number(body.before),
              controller.signal,
            );
            break;
          case 'connect':
            result = await service.connect(string(body.id));
            break;
          case 'send':
            result = await service.send(
              string(body.id),
              string(body.key),
              object(body.input) as unknown as ExternalInput,
            );
            break;
          case 'stop':
            result = await service.stop(string(body.id), string(body.turnId));
            break;
          case 'respond':
            result = await service.respond(string(body.id), string(body.requestId), object(body.response));
            break;
          case 'update': {
            const patch = object(body.patch);
            if (
              Object.keys(patch).some((key) => !['title', 'pinned', 'archived', 'deleted'].includes(key)) ||
              Object.entries(patch).some(([key, value]) =>
                key === 'title' ? typeof value !== 'string' : typeof value !== 'boolean',
              )
            )
              throw new ExternalAgentError('invalid_request', 'Invalid conversation update');
            result = await service.update(string(body.id), number(body.expectedRevision), patch);
            break;
          }
        }
        if (!res.destroyed) res.json(result ?? {});
      } catch (error) {
        if (res.destroyed || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        res
          .status(
            error instanceof ExternalAgentError
              ? error.status
              : message.includes('conflict:')
                ? 409
                : message.includes('not found:')
                  ? 404
                  : 503,
          )
          .json({
            code: error instanceof ExternalAgentError ? error.code : 'external_agent_failed',
            error: message,
          });
      } finally {
        res.off('close', close);
      }
    });
  app.get('/api/external-agents/observe', requireAuth, async (req, res) => {
    try {
      const id = string(req.query.id);
      if (id !== '*') await service.read(id);
      if (res.destroyed) return;
      res
        .status(200)
        .set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders();
      const close = service.subscribe(id, (event) => {
        const writable = res.write(`data: ${JSON.stringify(event)}\n\n`);
        // A slow reader reconnects to a current snapshot; it does not hold the harness.
        if (!writable) res.end();
        return writable;
      });
      res.once('close', close);
      if (res.destroyed) close();
    } catch (error) {
      if (!res.destroyed)
        res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
