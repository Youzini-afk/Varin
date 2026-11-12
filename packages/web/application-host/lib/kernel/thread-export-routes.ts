import { assertRequestAccess } from './request-principal.js';
import type { Express, RequestHandler } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exportThreadConversation, type ThreadExportOwners } from './thread-export.js';
export function registerThreadExportRoutes(app: Express, owners: ThreadExportOwners, requireAuth: RequestHandler) {
  app.post('/api/threads/export', requireAuth, async (req, res) => {
    const abort = new AbortController();
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', close);
    const stream = exportThreadConversation(owners, req.body, abort.signal);
    try {
      if (typeof req.body?.threadId === 'string') await assertRequestAccess({ threads: [req.body.threadId] }, 'read');
      // Validate the full selected range before publishing a downloadable response.
      const first = await stream.next();
      if (abort.signal.aborted) return;
      res.setHeader('Content-Type', req.body.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="conversation.${req.body.format === 'json' ? 'json' : 'md'}"`);
      res.setHeader('Cache-Control', 'no-store');
      await pipeline(Readable.from((async function* () { if (!first.done) yield first.value; yield* stream; })()), res, { signal: abort.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(error && typeof error === 'object' && 'code' in error && error.code === 'forbidden' ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Conversation export failed' });
      else if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    } finally { res.off('close', close); await stream.return(undefined); }
  });
}
