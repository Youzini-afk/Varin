import { randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { ExternalAccessAction, ExternalAccessSnapshot } from '@varin/application-client';
import { ExternalAccessConfigurationError, parseExternalAccessConfiguration, type ExternalAccessConfiguration } from './external-access-config.js';

const root = '/api/varin/external-access';

export function registerExternalAccessRoutes(app: Express, dependencies: {
  json: ReturnType<typeof import('express').json>;
  authorize(request: Request, operation: 'read' | 'write'): boolean | Promise<boolean>;
  snapshot(includeOperatorDetails?: boolean): Promise<ExternalAccessSnapshot>;
  includeOperatorDetails?(request: Request): boolean;
  save(configuration: ExternalAccessConfiguration, expectedRevision: number): Promise<unknown>;
  actions: Record<ExternalAccessAction, (expectedRevision: number) => Promise<unknown>>;
}) {
  const { json, authorize, snapshot, save, actions } = dependencies;
  const handle = (operation: 'read' | 'write', action: (request: Request) => Promise<unknown>) =>
    async (request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'no-store');
      try {
        if (!await authorize(request, operation)) {
          response.status(403).json({ error: 'Manage external access from the local Host settings.' });
          return;
        }
        if (operation === 'write') {
          if ((await snapshot()).source !== 'settings') {
            response.status(409).json({ error: 'This listener is managed by the Host environment.' });
            return;
          }
          await action(request);
        }
        response.json(await snapshot(dependencies.includeOperatorDetails?.(request) === true));
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (error instanceof ExternalAccessConfigurationError || code === 'invalid_config') {
          response.status(400).json({ error: error instanceof ExternalAccessConfigurationError ? error.message : 'Invalid external access configuration.' });
        } else if (code === 'revision_conflict' || code === 'not_enabled' || code === 'not_configured') {
          response.status(409).json({ error: 'The saved configuration or enable intent has changed. Reload and try again.' });
        } else if (code === 'shutting_down') {
          response.status(503).json({ error: 'The Host is shutting down.' });
        } else {
          next(error);
        }
      }
    };
  const revision = (value: unknown, allowNew: boolean): number => {
    if (value === null && allowNew) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new ExternalAccessConfigurationError('Supply the revision from the latest saved configuration.');
    }
    return value;
  };
  app.get(root, handle('read', async () => undefined));
  app.put(root, json, handle('write', async (request) => {
    const expectedRevision = revision(request.body?.expectedRevision, true);
    const current = await snapshot();
    const id = current.entry?.configuration.id ?? randomUUID();
    await save(parseExternalAccessConfiguration(request.body?.configuration, id), expectedRevision);
  }));
  for (const action of ['enable', 'disable', 'retry'] as const) {
    app.post(`${root}/${action}`, json, handle('write', async request => {
      await actions[action](revision(request.body?.expectedRevision, false));
    }));
  }
}
