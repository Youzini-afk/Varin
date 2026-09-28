import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createSemanticIndexManagement, registerSemanticIndexRoutes } from './index-management.js';

describe('semantic index settings', () => {
  it('reports a malformed configuration and allows a revisioned repair', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'varin-index-repair-'));
    try {
      await writeFile(path.join(dataDir, 'semantic-index-settings.json'), '{bad json');
      const management = createSemanticIndexManagement(dataDir, 'host');
      const broken = await management.read();
      expect(broken.error).toBeTruthy();
      await management.save(broken.config, broken.revision);
      expect((await management.read()).error).toBeUndefined();
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });

  it('serves progress and revisioned settings through the authenticated Host route', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'varin-index-route-'));
    const management = createSemanticIndexManagement(dataDir, 'host');
    await management.load();
    const app = express();
    registerSemanticIndexRoutes(app, {
      management,
      runtime: { indexStatuses: () => [] } as never,
      requireAuth: (request, response, next) => {
        if (request.header('x-test-auth') !== 'yes') response.sendStatus(401);
        else next();
      },
    });
    const server = app.listen(0);
    try {
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/harness/semantic-index`;
      expect((await fetch(base)).status).toBe(401);
      const initial = await (await fetch(base, { headers: { 'x-test-auth': 'yes' } })).json() as { revision: string; bytes: number; roots: unknown[] };
      expect(initial.bytes).toBe(0);
      expect(initial.roots).toEqual([]);
      const response = await fetch(base, { method: 'PUT', headers: { 'x-test-auth': 'yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: initial.revision,
          config: { storageDirectory: path.join(dataDir, 'custom'), concurrentRequests: 2, requestIntervalMs: 10,
            indexedDirectories: [path.join(dataDir, 'project')] } }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json() as { restartRequired: boolean; revision: string };
      expect(saved.restartRequired).toBe(true);
      const removeResponse = await fetch(`${base}/cache`, { method: 'DELETE',
        headers: { 'x-test-auth': 'yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: management.activeDirectory(), revision: saved.revision }),
      });
      expect(removeResponse.status).toBe(400);
      expect(await removeResponse.json()).toEqual({ error: 'Directory is not an inactive retained index cache' });
      const updated = await (await fetch(base, { headers: { 'x-test-auth': 'yes' } })).json() as {
        config: { indexedDirectories: string[] }; retained: Array<{ directory: string; active: boolean }>;
      };
      expect(updated.config.indexedDirectories).toEqual([path.join(dataDir, 'project')]);
      expect(updated.retained).toEqual([{ directory: management.activeDirectory(), bytes: 0, active: true }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the active directory fixed until restart and rejects stale saves', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'varin-index-settings-'));
    try {
      const management = createSemanticIndexManagement(dataDir, 'host');
      const first = await management.read();
      await management.load();
      const activeDirectory = management.activeDirectory();
      await mkdir(activeDirectory, { recursive: true });
      await writeFile(path.join(activeDirectory, 'old-index.tdb.vec'), Buffer.alloc(7));
      const custom = path.join(dataDir, 'other-volume');
      const saved = await management.save({ storageDirectory: custom, concurrentRequests: 3, requestIntervalMs: 250 }, first.revision);
      expect(management.activeDirectory()).toBe(activeDirectory);
      expect(management.configuredDirectory(saved.config)).toContain(custom);
      expect((await management.read()).retainedDirectories).toEqual([activeDirectory]);
      await expect(management.removeRetained(activeDirectory, saved.revision)).rejects.toThrow('inactive');
      await expect(management.save({ storageDirectory: null }, first.revision)).rejects.toThrow('changed elsewhere');
      const afterRestart = createSemanticIndexManagement(dataDir, 'host');
      await afterRestart.load();
      expect(afterRestart.activeDirectory()).toBe(management.configuredDirectory(saved.config));
      await mkdir(afterRestart.activeDirectory(), { recursive: true });
      await writeFile(path.join(afterRestart.activeDirectory(), 'index.tdb.vec'), Buffer.alloc(13));
      expect(await afterRestart.directoryBytes(afterRestart.activeDirectory())).toBe(13);
      await afterRestart.removeRetained(activeDirectory, saved.revision);
      expect((await afterRestart.read()).retainedDirectories).toEqual([]);
      expect(await afterRestart.directoryBytes(activeDirectory)).toBe(0);
      await expect(afterRestart.save({ storageDirectory: 'relative', concurrentRequests: 1, requestIntervalMs: 0 }, saved.revision))
        .rejects.toThrow('absolute path');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
