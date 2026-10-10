import type { Express, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';
import { createScheduledTaskService } from './service.js';
import { KernelClientError } from '../kernel/kernel-client.js';

type ServiceDependencies = Parameters<typeof createScheduledTaskService>[0];

interface ScheduledTaskRouteDependencies extends ServiceDependencies {
  requireAuth: RequestHandler;
  scheduledTaskService?: ReturnType<typeof createScheduledTaskService>;
}

export interface VarinEventRouteDependencies {
  requireAuth: RequestHandler;
  getVarinEventClients: () => Set<Response>;
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
  /**
   * Optional surface bridge (Stage S): when present, `?surface=<id>&kind=<kind>`
   * on the events stream registers a targetable surface connection, and the
   * ack route resolves pending client-settings requests.
   */
  surfaceBridge?: {
    attach(res: Response, surfaceId: string, kind: string, authKey: string, sessionId: string): void;
    bindSession?(authKey: string, sessionId: string, surfaceId: string): void;
    consumeSessionBinding?(authKey: string, sessionId: string, surfaceId: string): boolean;
    isSessionBound?(authKey: string, sessionId: string, surfaceId: string): boolean;
    dropConnection(res: Response): void;
    ack(requestId: string, surfaceId: string, connectionId: string, authKey: string, results: unknown): boolean;
  };
  /** Resolves a UI supplied selection against the Host's live session registry. */
  resolveSurfaceSession?: (sessionId: string, authKey: string) => boolean | Promise<boolean>;
  resolveAuthContext?: (
    req: Request,
    res: Response,
    options?: { allowClientAuth?: boolean; allowUrlToken?: boolean },
  ) => Promise<unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorRecord = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const calendarErrorStatus = (error: unknown): number => {
  if (error instanceof KernelClientError && error.code === 'operation-error' && error.message.startsWith('operation error: conflict:')) return 409;
  const failure = errorRecord(error);
  return typeof failure.statusCode === 'number' ? failure.statusCode : 500;
};

const parseProjectID = (req: Request) => asNonEmptyString(req.params.projectId);
const parseTaskID = (req: Request) => asNonEmptyString(req.params.taskId);

export const registerVarinEventRoutes = (
  app: Express,
  {
    getVarinEventClients,
    writeSseEvent,
    surfaceBridge,
    requireAuth,
    resolveSurfaceSession,
    resolveAuthContext,
  }: VarinEventRouteDependencies,
): void => {
  const authKey = (req: Request, resolved?: unknown): string | null => {
    const auth = resolved ?? req.varinAuth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
    const context = auth as { type?: unknown; clientId?: unknown; token?: unknown };
    const hash = (prefix: string, value: string): string => (
      `${prefix}:${createHash('sha256').update(value).digest('hex')}`
    );
    if (context.type === 'client' && typeof context.clientId === 'string' && context.clientId) return hash('client', context.clientId);
    if (context.type === 'session' && typeof context.token === 'string' && context.token) return hash('session', context.token);
    return null;
  };
  app.get('/api/varin/events', requireAuth, async (req, res) => {
    // The auth middleware establishes access, while this context gives the
    // bridge one stable principal. Resolve it before flushing SSE headers so a
    // failed/changed auth context can still produce an ordinary HTTP response.
    const resolvedAuth = req.varinAuth ?? (resolveAuthContext
      ? await resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: true }).catch(() => null)
      : null);
    if (resolveAuthContext && !resolvedAuth) {
      return res.status(401).json({ error: 'authenticated surface session is unavailable' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const clients = getVarinEventClients();
    clients.add(res);
    // A surface that identifies itself becomes individually addressable for
    // client-owned settings applies (Stage S). Anonymous connections stay
    // broadcast-only — the host never invents a client identity.
    const surfaceId = asNonEmptyString(req.query?.surface);
    const surfaceKind = asNonEmptyString(req.query?.kind);
    const selectedSessionId = asNonEmptyString(req.query?.session);
    let closed = false;
    try {
      writeSseEvent(res, {
        type: 'varin:event-stream-ready',
        properties: { connectedAt: Date.now() },
      });
    } catch {
      // The client can reconnect and receive the next heartbeat.
    }
    const principal = authKey(req, resolvedAuth);
    if (surfaceId && surfaceBridge && principal && selectedSessionId && resolveSurfaceSession) {
      const valid = await resolveSurfaceSession(selectedSessionId, principal)
        && (surfaceBridge.consumeSessionBinding?.(principal, selectedSessionId, surfaceId)
          ?? surfaceBridge.isSessionBound?.(principal, selectedSessionId, surfaceId)
          ?? false);
      if (!closed && valid) {
        surfaceBridge.attach(res, surfaceId, surfaceKind ?? 'web', principal, selectedSessionId);
      }
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'varin:heartbeat',
          properties: { timestamp: Date.now() },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
        surfaceBridge?.dropConnection(res);
      }
    }, 25_000);
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      clients.delete(res);
      surfaceBridge?.dropConnection(res);
    });
  });

  if (surfaceBridge) {
    app.post('/api/varin/client-settings/bind', requireAuth, async (req, res) => {
      const resolvedAuth = req.varinAuth ?? await (resolveAuthContext
        ? resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: true }).catch(() => null)
        : Promise.resolve(null));
      const principal = authKey(req, resolvedAuth);
      const body = asRecord(req.body) ?? {};
      const sessionId = asNonEmptyString(body.sessionId);
      const surfaceId = asNonEmptyString(body.surfaceId);
      if (!principal || !sessionId || !surfaceId || !resolveSurfaceSession || !surfaceBridge.bindSession) {
        return res.status(503).json({ error: 'authenticated surface session binding is unavailable' });
      }
      if (!await resolveSurfaceSession(sessionId, principal)) {
        return res.status(404).json({ error: 'session is not live on this Host' });
      }
      surfaceBridge.bindSession(principal, sessionId, surfaceId);
      return res.json({ ok: true, sessionId, surfaceId });
    });
    app.post('/api/varin/client-settings/ack', requireAuth, async (req, res) => {
      const resolvedAuth = req.varinAuth ?? await (resolveAuthContext
        ? resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: true }).catch(() => null)
        : Promise.resolve(null));
      const body = asRecord(req.body) ?? {};
      const requestId = asNonEmptyString(body.requestId);
      const surfaceId = asNonEmptyString(body.surfaceId);
      const connectionId = asNonEmptyString(body.connectionId);
      const principal = authKey(req, resolvedAuth);
      const results = Array.isArray(body.results) ? body.results : [];
      if (!requestId || !surfaceId || !connectionId || !principal) {
        return res.status(400).json({ error: 'requestId, surfaceId, connectionId and authenticated surface are required' });
      }
      const resolved = surfaceBridge.ack(requestId, surfaceId, connectionId, principal, results as never);
      if (!resolved) {
        return res.status(404).json({ error: 'no pending client-settings request for this id' });
      }
      return res.json({ ok: true });
    });
  }
};

