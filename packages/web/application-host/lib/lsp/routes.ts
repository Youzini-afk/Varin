import { isDocumentAuthorityError } from '../documents/errors.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { createLanguageSupervisor } from './supervisor.js';
import { SURFACE_LANGUAGE_VIEW } from './supervisor.js';

type LanguageRuntime = ReturnType<typeof createLanguageSupervisor>;

const sendError = (res: Response, error: unknown) => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Language request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

/**
 * The editor owns the `surface` view. A renderer request can never select
 * another view, and the event stream carries only that view's status and
 * diagnostics, so the agent view's answers never reach the editor (D-087).
 */
const readBody = (req: Request): Record<string, unknown> => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  return { ...body, view: SURFACE_LANGUAGE_VIEW };
};
const stringField = (value: unknown): string => typeof value === 'string' ? value : '';
const isSurfaceViewEvent = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  const record = event as { view?: unknown; snapshot?: { view?: unknown } };
  const view = record.view ?? record.snapshot?.view;
  return view === undefined || view === SURFACE_LANGUAGE_VIEW;
};

const FEATURES = new Set([
  'completion',
  'completionResolve',
  'hover',
  'signatureHelp',
  'definition',
  'references',
  'documentSymbols',
  'workspaceSymbols',
  'rename',
  'codeActions',
  'codeActionResolve',
  'executeCommand',
  'documentFormatting',
  'documentRangeFormatting',
  'onTypeFormatting',
  'semanticTokens',
  'inlayHints',
  'inlayHintResolve',
  'documentHighlights',
  'foldingRanges',
  'selectionRanges',
  'documentLinks',
  'documentLinkResolve',
  'documentColors',
  'colorPresentations',
]);

export const registerLanguageRoutes = (app: Express, {
  language,
  uiAuthController,
}: {
  language: LanguageRuntime;
  uiAuthController?: { requireAuth?: RequestHandler };
}): void => {
  const requireAuth = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/language/status', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(language.getStatus(stringField(body.workspaceId), stringField(body.languageId)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/sync', requireAuth, async (req, res) => {
    try {
      return res.json(await language.syncDocument(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/feature', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      const method = typeof body.method === 'string' ? body.method : '';
      if (!FEATURES.has(method)) {
        return res.status(400).json({ error: 'Unknown language feature', reason: 'failed' });
      }
      const handler = language[method as keyof LanguageRuntime];
      if (typeof handler !== 'function') throw new Error(`Language feature is unavailable: ${method}`);
      const request = body.request && typeof body.request === 'object' && !Array.isArray(body.request)
        ? { ...body.request as Record<string, unknown>, view: SURFACE_LANGUAGE_VIEW }
        : { view: SURFACE_LANGUAGE_VIEW };
      return res.json(await (handler as (request: unknown) => unknown)(request));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/restart', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(await language.restart(stringField(body.workspaceId), stringField(body.languageId)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/dispose-workspace', requireAuth, async (req, res) => {
    try {
      await language.disposeWorkspace(stringField(readBody(req).workspaceId), undefined, SURFACE_LANGUAGE_VIEW);
      return res.json({ status: 'disposed' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/language/events', requireAuth, async (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    const write = (event: unknown): void => {
      if (closed || res.writableEnded || res.destroyed) return;
      if (!isSurfaceViewEvent(event)) return;
      const payload = JSON.stringify(event);
      if (event && typeof event === 'object' && Object.prototype.hasOwnProperty.call(event, 'content')) return;
      res.write(`data: ${payload}\n\n`);
    };
    const subscription = language.subscribe(workspaceId, write);
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        closed = true;
      }
    }, 15000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.close();
    };
    req.on('close', close);
    res.on('close', close);
  });
};
