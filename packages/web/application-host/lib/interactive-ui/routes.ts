import { assertRequestAccess } from '../kernel/request-principal.js';
import type { Express, RequestHandler } from 'express';
import type { ThreadIdentity, UiFragmentRegistrationInput, UiObservation, UiSelection, UiSourceIdentity, UiViewState } from '@varin/application-client';
import type { InteractiveUiRuntime } from './runtime.js';
import { UiContentError } from './store.js';

export function registerInteractiveUiRoutes(app: Express, runtime: InteractiveUiRuntime, requireAuth: RequestHandler) {
  const validateSourceScope = (body: Record<string, unknown>, source: UiSourceIdentity) => {
    const fragment = source?.preview?.messageFragment;
    if (fragment && (fragment.threadId !== body.threadId || fragment.branchId !== body.branchId)) throw new UiContentError('Preview belongs to another conversation', 403);
  };
  const actions: Record<string, (root: string, body: Record<string, unknown>, signal: AbortSignal) => unknown> = {
    'fragment/register': (_root, body, signal) => runtime.registerFragment(body as unknown as ThreadIdentity, body as unknown as UiFragmentRegistrationInput, signal),
    source: (root, body) => runtime.store.source(root, String(body.ref)),
    'view/attach': (root, body, signal) => { if (typeof body.clientId !== 'string' || !body.clientId) throw new UiContentError('View client identity is required');
      validateSourceScope(body, body.source as UiSourceIdentity);
      return runtime.attach(root, body.source as UiSourceIdentity, body.viewRef as string | undefined, body.clientId, signal, { threadId: String(body.threadId), branchId: String(body.branchId) }); },
    'view/detach': (root, body) => runtime.detach(root, String(body.viewRef), String(body.token), body.state as UiViewState | undefined),
    'view/state': (root, body) => runtime.state(root, String(body.viewRef), String(body.token), body.state as UiViewState),
    'view/reply': (root, body) => runtime.reply(root, String(body.viewRef), String(body.token), String(body.id), body.observation as UiObservation | undefined, body.error as string | undefined),
    select: (root, body) => { validateSourceScope(body, body.observation as UiObservation); return runtime.store.select(root, body.observation as UiObservation, body.selection as { text?: string; region?: UiSelection['region'] }, { threadId: String(body.threadId), branchId: String(body.branchId) }); },
    selection: (root, body) => runtime.store.selection(root, String(body.ref)),
    'selection/release': (root, body) => runtime.releaseSelection(root, String(body.ref), { threadId: String(body.threadId), branchId: String(body.branchId) }),
  };
  app.get('/api/interactive-ui/view/observe', requireAuth, async (req, res) => {
    const abort = new AbortController(); res.once('close', () => abort.abort());
    let root: string | undefined;
    const viewRef = String(req.query.viewRef), token = String(req.query.token);
    try {
      if (typeof req.query.threadId !== 'string' || typeof req.query.branchId !== 'string') throw new UiContentError('Conversation identity is required');
      await assertRequestAccess({ threads: [req.query.threadId] }, 'read');
      root = await runtime.target({ threadId: req.query.threadId, branchId: req.query.branchId });
      await runtime.validateViewScope(root, viewRef, { threadId: req.query.threadId, branchId: req.query.branchId });
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.flushHeaders();
      while (!abort.signal.aborted) {
        await runtime.target({ threadId: req.query.threadId, branchId: req.query.branchId });
        const request = await runtime.poll(root, viewRef, token, abort.signal);
        if (!res.write(request ? `data: ${JSON.stringify(request)}\n\n` : ': heartbeat\n\n')) break;
      }
    } catch (error) {
      if (!res.headersSent) res.status(error instanceof UiContentError ? error.status : error && typeof error === 'object' && 'code' in error && error.code === 'forbidden' ? 403 : 500).json({ message: 'View observation unavailable' });
    } finally { abort.abort(); if (root) runtime.disconnect(root, viewRef, token); if (!res.destroyed) res.end(); }
  });
  for (const [action, handle] of Object.entries(actions)) app.post(`/api/interactive-ui/${action}`, requireAuth, async (req, res) => {
    const controller = new AbortController(); const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    try {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== 'object' || body.runtime !== 'agent' || typeof body.threadId !== 'string' || typeof body.branchId !== 'string') throw new UiContentError('Conversation identity is required');
      await assertRequestAccess({ threads: [body.threadId] }, action === 'source' || action === 'selection' ? 'read' : 'write');
      const root = await runtime.target(body as unknown as ThreadIdentity);
      const viewRef = action === 'select' ? (body.observation as UiObservation | undefined)?.viewRef : action.startsWith('view/') && action !== 'view/attach' ? body.viewRef : undefined;
      if (typeof viewRef === 'string') await runtime.validateViewScope(root, viewRef, { threadId: body.threadId, branchId: body.branchId });
      const result = await handle(root, body, controller.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) { if (!res.destroyed) res.status(error instanceof UiContentError ? error.status : error && typeof error === 'object' && 'code' in error && error.code === 'forbidden' ? 403 : 500).json({ message: error instanceof UiContentError ? error.message : 'Interactive content is unavailable' }); }
    finally { res.removeListener('close', close); }
  });
}
