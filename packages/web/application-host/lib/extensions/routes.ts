import { createHash } from 'node:crypto';
import {
  ExtensionCatalogRevisionConflictError,
  ExtensionUpdateReadinessError,
  ExtensionCatalogStorageError,
  ExtensionStorageRevisionConflictError,
  ExtensionStorageError,
} from '@varin/extension-host';
import type {
  ApplicationExtensionCatalog,
  ApplicationExtensionRuntime,
  ExtensionPackageManager,
} from '@varin/extension-host';
import type { Express, Request, RequestHandler, Response } from 'express';
import { projectContainsPath, type RuntimeContractContext, type ProjectFolders } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import { isDocumentAuthorityError } from '../documents/errors.js';
import {
  VarinExtensionContractError,
  parseVarinRuntimeContractRequest,
  type VarinRuntimeContractScope,
  parseVarinExtensionActualState,
  parseVarinExtensionCandidateCapabilityReviewRequest,
  parseVarinExtensionCapabilityReviewRequest,
  parseVarinExtensionHostStateWaitRequest,
  parseVarinExtensionLocalSourceReloadRequest,
  parseVarinExtensionPackageSource,
  parseVarinExtensionRemoveRequest,
} from '@varin/extension-contract';
import { renderExtensionRecoveryPage } from './recovery-page.js';

