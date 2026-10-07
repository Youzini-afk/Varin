import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createAgentPersonalization } from './agent-personalization.js';
import { withAgentMemory } from '../harness/agent-memory-services.js';
import type { HarnessServiceContext } from '../harness/router.js';
import express from 'express';
import request from 'supertest';
import { registerSelectionMemoryRoutes } from './selection-memory-routes.js';

it('persists scoped assistant notes and prompt edits, isolates Bots, and rejects stale edits after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-agent-personalization-'));
  if (!root.startsWith(path.join(tmpdir(), 'varin-agent-personalization-'))) throw new Error('Unexpected test directory');
  const repo = path.resolve(import.meta.dirname, '../../../../..');
  const buildVersion = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
  const options = { hostId: 'agent-memory-test', storageRoot: path.join(root, 'kernel'), buildVersion,
    kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false };
  let client = createKernelClient(options);
  const context = async (sessionId: string) => ({ bot: sessionId === 'bot', projectId: sessionId === 'other' ? 'project-b' : 'project-a' });
  try {
    await client.start();
    let service = createAgentPersonalization({ client, context });
    await service.saveNote({ scope: { kind: 'global' }, content: 'Use concise language.' });
    const project = await service.saveNote({ scope: { kind: 'project', id: 'project-a' }, content: 'The project uses PostgreSQL.' });
    const session = await service.saveNote({ scope: { kind: 'session', id: 'chat' }, content: 'Implement only the reader this turn.' });
    expect((await service.context('chat')).memories).toHaveLength(3);
    expect((await service.context('other')).memories.map(note => note.content)).toEqual(['Use concise language.']);
    expect((await service.context('bot'))).toMatchObject({ mode: 'bot', memories: [], profiles: [] });
    const stale = (await service.catalog()).revision;
    await service.saveNote({ id: project.result.id, scope: project.result.scope, content: 'The project uses SQLite.', revision: stale });
    await expect(service.saveNote({ id: project.result.id, scope: project.result.scope, content: 'Stale overwrite', revision: stale }))
      .rejects.toMatchObject({ status: 409 });
    await service.saveNote({ id: session.result.id, scope: { kind: 'project', id: 'project-a' }, content: session.result.content });
    expect((await service.context('another-project-a-chat')).memories).toHaveLength(3);
    await service.savePrompt({ kind: 'global' }, { sections: { preamble: 'User-owned system instructions.', rules: null } }, (await service.catalog()).revision);

    // The same worker-facing memory method routes ordinary writes to these notes.
    const remember = withAgentMemory({ agentPersonalization: service } as never, 'memory.remember', {
      handle: async () => { throw new Error('Bot storage must not be used by the ordinary assistant'); },
    });
    const receipt = await remember.handle({ content: 'Explicit global note', scope: 'user' }, { sessionId: 'chat' } as HarnessServiceContext);
    expect(receipt.item?.scope).toBe('user');
    expect(receipt.agentMemoryMutation).toEqual({ revision: (await service.catalog()).revision,
      changes: [{ id: receipt.item!.id, note: (await service.context('chat')).memories.find(note => note.id === receipt.item!.id) }] });
    expect((await service.context('other')).memories.map(note => note.content)).toContain('Explicit global note');
    const correct = withAgentMemory({ agentPersonalization: service } as never, 'memory.correct', { handle: async () => { throw new Error('Wrong owner'); } });
    const corrected = await correct.handle({ id: receipt.item!.id, content: 'Corrected global note' }, { sessionId: 'chat' } as HarnessServiceContext);
    expect(corrected.agentMemoryMutation).toEqual({ revision: (await service.catalog()).revision,
      changes: [{ id: receipt.item!.id, note: (await service.context('chat')).memories.find(note => note.id === receipt.item!.id) }] });
    const forget = withAgentMemory({ agentPersonalization: service } as never, 'memory.forget', { handle: async () => { throw new Error('Wrong owner'); } });
    const forgotten = await forget.handle({ id: receipt.item!.id }, { sessionId: 'chat' } as HarnessServiceContext);
    expect(forgotten.agentMemoryMutation).toEqual({ revision: (await service.catalog()).revision,
      changes: [{ id: receipt.item!.id, note: null }] });
    expect((await service.context('chat')).memories.some(note => note.id === receipt.item!.id)).toBe(false);

    const app = express(); app.use(express.json());
    registerSelectionMemoryRoutes(app, { agentPersonalization: service, memory: {} as never,
      entries: async () => [{ id: 'user-1', type: 'message', parentId: null, timestamp: 'now',
        message: { role: 'user', timestamp: 1, content: 'Use SQLite.' } }],
      narrate: async () => { throw new Error('Ordinary selections must not use the Bot organizer'); },
      requireAuth: (_req, _res, next) => next(),
    });
    const base = '/api/harness/sessions/chat/knowledge/extracted';
    const preview = await request(app).post(`${base}/preview`).send({ sources: [{ entryId: 'user-1', start: 0, text: 'Use SQLite.' }] }).expect(200);
    expect(preview.body.drafts[0].content).toBe('Use SQLite.');
    const selected = await request(app).post(base).send({ expectedOwner: preview.body.owner, target: 'owner', draft: preview.body.drafts[0] }).expect(201);
    const undo = { expectedOwner: preview.body.owner, target: 'owner', expected: { content: 'Use SQLite.', trigger: '', status: 'accepted', invalidAt: null } };
    await service.saveNote({ id: selected.body.item.id, scope: { kind: 'global' }, content: 'Use SQLite.' });
    await request(app).delete(`${base}/${selected.body.item.id}`).send(undo).expect(409);
    await service.saveNote({ id: selected.body.item.id, scope: { kind: 'project', id: 'project-a' }, content: 'Use SQLite.' });
    await request(app).delete(`${base}/${selected.body.item.id}`).send(undo).expect(200);
    await client.close();
    client = createKernelClient(options); await client.start();
    service = createAgentPersonalization({ client, context });
    const restored = await service.context('chat');
    expect(restored.profiles[0]?.profile.sections).toEqual({ preamble: 'User-owned system instructions.', rules: null });
    expect(restored.memories.find(note => note.id === project.result.id)?.content).toBe('The project uses SQLite.');
    await service.removeNote(project.result.id, (await service.catalog()).revision);
    expect((await service.context('chat')).memories.some(note => note.id === project.result.id)).toBe(false);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
