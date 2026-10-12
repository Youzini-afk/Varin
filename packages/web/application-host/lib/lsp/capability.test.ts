import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageCapabilityHandler, createWorkspaceSearchCapabilityHandler } from './capability.js';
import { createWorkspaceContentSearch } from '../search/content.js';
import { createLanguageSupervisor } from './supervisor.js';
import { registerLanguageRoutes } from './routes.js';

const resultRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object result');
  return value as Record<string, unknown>;
};

describe('workspace language capability', () => {
  it('exposes status and rejects unknown methods without an HTTP provider registry', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn: () => {
        throw new Error('language capability tests must not spawn');
      },
      isTrusted: async () => false,
    });
    try {
      const call = createLanguageCapabilityHandler(language);
      const status = await call('getStatus', {
        workspaceId: harness.identity.workspaceId,
        languageId: 'typescript',
      });
      expect(resultRecord(status).status).toBe('absent');
      await expect(call('watch', {})).rejects.toThrow(/does not implement watch/);

      const ownerA = { extensionId: 'dev.example.a', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'lsp-provider-a-fixture', generation: 1 };
      const ownerB = { extensionId: 'dev.example.b', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'lsp-provider-b-fixture', generation: 1 };
      await call('registerProvider', {
        providerId: 'shared',
        command: 'server-a',
        languageIds: ['typescript'],
        source: 'builtin',
      }, { owner: ownerA });
      await expect(call('registerProvider', {
        providerId: 'shared',
        command: 'server-b',
        languageIds: ['typescript'],
      }, { owner: ownerB })).rejects.toThrow(/already owned/);
      expect(await call('unregisterProvider', { providerId: 'shared' }, { owner: ownerB }))
        .toMatchObject({ status: 'not-owned' });
      expect(await call('unregisterProvider', { providerId: 'shared' }, { owner: ownerA }))
        .toMatchObject({ status: 'unregistered' });

      const app = express();
      app.use(express.json());
      registerLanguageRoutes(app, { language });
      const missing = await request(app)
        .post('/api/language/providers')
        .send({ command: 'evil' });
      expect(missing.status).toBeGreaterThanOrEqual(400);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });
});

describe('workspace search capability', () => {
  it('forwards content search and rejects unknown methods', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const search = createWorkspaceContentSearch({
        documents: harness.authority,
        compute: { directory: async () => { throw new Error('native compute unavailable'); } },
        pathModule: await import('node:path').then((module) => module.default),
      });
      const call = createWorkspaceSearchCapabilityHandler(search);
      const result = await call('searchContent', {
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      });
      expect(resultRecord(result).status).toBe('failure');
      await expect(call('spawn', {})).rejects.toThrow(/does not implement spawn/);
    } finally {
      await harness.cleanup();
    }
  });
});