interface ExtensionRouteDependencies {
  extensionCatalog: ApplicationExtensionCatalog;
  extensionPackages: ExtensionPackageManager;
  extensionRuntime?: ApplicationExtensionRuntime | null;
  documents?: Pick<DocumentAuthority, 'lookupWorkspacePath'>;
  readProjects?: () => Promise<Array<ProjectFolders & { id: string }>>;
  uiAuthController: {
    requireAuth: RequestHandler;
    requireSessionAuth: RequestHandler;
    resolveAuthContext?(req: Request, res: Response, options?: { allowClientAuth?: boolean; allowUrlToken?: boolean }): Promise<unknown>;
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const catalogError = (error: unknown) => ({
  supported: true,
  status: 'error',
  error: {
    code: error instanceof ExtensionCatalogStorageError ? error.code : 'catalog_read_failed',
    message: error instanceof ExtensionCatalogStorageError
      ? error.message
      : 'Failed to read Varin extension catalog',
    retryable: error instanceof ExtensionCatalogStorageError ? error.retryable : true,
  },
});

const expectedRevision = (body: unknown): number | null => {
  const value = asRecord(body)?.expectedRevision;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const routeParam = (value: string | string[] | undefined): string => (
  typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : ''
);

class ExtensionRequestDisconnectedError extends Error {}

const withRequestSignal = async <Result>(
  req: Request,
  res: Response,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new ExtensionRequestDisconnectedError('Extension request disconnected'));
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  if (req.aborted || res.destroyed || res.writableEnded) controller.abort(new ExtensionRequestDisconnectedError('Extension request disconnected'));
  try {
    return await operation(controller.signal);
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
};

const sendMutationError = (res: Response, error: unknown) => {
  if (error instanceof ExtensionUpdateReadinessError) {
    return res.status(409).json({ error: { code: error.code, message: error.message, retryable: true } });
  }
  if (error instanceof ExtensionCatalogRevisionConflictError || error instanceof ExtensionStorageRevisionConflictError) {
    return res.status(409).json({
      error: {
        code: 'revision_conflict',
        message: error.message,
        retryable: true,
        actualRevision: error.actualRevision,
        expectedRevision: error.expectedRevision,
      },
    });
  }
  if (error instanceof ExtensionCatalogStorageError) {
    return res.status(500).json({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  }
  if (error instanceof ExtensionStorageError) {
    return res.status(500).json({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  }
  if (error instanceof VarinExtensionContractError) {
    return res.status(400).json({
      error: { code: 'invalid_request', details: error.issues, message: error.message, retryable: false },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const notLocalSource = message.includes('not installed from a local source');
  const localDependenciesMissing = message.includes('Local Varin extension dependencies are not installed');
  const notInstalled = !notLocalSource && message.includes('not installed');
  const managedByDistribution = message.includes('managed by the distribution');
  const mustDisable = message.includes('before removing it');
  const capabilityReviewRequired = message.includes('capabilities require review before activation');
  const status = notInstalled
    ? 404
    : managedByDistribution || mustDisable || capabilityReviewRequired || notLocalSource || localDependenciesMissing
      ? 409
      : 500;
  let code = 'mutation_failed';
  if (notInstalled) code = 'extension_not_found';
  else if (managedByDistribution) code = 'extension_managed_by_distribution';
  else if (mustDisable) code = 'extension_must_be_disabled';
  else if (capabilityReviewRequired) code = 'extension_capability_review_required';
  else if (notLocalSource) code = 'extension_not_local_source';
  else if (localDependenciesMissing) code = 'extension_local_dependencies_missing';
  if (status === 500) console.error('[Varin Extensions] Failed to mutate extension catalog:', error);
  return res.status(status).json({
    error: {
      code,
      message: notInstalled || managedByDistribution || mustDisable || capabilityReviewRequired || notLocalSource || localDependenciesMissing
        ? message
        : 'Failed to update Varin extension catalog',
      retryable: false,
    },
  });
};

export const registerExtensionRoutes = (app: Express, {
  extensionCatalog,
  extensionPackages,
  extensionRuntime,
  documents,
  readProjects,
  uiAuthController,
}: ExtensionRouteDependencies): void => {
  const servicePrincipal = async (req: Request, res: Response): Promise<string | undefined> => {
    const value = req.varinAuth ?? await uiAuthController.resolveAuthContext?.(req, res, { allowClientAuth: true });
    const auth = asRecord(value);
    const identity = auth?.type === 'client' && typeof auth.clientId === 'string' ? auth.clientId
      : auth?.type === 'session' && typeof auth.token === 'string' ? auth.token : undefined;
    return identity ? `${auth!.type}:${createHash('sha256').update(identity).digest('hex')}` : undefined;
  };
  app.post(
    '/api/varin/extensions/v1/contracts/query',
    uiAuthController.requireAuth,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      let request;
      let context: RuntimeContractContext;
      try {
        const body = asRecord(req.body);
        if (!body || Object.keys(body).some((key) => key !== 'request' && key !== 'context')) {
          throw new Error('Contract query requires a request and optional presentation context');
        }
        request = parseVarinRuntimeContractRequest(body.request);
        const raw = body.context === undefined ? {} : asRecord(body.context);
        if (!raw || Object.keys(raw).some((key) => key !== 'directory' && key !== 'surface')) {
          throw new Error('Contract context accepts only directory and surface');
        }
        if (raw.directory !== undefined && (typeof raw.directory !== 'string' || !raw.directory.trim())) {
          throw new Error('Contract directory must be nonempty');
        }
        if (raw.surface !== undefined && raw.surface !== 'web' && raw.surface !== 'desktop' && raw.surface !== 'mobile') {
          throw new Error('Contract surface is invalid');
        }
        context = raw as RuntimeContractContext;
      } catch (error) {
        return res.status(400).json({ error: { code: 'invalid_request', message: error instanceof Error ? error.message : 'Invalid contract query', retryable: false } });
      }
      try {
        const query = async (signal?: AbortSignal) => {
          signal?.throwIfAborted();
          // This is the authenticated User's current-catalog view, not a Run view.
          // Existing workbench and service-routing settings both use the default User.
          const scope: VarinRuntimeContractScope = {
            routing: { userId: 'default' },
            workbench: { surface: context.surface ?? 'web', userId: 'default' },
          };
          if (context.directory !== undefined) {
            if (!documents) return res.status(501).json({ error: { code: 'workspace_authority_unavailable', retryable: true } });
            const workspace = await documents.lookupWorkspacePath(context.directory);
            signal?.throwIfAborted();
            const project = (await readProjects?.())?.find((entry) => projectContainsPath(entry, workspace.canonicalPath));
            signal?.throwIfAborted();
            // Service routing retains its existing canonical-directory namespace;
            // workbench layout uses only an existing Documents ID. A query never creates one.
            // Neither namespace grants source access.
            scope.routing = { userId: 'default', workspaceId: workspace.canonicalPath, ...(project ? { projectId: project.id } : {}) };
            if (workspace.workspaceId) scope.workbench = { ...scope.workbench!, workspaceId: workspace.workspaceId };
          }
          const result = await extensionRuntime.queryContracts(request, scope, signal);
          signal?.throwIfAborted();
          return res.json(result);
        };
        return request.kind === 'source' ? await withRequestSignal(req, res, query) : await query();
      } catch (error) {
        if (error instanceof ExtensionRequestDisconnectedError) return;
        if (isDocumentAuthorityError(error)) {
          return res.status(error.statusCode).json({ error: { code: error.code, message: error.message, retryable: false } });
        }
        return res.status(500).json({ error: { code: 'contract_query_failed', message: 'Failed to read runtime contracts', retryable: true } });
      }
    },
  );

  app.get('/extensions/recovery', uiAuthController.requireSessionAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderExtensionRecoveryPage());
  });

  app.get('/api/varin/extensions/v1/catalog', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ supported: true, status: 'ready', snapshot: await extensionCatalog.snapshot() });
    } catch (error) {
      console.error('[Varin Extensions] Failed to read extension catalog:', error);
      res.status(500).json(catalogError(error));
    }
  });

  app.get('/api/varin/extensions/v1/host-state', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime.state());
    } catch (error) {
      return res.status(500).json(catalogError(error));
    }
  });

