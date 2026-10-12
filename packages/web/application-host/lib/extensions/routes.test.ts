import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionCatalogRevisionConflictError } from '@varin/extension-host';
import type { VarinExtensionCatalogSnapshot, VarinExtensionHostStateSnapshot } from '@varin/extension-contract';
import { registerExtensionRoutes } from './routes.js';

type RouteDependencies = Parameters<typeof registerExtensionRoutes>[1];
type CatalogMock = Partial<RouteDependencies['extensionCatalog']>;
type PackageMock = Partial<RouteDependencies['extensionPackages']>;
type RuntimeMock = Partial<NonNullable<RouteDependencies['extensionRuntime']>>;

const snapshot = (enabled = true, revision = 1): VarinExtensionCatalogSnapshot => ({
  schemaVersion: 1,
  hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
  revision,
  loadedAt: '2026-08-14T00:00:00.000Z',
  authoritative: true,
  storageState: 'ready',
  diagnostics: [],
  extensions: [{
    manifest: { schemaVersion: 1, id: 'dev.example.extension', version: '1.0.0', engines: { varin: '>=0.1.0' } },
    source: { kind: 'npm', display: 'npm:dev.example.extension' },
    resolvedVersion: '1.0.0',
    selectedVersion: '1.0.0',
    desired: { enabled, revision, updatedAt: '2026-08-14T00:00:00.000Z' },
    actual: [],
    capabilityGrants: [],
    installedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  }],
});

const createApp = (
  extensionCatalog: CatalogMock,
  extensionPackages: PackageMock = {},
  extensionRuntime?: RuntimeMock,
) => {
  const app = express();
  app.use(express.json());
  registerExtensionRoutes(app, {
    extensionCatalog: extensionCatalog as RouteDependencies['extensionCatalog'],
    extensionPackages: extensionPackages as RouteDependencies['extensionPackages'],
    ...(extensionRuntime
      ? { extensionRuntime: extensionRuntime as NonNullable<RouteDependencies['extensionRuntime']> }
      : {}),
    uiAuthController: {
      requireAuth: (req, res, next) => req.headers['x-test-session'] === 'yes'
        ? next()
        : res.status(401).json({ error: 'Authentication required' }),
      requireSessionAuth: (req, res, next) => req.headers['x-test-session'] === 'yes'
        ? next()
        : res.status(401).json({ error: 'Session authentication required' }),
    },
  });
  return app;
};

