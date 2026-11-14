import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createAgentPersonalization } from './agent-personalization.js';

it('retains notes and prompt edits across a kernel restart with the same Host owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-agent-personalization-'));
  if (!root.startsWith(path.join(tmpdir(), 'varin-agent-personalization-'))) throw new Error('Unexpected test directory');
  const repo = path.resolve(import.meta.dirname, '../../../../..');
  const buildVersion = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
  const options = { hostId: 'agent-memory-test', storageRoot: path.join(root, 'kernel'), buildVersion,
    kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false };
  let child!: ChildProcessWithoutNullStreams;
  const client = createKernelClient({ ...options, spawnProcess: ((command, args, input) => {
    child = spawn(command, args ?? [], input ?? {}) as ChildProcessWithoutNullStreams;
    return child;
  }) as typeof spawn });
  const context = async (threadId: string) => ({ bot: threadId === 'bot', projectId: threadId === 'other' ? 'project-b' : 'project-a' });
  try {
    await client.start();
    const service = createAgentPersonalization({ client, context });
    await service.saveNote({ scope: { kind: 'global' }, content: 'Use concise language.' });
    const project = await service.saveNote({ scope: { kind: 'project', id: 'project-a' }, content: 'The project uses PostgreSQL.' });
    const session = await service.saveNote({ scope: { kind: 'thread', id: 'chat' }, content: 'Implement only the reader this turn.' });
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

    const epoch = client.kernelEpoch;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await client.start();
    expect(client.kernelEpoch).not.toBe(epoch);
    // The Host and personalization owner survive; only the native process restarts.
    const restored = await service.context('chat');
    expect(restored.profiles[0]?.profile.sections).toEqual({ preamble: 'User-owned system instructions.', rules: null });
    expect(restored.memories.find(note => note.id === project.result.id)?.content).toBe('The project uses SQLite.');
    await service.removeNote(project.result.id, (await service.catalog()).revision);
    expect((await service.context('chat')).memories.some(note => note.id === project.result.id)).toBe(false);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