  app.post(
    '/api/varin/extensions/v1/host-state/wait',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('Extension host-state client disconnected')); };
      res.once('close', abort);
      try {
        return res.json(await extensionRuntime.waitForState(parseVarinExtensionHostStateWaitRequest(req.body), controller.signal));
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        return res.status(400).json({ error: { code: 'host_state_wait_failed', message: error instanceof Error ? error.message : String(error), retryable: true } });
      } finally {
        res.off('close', abort);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/extensions/:extensionId/activate',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        await extensionRuntime.activateExtension(routeParam(req.params.extensionId));
        return res.status(204).end();
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/assets/read',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        return res.json(await extensionPackages.readAsset(req.body));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('not installed') || message.includes('does not contain') ? 404 : 400;
        return res.status(status).json({ error: { code: 'asset_unavailable', message, retryable: false } });
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/entrypoints/read',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        return res.json(await extensionPackages.readManagedEntrypoint(req.body));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('not installed') || message.includes('not present') ? 404 : 400;
        return res.status(status).json({ error: { code: 'entrypoint_unavailable', message, retryable: false } });
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/prepare',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const integrity = typeof req.body?.candidateIntegrity === 'string' ? req.body.candidateIntegrity : '';
        if (!extensionId || !integrity) throw new Error('extensionId and candidateIntegrity are required');
        return res.json(await withRequestSignal(req, res, signal => extensionRuntime.prepareCandidate(extensionId, integrity, signal)));
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/discard-prepared',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const integrity = typeof req.body?.candidateIntegrity === 'string' ? req.body.candidateIntegrity : '';
        if (!extensionId || !integrity) throw new Error('extensionId and candidateIntegrity are required');
        await extensionRuntime.discardPreparedCandidate(extensionId, integrity);
        return res.status(204).end();
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/discard',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.discardCandidate(req.body) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/review-capabilities',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parseVarinExtensionCapabilityReviewRequest(req.body);
        return res.json({ snapshot: await (extensionRuntime
          ? extensionRuntime.reviewCapabilities(request)
          : extensionCatalog.reviewCapabilities(request)) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/review-capabilities',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parseVarinExtensionCandidateCapabilityReviewRequest(req.body);
        return res.json({ snapshot: await (extensionRuntime
          ? extensionRuntime.reviewCandidateCapabilities(request)
          : extensionCatalog.reviewCandidateCapabilities(request)) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/request-application',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.requestCandidateApplication(req.body) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/candidates/select',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        if (!extensionRuntime) {
          // A catalog-only recovery route cannot attest a prepared Host/Surface group.
          const snapshot = await extensionCatalog.snapshot();
          const entry = snapshot.extensions.find(value => value.manifest.id === req.body?.extensionId);
          if (entry?.desired.enabled && entry.candidate?.manifest.updateReadiness) {
            throw new ExtensionUpdateReadinessError('required_surface_readiness', 'A running application Host and compatible Surface must prepare this update group');
          }
          return res.json({ snapshot: await extensionPackages.selectCandidate(req.body) });
        }
        return res.json({ snapshot: await withRequestSignal(req, res, signal => extensionRuntime.selectCandidate(req.body, signal)) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/actual',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const state = parseVarinExtensionActualState(req.body?.state);
        await (extensionRuntime
          ? extensionRuntime.reportActualState(extensionId, state)
          : extensionPackages.reportActualState(extensionId, state));
        return res.status(204).end();
      } catch (error) {
        return res.status(409).json({
          error: {
            code: 'actual_state_rejected',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        });
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/install',
    uiAuthController.requireAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null) {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'expectedRevision is required', retryable: false } });
      }
      try {
        const source = parseVarinExtensionPackageSource(req.body?.source);
        const snapshot = await withRequestSignal(req, res, (signal) => extensionRuntime
          ? extensionRuntime.installOrStage({ expectedRevision: revision, source }, signal)
          : extensionPackages.installOrStage(source, revision, signal));
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/extensions/:extensionId/reload-local-source',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parseVarinExtensionLocalSourceReloadRequest({
          ...req.body,
          extensionId: routeParam(req.params.extensionId),
        });
        const result = await withRequestSignal(req, res, (signal) => extensionRuntime
          ? extensionRuntime.reloadLocalSource(request, signal)
          : extensionPackages.reloadLocalSource(request, signal));
        return res.json(result);
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/services/invoke',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('Host service client disconnected')); };
      res.once('close', abort);
      try {
        const principal = asRecord(req.body)?.lease ? await servicePrincipal(req, res) : undefined;
        return res.json({ result: await extensionRuntime.invokeService(req.body, controller.signal, principal) });
      } catch (error) {
        return res.status(400).json({
          error: {
            code: 'service_invocation_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        });
      } finally {
        res.off('close', abort);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/services/lease',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      const principal = await servicePrincipal(req, res);
      if (!principal) return res.status(401).json({ error: { code: 'surface_owner_unavailable', retryable: false } });
      const controller = new AbortController();
      const abort = () => controller.abort(new ExtensionRequestDisconnectedError('Surface service lease disconnected'));
      req.once('aborted', abort); res.once('close', abort);
      if (req.aborted || res.destroyed || res.writableEnded) abort();
      const emit = (event: import('@varin/extension-contract').VarinSurfaceServiceLeaseEvent) => {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) throw new ExtensionRequestDisconnectedError('Surface service lease disconnected');
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.();
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try { await extensionRuntime.watchServiceLease(req.body, principal, emit, controller.signal); }
      catch (error) { if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
      finally { req.off('aborted', abort); res.off('close', abort); if (!res.destroyed && !res.writableEnded) res.end(); }
    },
  );

  const serviceRoutingMutation = (
    method: 'removeServiceRoutingRule' | 'upsertServiceRoutingRule',
  ): RequestHandler => async (req, res) => {
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime[method](req.body));
    } catch (error) {
      return sendMutationError(res, error);
    }
  };

  app.put(
    '/api/varin/extensions/v1/services/routing',
    uiAuthController.requireAuth,
    serviceRoutingMutation('upsertServiceRoutingRule'),
  );

  app.post(
    '/api/varin/extensions/v1/services/routing/remove',
    uiAuthController.requireAuth,
    serviceRoutingMutation('removeServiceRoutingRule'),
  );

  const workbenchMutation = (
    method: 'removeWorkbenchProfile' | 'selectWorkbenchProfile' | 'updateWorkbenchLayout' | 'upsertWorkbenchProfile',
  ): RequestHandler => async (req, res) => {
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime[method](req.body));
    } catch (error) {
      return sendMutationError(res, error);
    }
  };

  app.patch(
    '/api/varin/extensions/v1/workbench/layout',
    uiAuthController.requireAuth,
    workbenchMutation('updateWorkbenchLayout'),
  );

  app.patch(
    '/api/varin/extensions/v1/workbench/profile/select',
    uiAuthController.requireAuth,
    workbenchMutation('selectWorkbenchProfile'),
  );

  app.post(
    '/api/varin/extensions/v1/workbench/profiles/apply',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.applyWorkbenchProfile(req.body) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.put(
    '/api/varin/extensions/v1/workbench/profiles',
    uiAuthController.requireAuth,
    workbenchMutation('upsertWorkbenchProfile'),
  );

  app.post(
    '/api/varin/extensions/v1/workbench/profiles/remove',
    uiAuthController.requireAuth,
    workbenchMutation('removeWorkbenchProfile'),
  );

  app.patch(
    '/api/varin/extensions/v1/extensions/:extensionId/enabled',
    uiAuthController.requireAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null || typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'enabled and expectedRevision are required', retryable: false } });
      }
      try {
        const snapshot = extensionRuntime
          ? await extensionRuntime.setEnabled(routeParam(req.params.extensionId), req.body.enabled, revision)
          : await extensionCatalog.setEnabled(routeParam(req.params.extensionId), req.body.enabled, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.delete(
    '/api/varin/extensions/v1/extensions/:extensionId',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const request = parseVarinExtensionRemoveRequest({
          ...req.body,
          extensionId: routeParam(req.params.extensionId),
        });
        return res.json({ snapshot: await extensionRuntime.removeExtension(request) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/varin/extensions/v1/disable-all',
    uiAuthController.requireSessionAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null) {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'expectedRevision is required', retryable: false } });
      }
      try {
        const snapshot = extensionRuntime
          ? await extensionRuntime.setAllEnabled(false, revision)
          : await extensionCatalog.setAllEnabled(false, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );
};
