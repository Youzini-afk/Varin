import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { currentRequestPrincipal } from '../kernel/request-principal.js';
import type { BotGroupChats } from './bot-group-chat.js';

export function registerBotGroupChatRoutes(app: Express, groups: BotGroupChats) {
  const root = '/api/harness/bots/group-chats';
  const handle = (run: (principal: string | null, request: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await run(currentRequestPrincipal() ?? null, req) ?? { ok: true });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: status < 500 && error instanceof Error ? error.message : 'Group chat storage or execution is unavailable' });
    }
  };
  const id = (request: Request) => String(request.params.group);
  const query = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  app.get(root, handle(principal => groups.list(principal)));
  app.post(root, handle((principal, req) => groups.create(principal, req.body?.name, req.body?.members)));
  app.get(root + '/:group', handle((principal, req) => groups.page(principal, id(req), query(req.query.before), query(req.query.q))));
  app.get(root + '/:group/post/:post', handle((principal, req) => groups.postContext(principal, id(req), String(req.params.post))));
  app.post(root + '/:group/post', handle((principal, req) => groups.post(principal, id(req), req.body)));
  app.post(root + '/:group/change', handle((principal, req) => groups.change(principal, id(req), req.body)));
  app.post(root + '/:group/calendar-target', handle((principal, req) => groups.calendarTarget(principal, id(req), req.body?.botId)));
  app.get(root + '/:group/files', handle((principal, req) => groups.files(principal, id(req))));
  app.post(root + '/:group/files', handle(async (principal, req) => {
    const signal = new AbortController();
    req.once('aborted', () => signal.abort());
    return groups.upload(principal, id(req), { id: query(req.query.id) ?? '', filename: query(req.query.filename) ?? '',
      mimeType: query(req.query.mimeType) ?? '', byteLength: Number(query(req.query.byteLength)) }, req, signal.signal);
  }));
  app.get(root + '/:group/files/:file', async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const { info, bytes } = await groups.file(currentRequestPrincipal() ?? null, id(req), String(req.params.file), controller.signal);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.attachment(info.filename);
      res.type('application/octet-stream');
      res.setHeader('Content-Length', info.byteLength);
      await pipeline(Readable.from(bytes), res, { signal: controller.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status((error as { status?: number }).status ?? 500).json({ error: 'Group file unavailable' });
      else if (!res.destroyed) res.destroy();
    }
  });
}
