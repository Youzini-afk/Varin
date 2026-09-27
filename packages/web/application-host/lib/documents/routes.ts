import { isDocumentAuthorityError } from './errors.js';
import type { Express, Request, RequestHandler, Response } from 'express';

interface DocumentAuthority {
  resolveWorkspace(input: unknown): Promise<unknown>;
  resolveResourceIdentity(resource: unknown): Promise<unknown>;
  read(resource: unknown): Promise<unknown>;
  write(request: unknown): Promise<unknown>;
  move(request: unknown): Promise<unknown>;
  delete(request: unknown): Promise<unknown>;
  publishDirtyBuffers(request: unknown): Promise<unknown>;
  clearDirtyBuffers(request: unknown): Promise<unknown>;
  acknowledgeDirtyStateBarrier(request: unknown): Promise<unknown>;
  captureAgentInputSnapshot(request: unknown): Promise<unknown>;
  releaseAgentInputSnapshot(sessionId: unknown, context: unknown): unknown;
  readSurfaceOperation(request: unknown): Promise<unknown>;
  completeSurfaceOperation(request: unknown): Promise<unknown>;
  inspectWorkspace(workspaceId: string): Promise<unknown>;
  watch(workspaceId: string, listener: (event: unknown) => void): { close(): void };
  registerDirtySurface(request: unknown, listener: (event: unknown) => void): { close(): void };
  listRecoveryJournals(request: unknown): Promise<unknown>;
  readRecoveryJournal(journalId: string): Promise<unknown>;
  writeRecoveryJournal(request: unknown): Promise<unknown>;
  deleteRecoveryJournal(request: unknown): Promise<unknown>;
}

interface UiAuthController {
  requireAuth?: RequestHandler;
}

interface DocumentRoutesOptions {
  documents: DocumentAuthority;
  uiAuthController?: UiAuthController;
}

const sendError = (res: Response, error: unknown): Response => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
      ...(error.currentEpoch ? { currentEpoch: error.currentEpoch } : {}),
    });
  }
  const message = error instanceof Error ? error.message : 'Document request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req: Request): Record<string, unknown> => (
  req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
);

const flushResponse = (res: Response): void => {
  (res as Response & { flush?: (() => void) | undefined }).flush?.();
};

export const registerDocumentRoutes = (app: Express, {
  documents,
  uiAuthController,
}: DocumentRoutesOptions) => {
  const requireAuth: RequestHandler = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/documents/workspace/resolve', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.resolveWorkspace(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/read', requireAuth, async (req: Request, res: Response) => {
    try {
      const resource = readBody(req).resource;
      if (!resource) return res.status(400).json({ error: 'Resource is required', reason: 'failed' });
      return res.json(await documents.read(resource));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/write', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.write(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/move', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.move(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/delete', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.delete(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/publish', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.publishDirtyBuffers(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/clear', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.clearDirtyBuffers(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/barrier/ack', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.acknowledgeDirtyStateBarrier(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/resource/identity', requireAuth, async (req: Request, res: Response) => {
    try {
      const resource = readBody(req).resource;
      if (!resource) return res.status(400).json({ error: 'Resource is required', reason: 'failed' });
      return res.json(await documents.resolveResourceIdentity(resource));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/agent-input/capture', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.captureAgentInputSnapshot(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/agent-input/release', requireAuth, async (req: Request, res: Response) => {
    try {
      const body = readBody(req);
      return res.json(await documents.releaseAgentInputSnapshot(body.sessionId, body.context));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/surface-operation/read', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.readSurfaceOperation(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/surface-operation/complete', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.completeSurfaceOperation(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/documents/watch', requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
    }
    const dirtyOwnerId = typeof req.query?.dirtyOwnerId === 'string' ? req.query.dirtyOwnerId : '';
    const dirtyOwnerGenerationRaw = typeof req.query?.dirtyOwnerGeneration === 'string'
      ? req.query.dirtyOwnerGeneration
      : '';
    const dirtyOwnerGeneration = dirtyOwnerGenerationRaw === '' ? null : Number(dirtyOwnerGenerationRaw);
    if ((dirtyOwnerId && dirtyOwnerGeneration === null)
      || (!dirtyOwnerId && dirtyOwnerGeneration !== null)
      || (dirtyOwnerGeneration !== null && (!Number.isSafeInteger(dirtyOwnerGeneration) || dirtyOwnerGeneration < 0))) {
      return res.status(400).json({ error: 'Dirty owner identity is malformed', reason: 'failed' });
    }

    try {
      await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return sendError(res, error);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(':heartbeat\n\n');
        flushResponse(res);
      } catch {
        closed = true;
      }
    }, 15000);

    const sendEvent = (event: unknown) => {
      if (closed) return;
      try {
        const payload = JSON.stringify(event);
        if (payload.includes('"content":')) return;
        res.write(`data: ${payload}\n\n`);
        flushResponse(res);
      } catch {
        closed = true;
      }
    };
    const subscription = documents.watch(workspaceId, sendEvent);
    const dirtySubscription = dirtyOwnerId
      ? documents.registerDirtySurface({
          generation: dirtyOwnerGeneration,
          ownerId: dirtyOwnerId,
          workspaceId,
        }, sendEvent)
      : null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.close();
      dirtySubscription?.close();
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
  });

  app.post('/api/documents/recovery/list', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json({ journals: await documents.listRecoveryJournals(readBody(req)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/read', requireAuth, async (req: Request, res: Response) => {
    try {
      const journalId = readBody(req).journalId;
      if (typeof journalId !== 'string' || !journalId) {
        return res.status(400).json({ error: 'journalId is required', reason: 'failed' });
      }
      return res.json(await documents.readRecoveryJournal(journalId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/write', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.writeRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/delete', requireAuth, async (req: Request, res: Response) => {
    try {
      return res.json(await documents.deleteRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });
};
