import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import request from 'supertest';
import { registerExternalAccessRoutes } from './routes.js';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { VarinRequestAuthContext } from '../client-auth/request-context.js';

let tempDir = '';
let deploymentRoot = '';
let dataDir = '';

const createApp = ({ auth, documents, activeWorkspace }: {
  activeWorkspace?: string;
  auth?: VarinRequestAuthContext;
  documents?: DocumentAuthority;
} = {}) => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    req.varinAuth = auth || {
      type: 'client',
      clientId: 'client-1',
      client: {
        id: 'client-1',
        label: 'External agent',
        profile: 'full-control',
        capabilities: [
          'instance:read',
          'filesystem:read',
          'filesystem:write',
          'filesystem:delete',
          'terminal:use',
        ],
      },
    };
    next();
  });
  registerExternalAccessRoutes(app, {
    fsPromises: fs.promises,
    path,
    process,
    spawn,
    buildAugmentedPath: () => process.env.PATH || '',
    varinDataDir: dataDir,
    varinVersion: '1.0.0-test',
    runtimeName: 'test',
    serverStartedAt: '2026-01-01T00:00:00.000Z',
    remoteClientAuthRuntime: {
      listAuditEvents: vi.fn(async () => []),
    },
    resolveProjectDirectory: vi.fn(async () => ({ directory: activeWorkspace || path.join(deploymentRoot, 'workspace'), error: null })),
    __dirname: path.join(deploymentRoot, 'packages', 'web', 'server'),
    deploymentRoot,
    ...(documents ? { documents } : {}),
  });
  return app;
};

describe('external access routes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-external-routes-'));
    deploymentRoot = path.join(tempDir, 'deployment');
    dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(path.join(deploymentRoot, 'packages', 'web', 'server'), { recursive: true });
    fs.mkdirSync(path.join(deploymentRoot, 'workspace'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(deploymentRoot, 'package.json'), '{"name":"varin-test"}');
    fs.writeFileSync(path.join(deploymentRoot, 'packages', 'web', 'package.json'), '{"name":"@varin/web"}');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
    deploymentRoot = '';
    dataDir = '';
  });

  it('lists roots and reads/writes files in the deployment root for full-control clients', async () => {
    const app = createApp();

    const roots = await request(app).get('/api/external/roots').expect(200);
    expect(roots.body.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deployment', path: deploymentRoot, exists: true }),
      expect.objectContaining({ id: 'workspace', path: path.join(deploymentRoot, 'workspace'), exists: true }),
    ]));

    const written = await request(app)
      .put('/api/external/fs/write')
      .send({ root: 'deployment', path: 'packages/web/NOTE.txt', content: 'hello external' })
      .expect(200);
    expect(written.body).toMatchObject({ success: true, root: 'deployment', path: 'packages/web/NOTE.txt' });

    const read = await request(app)
      .get('/api/external/fs/read')
      .query({ root: 'deployment', path: 'packages/web/NOTE.txt' })
      .expect(200);
    expect(read.body.content).toBe('hello external');

    const listed = await request(app)
      .get('/api/external/fs/list')
      .query({ root: 'deployment', path: 'packages/web' })
      .expect(200);
    expect(listed.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'NOTE.txt', type: 'file' }),
    ]));
  });

  it('denies deployment filesystem access to ordinary client tokens', async () => {
    const app = createApp({
      auth: {
        type: 'client',
        clientId: 'client-2',
        client: {
          id: 'client-2',
          label: 'Regular remote client',
          profile: 'client',
          capabilities: ['ui:access'],
        },
      },
    });

    await request(app).get('/api/external/roots').expect(403);
    await request(app)
      .put('/api/external/fs/write')
      .send({ root: 'deployment', path: 'x.txt', content: 'nope' })
      .expect(403);
  });

  it('runs bounded commands in the selected external root', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/api/external/command')
      .send({
        root: 'deployment',
        cwd: '.',
        command: 'echo external-ok',
        timeoutMs: 10_000,
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stdout).toContain('external-ok');
    expect(response.body.absoluteCwd).toBe(await fs.promises.realpath(deploymentRoot));
  });

  it('records active-workspace external writes and refuses them during maintenance', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const app = createApp({
        documents: harness.authority,
        activeWorkspace: harness.workspaceRoot,
      });
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);

      await request(app)
        .put('/api/external/fs/write')
        .send({ root: 'workspace', path: 'tracked.txt', content: 'tracked' })
        .expect(200);
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      await request(app)
        .put('/api/external/fs/write')
        .send({ root: 'workspace', path: 'late.txt', content: 'late' })
        .expect(409);
      expect(fs.existsSync(path.join(harness.workspaceRoot, 'late.txt'))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