describe('Varin extension recovery routes', () => {
  it('serves an authenticated renderer-independent recovery page and read-only catalog', async () => {
    const extensionCatalog = { snapshot: vi.fn(async () => snapshot()) };
    const app = createApp(extensionCatalog);

    await request(app).get('/extensions/recovery').expect(401);
    const page = await request(app).get('/extensions/recovery').set('x-test-session', 'yes').expect(200);
    expect(page.text).toContain('Varin Extension Recovery');
    expect(page.text).toContain('/api/varin/extensions/v1/disable-all');

    const catalog = await request(app).get('/api/varin/extensions/v1/catalog').expect(200);
    expect(catalog.body.status).toBe('ready');
    expect(catalog.body.snapshot.extensions).toHaveLength(1);
  });

  it('requires session auth for mutations and reports revision conflicts', async () => {
    const extensionCatalog = {
      snapshot: vi.fn(async () => snapshot()),
      setEnabled: vi.fn(async () => { throw new ExtensionCatalogRevisionConflictError(1, 2); }),
    };
    const app = createApp(extensionCatalog);
    const path = '/api/varin/extensions/v1/extensions/dev.example.extension/enabled';

    await request(app).patch(path).send({ enabled: false, expectedRevision: 1 }).expect(401);
    const conflict = await request(app)
      .patch(path)
      .set('x-test-session', 'yes')
      .send({ enabled: false, expectedRevision: 1 })
      .expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'revision_conflict', actualRevision: 2, expectedRevision: 1 });
  });

  it('reports capability review as an actionable activation conflict', async () => {
    const extensionCatalog = {
      snapshot: vi.fn(async () => snapshot(false)),
      setEnabled: vi.fn(async () => {
        throw new Error('Varin extension capabilities require review before activation: dev.example.extension');
      }),
    };
    const app = createApp(extensionCatalog);
    const response = await request(app)
      .patch('/api/varin/extensions/v1/extensions/dev.example.extension/enabled')
      .set('x-test-session', 'yes')
      .send({ enabled: true, expectedRevision: 1 })
      .expect(409);

    expect(response.body.error).toMatchObject({
      code: 'extension_capability_review_required',
      retryable: false,
    });
    expect(response.body.error.message).toContain('capabilities require review');
  });

  it('serves managed entrypoint bytes only through an authenticated POST', async () => {
    const entrypoint = {
      artifactIntegrity: `sha256-${'a'.repeat(64)}`,
      entrypointId: 'main',
      module: {
        artifactIntegrity: `sha256-${'a'.repeat(64)}`,
        bytesBase64: 'bW9kdWxlLmV4cG9ydHM9e307',
        contentType: 'text/javascript',
        integrity: `sha256-${'b'.repeat(64)}`,
        path: 'runtime/surface/main/module.cjs',
      },
      styles: [],
    };
    const extensionPackages = { readManagedEntrypoint: vi.fn(async () => entrypoint) };
    const app = createApp({ snapshot: vi.fn(async () => snapshot()) }, extensionPackages);
    const path = '/api/varin/extensions/v1/entrypoints/read';
    await request(app).post(path).send({}).expect(401);
    const response = await request(app).post(path).set('x-test-session', 'yes').send({}).expect(200);
    expect(response.body).toEqual(entrypoint);
  });

  it('forwards explicit removal data choices and keeps legacy requests as retain', async () => {
    const extensionRuntime = { removeExtension: vi.fn(async () => snapshot(false, 2)) };
    const app = createApp({ snapshot: vi.fn(async () => snapshot()) }, {}, extensionRuntime);
    const path = '/api/varin/extensions/v1/extensions/dev.example.extension';
    await request(app)
      .delete(path)
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 1 })
      .expect(200);
    expect(extensionRuntime.removeExtension).toHaveBeenLastCalledWith({
      deleteData: false,
      expectedRevision: 1,
      extensionId: 'dev.example.extension',
    });
    await request(app)
      .delete(path)
      .set('x-test-session', 'yes')
      .send({ deleteData: true, expectedRevision: 1 })
      .expect(200);
    expect(extensionRuntime.removeExtension).toHaveBeenLastCalledWith({
      deleteData: true,
      expectedRevision: 1,
      extensionId: 'dev.example.extension',
    });
  });

  it('coordinates Host state, candidate preparation, and service invocation through authenticated routes', async () => {
    const state: VarinExtensionHostStateSnapshot = {
      catalog: snapshot(),
      revision: 4,
      routing: {
        authoritative: true,
        diagnostics: [],
        document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
        hostId: snapshot().hostId,
        storageState: 'missing',
      },
      services: { hostId: snapshot().hostId, providers: [], revision: 2 },
      workbench: {
        authoritative: true,
        diagnostics: [],
        document: {
          activeProfileId: 'default', layouts: [], profileSelections: { users: {} },
          profiles: [{ id: 'default', label: 'Default' }], revision: 0, schemaVersion: 1,
          updatedAt: '1970-01-01T00:00:00.000Z',
        },
        hostId: snapshot().hostId,
        storageState: 'missing',
      },
    };
    const extensionRuntime = {
      state: vi.fn(async () => state),
      waitForState: vi.fn(async () => state),
      prepareCandidate: vi.fn(async (extensionId, integrity) => ({ extensionId, integrity, providers: [] })),
      requestCandidateApplication: vi.fn(async () => snapshot()),
      discardCandidate: vi.fn(async () => snapshot()),
      reviewCapabilities: vi.fn(async () => snapshot()),
      reviewCandidateCapabilities: vi.fn(async () => snapshot()),
      invokeService: vi.fn(async () => 'service-result'),
      reloadLocalSource: vi.fn(async () => ({ outcome: 'unchanged' as const, snapshot: snapshot() })),
      removeExtension: vi.fn(async () => snapshot()),
      upsertServiceRoutingRule: vi.fn(async () => state.routing),
      removeServiceRoutingRule: vi.fn(async () => state.routing),
      applyWorkbenchProfile: vi.fn(async () => snapshot()),
      updateWorkbenchLayout: vi.fn(async () => state.workbench),
    };
    const app = createApp({ snapshot: vi.fn(async () => snapshot()) }, {}, extensionRuntime);
    expect((await request(app).get('/api/varin/extensions/v1/host-state').expect(200)).body).toEqual(state);
    await request(app).post('/api/varin/extensions/v1/candidates/prepare').send({}).expect(401);
    const prepared = await request(app)
      .post('/api/varin/extensions/v1/candidates/prepare')
      .set('x-test-session', 'yes')
      .send({ extensionId: 'dev.example.extension', candidateIntegrity: `sha256-${'a'.repeat(64)}` })
      .expect(200);
    expect(prepared.body.providers).toEqual([]);
    const requested = await request(app)
      .post('/api/varin/extensions/v1/candidates/request-application')
      .set('x-test-session', 'yes')
      .send({
        candidateIntegrity: `sha256-${'a'.repeat(64)}`,
        expectedRevision: 1,
        extensionId: 'dev.example.extension',
      })
      .expect(200);
    expect(requested.body.snapshot.revision).toBe(1);
    await request(app).post('/api/varin/extensions/v1/candidates/review-capabilities').send({}).expect(401);
    const reviewed = await request(app)
      .post('/api/varin/extensions/v1/candidates/review-capabilities')
      .set('x-test-session', 'yes')
      .send({
        candidateIntegrity: `sha256-${'a'.repeat(64)}`,
        decisions: [{ capability: 'workspace.files', granted: false, realm: 'host' }],
        expectedRevision: 1,
        extensionId: 'dev.example.extension',
      })
      .expect(200);
    expect(reviewed.body.snapshot.revision).toBe(1);
    await request(app)
      .post('/api/varin/extensions/v1/extensions/dev.example.extension/reload-local-source')
      .send({ expectedRevision: 1 })
      .expect(401);
    const reloaded = await request(app)
      .post('/api/varin/extensions/v1/extensions/dev.example.extension/reload-local-source')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 1, source: { kind: 'local', specifier: 'must-not-be-forwarded' } })
      .expect(200);
    expect(reloaded.body.outcome).toBe('unchanged');
    expect(extensionRuntime.reloadLocalSource).toHaveBeenCalledWith({
      expectedRevision: 1,
      extensionId: 'dev.example.extension',
    }, expect.any(AbortSignal));
    const selectedReview = await request(app)
      .post('/api/varin/extensions/v1/review-capabilities')
      .set('x-test-session', 'yes')
      .send({
        decisions: [{ capability: 'workspace.files', granted: false, realm: 'host' }],
        expectedRevision: 1,
        extensionId: 'dev.example.extension',
      })
      .expect(200);
    expect(selectedReview.body.snapshot.revision).toBe(1);
    const invoked = await request(app)
      .post('/api/varin/extensions/v1/services/invoke')
      .set('x-test-session', 'yes')
      .send({ serviceId: 'dev.example.service', version: 1, method: 'read', args: [] })
      .expect(200);
    expect(invoked.body.result).toBe('service-result');
    await request(app).put('/api/varin/extensions/v1/services/routing').send({}).expect(401);
    const routed = await request(app)
      .put('/api/varin/extensions/v1/services/routing')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, rule: {} })
      .expect(200);
    expect(routed.body.document.rules).toEqual([]);
    await request(app)
      .post('/api/varin/extensions/v1/services/routing/remove')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, scope: {}, serviceId: 'dev.example.service', version: 1 })
      .expect(200);
    await request(app).delete('/api/varin/extensions/v1/extensions/dev.example.extension').send({}).expect(401);
    await request(app)
      .delete('/api/varin/extensions/v1/extensions/dev.example.extension')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 1 })
      .expect(200);
    await request(app)
      .post('/api/varin/extensions/v1/workbench/profiles/apply')
      .set('x-test-session', 'yes')
      .send({ expectedCatalogRevision: 1, profileId: 'default' })
      .expect(200);
    await request(app).patch('/api/varin/extensions/v1/workbench/layout').send({}).expect(401);
    const workbench = await request(app)
      .patch('/api/varin/extensions/v1/workbench/layout')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, layer: {} })
      .expect(200);
    expect(workbench.body.document.activeProfileId).toBe('default');
  });
});
