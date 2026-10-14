import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = () => createStaticRoutesRuntime({
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/' },
  process: { env: {} },
  __dirname: '/server',
  express,
  listRecentThreads: async () => [],
  readSettingsFromDisk: async () => ({}),
  normalizePwaAppName: (value: unknown) => typeof value === 'string' ? value : undefined,
  normalizePwaOrientation: (value: unknown) => typeof value === 'string' ? value : undefined,
});

const createStaticRuntime = (distPath: string) => createStaticRoutesRuntime({
  fs,
  path,
  process: { env: { VARIN_DIST_DIR: distPath } },
  __dirname: '/server',
  express,
  listRecentThreads: async () => [],
  readSettingsFromDisk: async () => ({}),
  normalizePwaAppName: (value: unknown) => typeof value === 'string' ? value : undefined,
  normalizePwaOrientation: (value: unknown) => typeof value === 'string' ? value : undefined,
});

describe('static routes runtime', () => {
  it('caches fingerprinted assets immutably while entry documents keep revalidating', async () => {
    const distPath = await mkdtemp(path.join(tmpdir(), 'varin-static-routes-'));
    try {
      await mkdir(path.join(distPath, 'assets'), { recursive: true });
      await Promise.all([
        writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Varin</title>'),
        writeFile(path.join(distPath, 'sw.js'), 'self.skipWaiting();'),
        writeFile(path.join(distPath, 'assets', 'main-AbCdEf12.js'), 'console.log("hashed");'),
        writeFile(path.join(distPath, 'assets', 'runtime.js'), 'console.log("unversioned");'),
      ]);
      const app = express();
      createStaticRuntime(distPath).registerStaticRoutes(app);

      const hashed = await request(app).get('/assets/main-AbCdEf12.js');
      const unversioned = await request(app).get('/assets/runtime.js');
      const index = await request(app).get('/index.html');
      const navigation = await request(app).get('/workspaces/example');
      const serviceWorker = await request(app).get('/sw.js');

      expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(unversioned.headers['cache-control']).toBe('public, max-age=0');
      expect(index.headers['cache-control']).toBe('no-cache');
      expect(navigation.headers['cache-control']).toBe('no-cache');
      expect(serviceWorker.headers['cache-control']).toBe('no-store');
    } finally {
      await rm(distPath, { force: true, recursive: true });
    }
  });

  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Varin is running in headless mode');
    expect(response.text).toContain('Open it from the Varin desktop or mobile app');
    expect(response.text).toContain('varin connect-url --help');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'Varin is running in API-only mode',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'Varin is running in API-only mode' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'Varin is running in API-only mode' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'Varin is running in API-only mode' });
  });
});