export const registerScheduledTaskRoutes = (app: Express, dependencies: ScheduledTaskRouteDependencies): void => {
  const {
    scheduledTaskService = createScheduledTaskService(dependencies),
    requireAuth,
  } = dependencies;

  app.get('/api/projects/:projectId/scheduled-tasks', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const tasks = await scheduledTaskService.list(projectID);
      return res.json({ tasks });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = asRecord(req.body)?.task;
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      return res.json(await scheduledTaskService.upsert(projectID, taskInput));
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const statusCode = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid')
        ? 400
        : 500;
      if (statusCode === 500) {
        console.error('[ScheduledTasks] failed to save task:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ tasks: await scheduledTaskService.remove(projectID, taskID) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to delete task:', error);
      return res.status(500).json({ error: 'Failed to delete scheduled task' });
    }
  });

  app.get('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({ document: await scheduledTaskService.readLoopDocument(projectID, taskID) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to read loop file:', error);
      return res.status(500).json({ error: 'Failed to read loop file' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json(await scheduledTaskService.updateLoopDocument(projectID, taskID, req.body));
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to write loop file:', error);
      return res.status(500).json({ error: 'Failed to write loop file' });
    }
  });

  app.patch('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      const task = await scheduledTaskService.setLoopEnabled(
        projectID,
        taskID,
        req.body?.enabled,
        req.body?.expectedRevision,
      );
      return res.json({ task });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to update loop file:', error);
      return res.status(500).json({ error: 'Failed to update loop file' });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({
        tasks: await scheduledTaskService.removeLoopFile(projectID, taskID, req.body?.expectedRevision),
      });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to delete loop file:', error);
      return res.status(500).json({ error: 'Failed to delete loop file' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', requireAuth, async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ ok: true, ...await scheduledTaskService.run(projectID, taskID, req.body?.key) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message, ...(failure.task ? { task: failure.task } : {}) });
      console.error('[ScheduledTasks] failed to run task:', error);
      return res.status(calendarErrorStatus(error)).json({ error: 'Failed to run scheduled task' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/occurrences/:occurrenceId/control', requireAuth, async (req, res) => {
    try { return res.json(await scheduledTaskService.controlOccurrence(req.params.projectId, req.params.taskId, req.params.occurrenceId, req.body?.expectedRevision, req.body?.action)); }
    catch (error) { return res.status(calendarErrorStatus(error)).json({ error: error instanceof Error ? error.message : 'Calendar occurrence control failed' }); }
  });
  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/calculation/retry', requireAuth, async (req, res) => {
    try { return res.json(await scheduledTaskService.retryCalculation(req.params.projectId, req.params.taskId, req.body?.expectedRevision)); }
    catch (error) { return res.status(calendarErrorStatus(error)).json({ error: error instanceof Error ? error.message : 'Calendar calculation retry failed' }); }
  });

  app.get('/api/varin/scheduled-tasks/status', requireAuth, async (_req, res) => {
    try {
      return res.json(await scheduledTaskService.globalStatus());
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve scheduled task status' });
    }
  });

};
