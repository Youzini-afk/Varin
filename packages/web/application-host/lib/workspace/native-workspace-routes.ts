import type { Express, RequestHandler } from 'express';
import type { NativeWorkspaceOwner } from '../kernel/native-workspaces.js';
export function registerNativeWorkspaceRoutes(app: Express, owner: NativeWorkspaceOwner, requireAuth: RequestHandler) {
    app.post('/api/projects/:projectId/workspace/:action', requireAuth, async (request, response) => {
        const controller = new AbortController();
        const close = () => {
            if (!response.writableEnded)
                controller.abort();
        };
        response.once('close', close);
        try {
            const id = String(request.params.projectId), action = String(request.params.action);
            if (!['inspect', 'enable', 'disable'].includes(action)) {
                response.status(400).json({ message: 'Unknown workspace action' });
                return;
            }
            if (action === 'enable')
                await owner.enable(id, controller.signal);
            if (action === 'disable')
                await owner.disable(id);
            const latest = await owner.inspectProject(id, controller.signal);
            const view = latest?.view;
            response.json({ workspace: latest?.workspace ?? null, executionPath: view?.mount?.path ?? null, mountState: view?.mount?.state ?? null,
                leases: view?.leases ?? 0, capabilities: view?.capabilities ?? null, progress: latest.progress, preparing: latest.preparing });
        }
        catch (error) {
            if (!response.destroyed)
                response.status(409).json({ code: (error as {
                        code?: string;
                    }).code ?? 'native_workspace_unavailable', message: error instanceof Error ? error.message : 'Workspace is unavailable' });
        }
        finally {
            response.removeListener('close', close);
        }
    });
}
