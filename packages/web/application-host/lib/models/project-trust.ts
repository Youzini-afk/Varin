import { realpath } from 'node:fs/promises';
import type { Express, RequestHandler } from 'express';
import { projectTrustFile, projectTrustDecision, validateProjectTrust, readProjectTrust } from '@varin/settings-store';
import { ConfigurationFile, ModelConfigurationError, object } from './configuration.js';

/** One native trust transaction owner. A path from a request is never an admission grant. */
export class ProjectTrustService {
  readonly file: ConfigurationFile<Record<string, boolean>>;
  constructor(readonly dataDirectory: string, readonly admitWorkspace: (workspaceId: string, signal?: AbortSignal) => Promise<{ canonicalPath: string }>) {
    this.file = new ConfigurationFile(projectTrustFile(dataDirectory), validateProjectTrust);
  }
  trusted(cwd: string): boolean { return readProjectTrust(this.dataDirectory, cwd) === true; }
  async snapshot(workspaceId: string, signal?: AbortSignal) {
    const root = await realpath((await this.admitWorkspace(workspaceId, signal)).canonicalPath);
    signal?.throwIfAborted();
    const current = await this.file.read();
    return { workspaceId, path: root, decision: projectTrustDecision(current.document, root),
      directDecision: Object.hasOwn(current.document, root) ? current.document[root]! : null, revision: current.revision };
  }
  async update(input: { workspaceId: string; expectedRevision: string; decision: boolean | null }, signal?: AbortSignal) {
    if (typeof input.workspaceId !== 'string' || !input.workspaceId || typeof input.expectedRevision !== 'string'
      || input.decision !== null && typeof input.decision !== 'boolean') throw new ModelConfigurationError('invalid_project_trust', 'Invalid project trust update');
    const current = await this.snapshot(input.workspaceId, signal);
    signal?.throwIfAborted();
    await this.file.update(input.expectedRevision, document => {
      if (input.decision === null) delete document[current.path]; else document[current.path] = input.decision;
      return document;
    });
    return this.snapshot(input.workspaceId, signal);
  }
}

export function registerProjectTrustRoutes(app: Express, trust: ProjectTrustService, requireAuth: RequestHandler) {
  for (const action of ['read', 'update'] as const) app.post(`/api/project-trust/${action}`, requireAuth, async (request, response) => {
    const controller = new AbortController();
    const close = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', close);
    try {
      const input: unknown = request.body;
      if (!object(input) || typeof input.workspaceId !== 'string' || !input.workspaceId) throw new ModelConfigurationError('invalid_project_trust', 'Select an admitted workspace');
      response.json(action === 'read' ? await trust.snapshot(input.workspaceId, controller.signal)
        : await trust.update(input as Parameters<ProjectTrustService['update']>[0], controller.signal));
    } catch (error) {
      if (error instanceof ModelConfigurationError) response.status(error.status).json({ code: error.code, message: error.message });
      else response.status(503).json({ code: 'project-trust-unavailable', message: 'Project trust could not be read or saved.' });
    } finally { response.removeListener('close', close); }
  });
}
