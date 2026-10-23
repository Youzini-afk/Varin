import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernelClient } from '../../kernel/kernel-client.js';
import { createSemanticInference } from '../semantic/runtime-inference.js';
import { createLocalSemanticEmbedder } from '../semantic/local-embedder.js';
import { localComponentFixture } from '../semantic/fixtures/local-component.test-helper.js';
import { createKnowledgeEmbeddingOwner } from './embedding-owner.js';

it('embeds knowledge through the real local Worker and Catalog, then reuses the original receipt after owner replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-local-knowledge-'));
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
  const buildVersion = (JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
  const kernel = createKernelClient({ hostId: 'local-knowledge', storageRoot: path.join(root, 'kernel'), kernelPath, buildVersion, allowCargoDevRunner: false });
  let selected = true;
  const inference = createSemanticInference({
    readGlobalInferenceSettings: async () => ({ harness: { ...(selected ? { embedding: { protocol: 'local', providerId: 'local', modelId: 'installed' } } : {}) } }),
    resolveEmbeddingBinding: async () => { throw new Error('Local knowledge must never resolve an HTTP provider'); },
  }, undefined, { requests: { kernel, runtime: { onEvent: () => () => {}, onReady: () => () => {}, onExit: () => () => {} } as never,
    egress: { prepare: async () => { throw new Error('Local knowledge must never dispatch HTTP'); } } as never } });
  const component = await localComponentFixture(path.join(root, 'component'));
  const encoder = createLocalSemanticEmbedder({ dataDir: root, pack: component.pack });
  let activeEncoder = encoder;
  let owner = createKnowledgeEmbeddingOwner(kernel, inference, { resolve: () => activeEncoder, close: async () => {} });
  try {
    await kernel.start();
    const first = await owner.resolve('workspace', 'bot:memory');
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') throw new Error('Local knowledge is unavailable');
    await first.embedder.prepare();
    expect(await first.embedder.embed(['MAGENTA memory'], { purpose: 'document' })).toEqual([[1, 0]]);
    expect(await component.calls()).toHaveLength(1);
    await owner.close();
    owner = createKnowledgeEmbeddingOwner(kernel, inference, { resolve: () => activeEncoder, close: async () => {} });
    const restored = await owner.resolve('workspace', 'bot:memory');
    if (restored.status !== 'ready') throw new Error('Local knowledge is unavailable');
    expect(await restored.embedder.embed(['MAGENTA memory'], { purpose: 'document' })).toEqual([[1, 0]]);
    expect(await component.calls()).toHaveLength(1);
    const inFlight = restored.embedder.embed(['HOLD_FORWARD old generation']).then(() => null, error => error);
    await vi.waitFor(async () => expect(await readFile(path.join(component.model, 'started'), 'utf8')).toBe('yes'));
    const replacement = await localComponentFixture(path.join(root, 'replacement'), { revision: 'replacement' });
    activeEncoder = createLocalSemanticEmbedder({ dataDir: root, pack: replacement.pack });
    let retired = false;
    const retirement = Promise.all([owner.retireLocal(encoder), encoder.retire!()]).then(() => { retired = true; });
    expect(retired).toBe(false);
    await component.release();
    expect((await inFlight).message).toContain('component changed');
    await retirement;
    const current = await owner.resolve('workspace', 'bot:memory');
    if (current.status !== 'ready') throw new Error('Replacement local knowledge is unavailable');
    expect(await current.embedder.embed(['replacement memory'])).toEqual([[0, 1]]);
    selected = false;
    await expect(current.embedder.embed(['another memory'], { purpose: 'document' })).rejects.toThrow('selection changed');
    expect((await owner.resolve('workspace', 'bot:memory')).status).toBe('unconfigured');
    expect(await component.calls()).toHaveLength(2);
  } finally {
    await component.release();
    await owner.close(); await inference.close(); await encoder.retire!(); await activeEncoder.retire!(); await kernel.close();
    await rm(root, { recursive: true, force: true });
  }
});
