import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createThreadRegistry } from '../harness/thread-registry.js';
import { resolveComputerActor } from './computer-actor.js';

it('derives actual root/worker/retrieval identity from Registry and rejects an ended child execution', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-computer-actor-'));
  const registry = createThreadRegistry({ dataDir, hostId: 'host' });
  try {
    const root = await registry.createThread({ scopeId: 'scope', parent: { kind: 'session', id: 'main' }, brief: 'Overall work', kind: 'discussion', purpose: 'agent-root',
      createdBy: 'user', concurrency: 4, autoRun: false, worktree: 'none', tools: ['computer'], permissions: {} });
    const rootRun = await registry.startRun('scope', root.id); await registry.markRunRunning('scope', root.id, rootRun.id, 'main');
    expect(await resolveComputerActor(registry, 'main')).toMatchObject({ rootSessionId: 'main', rootRunId: rootRun.id, readOnly: false });
    const worker = await registry.createThread({ scopeId: 'scope', parent: { kind: 'thread', id: root.id }, brief: 'Implement', kind: 'implementation', preset: 'worker',
      createdBy: 'agent', concurrency: 4, autoRun: false, worktree: 'none', tools: ['computer'], permissions: {} });
    const workerRun = await registry.startRun('scope', worker.id); await registry.markRunRunning('scope', worker.id, workerRun.id, 'worker');
    const retrieval = await registry.createThread({ scopeId: 'scope', parent: { kind: 'session', id: 'worker' }, brief: 'Inspect', kind: 'discussion', preset: 'retrieval',
      createdBy: 'agent', concurrency: 4, autoRun: false, worktree: 'none', tools: ['computer'], permissions: {} });
    const retrievalRun = await registry.startRun('scope', retrieval.id); await registry.markRunRunning('scope', retrieval.id, retrievalRun.id, 'lookup');
    expect(await resolveComputerActor(registry, 'lookup')).toMatchObject({ rootSessionId: 'main', rootRunId: rootRun.id, runId: retrievalRun.id, readOnly: true });
    await registry.endRun('scope', worker.id, workerRun.id, 'success');
    expect(await resolveComputerActor(registry, 'worker')).toBeNull();
    expect(await resolveComputerActor(registry, 'lookup')).toMatchObject({ rootSessionId: 'main', readOnly: true });
  } finally { await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});
