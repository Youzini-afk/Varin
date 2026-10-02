import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import { openKnowledgeStoreEngine } from '../knowledge/store-engine.js';
import type { KnowledgeStore } from '../knowledge/store-contract.js';
import { createMemoryService, type MemoryOwner } from './memory-service.js';
import { registerSelectionMemoryRoutes } from './selection-memory-routes.js';

describe('selected memory preview and commit', () => {
  let root: string;
  let store: KnowledgeStore;
  let userStore: KnowledgeStore;
  let owner: MemoryOwner;
  let entries: PiSessionEntry[];
  const original = 'Prefer **concise** updates. Use pnpm for this project.';
  const narrate = vi.fn();
  let app: express.Express;
  const base = '/api/harness/sessions/session-1/knowledge/extracted';
  const sources = [{ entryId: 'user-1', start: 0, text: 'Prefer **concise** updates.' }];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'varin-selected-memory-'));
    store = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'test', workspaceId: 'workspace', scope: 'workspace', embedding: null });
    userStore = await openKnowledgeStoreEngine({ dataDir: root, hostId: 'test', workspaceId: 'user', scope: 'user', embedding: null });
    owner = { scope: 'workspace', ownerId: 'workspace' };
    entries = [{ id: 'user-1', type: 'message', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: original } }];
    const memory = createMemoryService({
      storeForScopeId: async () => store, userStore: async () => userStore,
      ownerForSession: async () => owner, readSessionEntries: async () => entries,
    });
    narrate.mockReset().mockResolvedValue(JSON.stringify({ memories: [{
      content: 'Prefers concise updates.', trigger: 'Progress reporting', nature: 'preference', source: 's0', quote: sources[0]!.text,
    }] }));
    app = express(); app.use(express.json());
    registerSelectionMemoryRoutes(app, { memory, entries: async () => entries, narrate,
      requireAuth: (req, res, next) => req.header('x-test-auth') === 'yes' ? next() : res.sendStatus(401) });
  });
  afterEach(async () => {
    await store.close(); await userStore.close();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected test directory');
    await rm(root, { recursive: true, force: true });
  });
  const preview = () => request(app).post(`${base}/preview`).set('x-test-auth', 'yes').send({ sources });

  it('previews without writing, then saves editable memory with exact provenance and supports undo', async () => {
    await request(app).post(`${base}/preview`).send({ sources }).expect(401);
    const { body } = await preview().expect(200);
    expect(await store.listKnowledge({})).toHaveLength(0);
    expect(narrate.mock.calls[0]![2]).not.toContain('pnpm');
    const draft = { ...body.drafts[0], content: 'Give short, concrete progress updates.' };
    const saved = await request(app).post(base).set('x-test-auth', 'yes')
      .send({ expectedOwner: body.owner, target: 'owner', draft }).expect(201);
    expect(saved.body.item).toMatchObject({ content: draft.content, status: 'accepted', source: {
      kind: 'user-extracted', sessionId: 'session-1', spans: [{ id: 'user-1', start: 0, end: sources[0]!.text.length }],
    } });
    const duplicate = await request(app).post(base).set('x-test-auth', 'yes')
      .send({ expectedOwner: body.owner, target: 'owner', draft }).expect(200);
    expect(duplicate.body.created).toBe(false);
    await request(app).delete(`${base}/${saved.body.item.id}`).set('x-test-auth', 'yes').send({
      expectedOwner: body.owner, target: 'owner', expected: { content: draft.content, trigger: draft.trigger, status: 'accepted', invalidAt: null },
    }).expect(200);
    expect(await store.listKnowledge({ activeOnly: true })).toHaveLength(0);
  });

  it('rejects changed source/owner and does not mistake malformed extraction for an empty result', async () => {
    const { body } = await preview().expect(200);
    entries = [];
    await request(app).post(base).set('x-test-auth', 'yes').send({ expectedOwner: body.owner, target: 'user', draft: body.drafts[0] }).expect(409);
    owner = { scope: 'workspace', ownerId: 'different' };
    await request(app).post(base).set('x-test-auth', 'yes').send({ expectedOwner: body.owner, target: 'owner', draft: body.drafts[0] }).expect(409);
    expect(await userStore.listKnowledge({})).toHaveLength(0);
    entries = [{ id: 'user-1', type: 'message', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: original } }];
    narrate.mockResolvedValue('not JSON');
    await preview().expect(500);
    narrate.mockResolvedValue('{"memories":[]}');
    await preview().expect(200).expect(({ body }) => expect(body.drafts).toEqual([]));
  });

  it('rejects fabricated source text and citations, and honors the explicitly selected personal destination', async () => {
    await request(app).post(`${base}/preview`).set('x-test-auth', 'yes').send({ sources: [{ ...sources[0], text: 'fabricated' }] }).expect(409);
    expect(narrate).not.toHaveBeenCalled();
    narrate.mockResolvedValueOnce(JSON.stringify({ memories: [{ content: 'Use pnpm.', trigger: '', nature: 'decision', source: 's0', quote: 'pnpm' }] }));
    await preview().expect(500);
    const { body } = await preview().expect(200);
    await request(app).post(base).set('x-test-auth', 'yes').send({ expectedOwner: body.owner, target: 'user', draft: body.drafts[0] }).expect(201);
    expect(await store.listKnowledge({})).toHaveLength(0);
    expect(await userStore.listKnowledge({ scope: 'user', activeOnly: true })).toHaveLength(1);
  });
});
