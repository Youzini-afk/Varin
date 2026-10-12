import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCredentialAuthority } from '@varin/pi-host/credentials';
import { createSemanticInference } from './runtime-inference.js';

it('keeps an accepted rerank candidate until actual settings Off permanently revokes that lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-rerank-selection-'));
  const settings = join(directory, 'settings.json');
  const selected = { protocol: 'http-rerank', providerId: 'ranking', modelId: 'rank', endpoint: '/original' };
  const save = (rerank: unknown) => writeFile(settings, JSON.stringify({ harness: { ...(rerank === undefined ? {} : { rerank }) } }));
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { ranking: {
    baseUrl: 'https://ranking.invalid/v1', apiKey: 'fake-rerank-test-only',
    capabilities: { rerank: { protocol: 'http-rerank', models: [{ id: 'rank' }] } },
  } } }));
  await save(selected);
  const authority = HostCredentialAuthority.open(directory);
  const forbiddenRequest = vi.fn(async () => { throw new Error('Revoked lease must never enter Catalog or HTTP'); });
  const inference = createSemanticInference(authority, undefined, { requests: {
    kernel: { agentRuntimeRequest: forbiddenRequest },
    runtime: { onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {} },
    egress: { prepare: forbiddenRequest },
  } });
  try {
    const original = await inference.captureRerank();
    expect(original.status).toBe('ready');
    if (original.status !== 'ready') throw new Error('Original rerank connection was unavailable');
    await save({ ...selected, endpoint: '/next' });
    await original.lease.assertAvailable();
    expect(original.lease.binding.endpoint).toBe('/original');
    const next = await inference.captureRerank();
    expect(next.status).toBe('ready');
    if (next.status !== 'ready') throw new Error('Next rerank connection was unavailable');
    expect(next.lease.binding.endpoint).toBe('/next');
    await save({ protocol: 'not-a-rerank-protocol' });
    await original.lease.assertAvailable();
    expect((await inference.captureRerank()).status).toBe('invalid');
    await save(undefined);
    await expect(original.lease.assertAvailable()).rejects.toThrow('explicitly disabled');
    expect((await inference.captureRerank()).status).toBe('unconfigured');
    await save(selected);
    const resumed = await inference.captureRerank();
    expect(resumed.status).toBe('ready');
    if (resumed.status !== 'ready') throw new Error('New explicit rerank selection was unavailable');
    await resumed.lease.assertAvailable();
    const invocation = { operationId: 'never-admitted-query', executorOwner: { kind: 'external' as const, identity: 'test', epoch: 'original' } };
    const input = { query: 'rank authorized candidates', documents: [{ id: 'a', text: 'candidate' }] };
    for (const lease of [original.lease, next.lease]) {
      await expect(lease.execute(invocation, input, new AbortController().signal)).rejects.toThrow('explicitly disabled');
      lease.release();
    }
    expect(forbiddenRequest).not.toHaveBeenCalled();
    resumed.lease.release();
  } finally {
    await inference.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
